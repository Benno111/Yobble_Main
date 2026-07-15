import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { requireAuth } from "../auth.js";
import { get, run, all } from "../db.js";
import { moderateFields, ModerationSeverity } from "../ai-moderation.js";
import { scanUploadedImage } from "../image-moderation.js";

export const itemsRouter = express.Router();

/* -----------------------------
   Upload config
------------------------------ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024 // 2MB icon max
  }
});

function safeCode(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 64);
}

/* -----------------------------
   POST /api/items/upload
   User upload → pending
------------------------------ */
itemsRouter.post(
  "/upload",
  requireAuth,
  upload.single("icon"),
  async (req, res) => {
    try {
      const code = safeCode(req.body.code);
      const name = String(req.body.name || "").trim();
      const description = String(req.body.description || "").trim();
      const priceRaw = req.body.price ?? "0";
      const priceNum = Number(priceRaw);
      const price = Number.isFinite(priceNum) ? Math.floor(priceNum) : NaN;

      if (!code || !name) {
        return res.status(400).json({ ok: false, error: "missing_fields" });
      }
      if (!Number.isFinite(price) || price < 0) {
        return res.status(400).json({ ok: false, error: "invalid_price" });
      }

      // Prevent duplicate codes
      const exists = await get(
        "SELECT id FROM items WHERE code=?",
        [code]
      );
      if (exists) {
        return res.status(400).json({ ok: false, error: "code_exists" });
      }

      /* -----------------------------
         Save icon (optional)
      ------------------------------ */
      let iconPath = null;

      if (req.file) {
        const ext = path.extname(req.file.originalname || ".png").toLowerCase();
        if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
          return res.status(400).json({ ok: false, error: "bad_icon_type" });
        }
        const declaredMime = ext === ".webp" ? "image/webp" : ext === ".png" ? "image/png" : "image/jpeg";
        const imageScan = await scanUploadedImage({
          file: req.file,
          declaredMime,
          uploaderId: req.user.uid,
          context: `item icon upload; code=${code}; name=${name}; description=${description}`
        });
        if (imageScan.blocked) {
          return res.status(400).json({
            ok: false,
            error: "bad_image_blocked",
            reason: imageScan.reason || "content_policy_violation",
            punishment: imageScan.punishment || null
          });
        }

        const serverDir = path.resolve(process.cwd());
        const projectRoot = path.resolve(serverDir, "..");
        const dir = path.join(projectRoot, "save", "item_icons");
        fs.mkdirSync(dir, { recursive: true });

        const filename = `${code}${ext}`;
        const fullPath = path.join(dir, filename);
        fs.writeFileSync(fullPath, req.file.buffer);

        iconPath = `/save/item_icons/${filename}`;
      }

      /* -----------------------------
         AI content moderation
      ------------------------------ */
      let aiFlag = null;
      try {
        const aiResult = await moderateFields({ name, description });
        if (aiResult.severity === ModerationSeverity.HIGH) {
          return res.status(400).json({ ok: false, error: "content_policy_violation" });
        }
        aiFlag = aiResult.flagged ? aiResult.severity : null;
      } catch (aiErr) {
        console.error("[ai-moderation] item moderation failed:", aiErr?.message);
        // Fail open — do not block the upload when AI is unavailable.
      }

      /* -----------------------------
         Insert item (pending)
      ------------------------------ */
      await run(
        `INSERT INTO items
         (code, name, description, icon_path, price,
          approval_status, uploaded_by, created_at, ai_flag)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          code,
          name,
          description,
          iconPath,
          price,
          "pending",
          req.user.uid,
          Date.now(),
          aiFlag,
        ]
      );

      res.json({
        ok: true,
        status: "pending"
      });

    } catch (err) {
      console.error("Item upload failed:", err);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  }
);

/* -----------------------------
   GET /api/items
   Approved items only
------------------------------ */
itemsRouter.get("/", requireAuth, async (_req, res) => {
  const items = await all(
    `SELECT id, code, name, description, icon_path, price
     FROM items
     WHERE approval_status='approved'
     ORDER BY created_at DESC`
  );
  res.json({ items });
});
