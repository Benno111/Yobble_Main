import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { requireAuth } from "../auth.js";
import { get, run, all } from "../db.js";

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

      if (!code || !name) {
        return res.status(400).json({ ok: false, error: "missing_fields" });
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
         Insert item (pending)
      ------------------------------ */
      await run(
        `INSERT INTO items
         (code, name, description, icon_path,
          approval_status, uploaded_by, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [
          code,
          name,
          description,
          iconPath,
          "pending",
          req.user.uid,
          Date.now()
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
    `SELECT id, code, name, description, icon_path
     FROM items
     WHERE approval_status='approved'
     ORDER BY created_at DESC`
  );
  res.json({ items });
});
