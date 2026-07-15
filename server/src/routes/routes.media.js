import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { requireAuth, requireRole } from "../auth.js";
import { get, run } from "../db.js";
import { scanUploadedImage } from "../image-moderation.js";

export const mediaRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

function safeName(name){
  return String(name||"").toLowerCase().replace(/[^a-z0-9._-]+/g,"-").slice(0,80);
}

mediaRouter.post("/banner", requireAuth, requireRole("moderator"), upload.single("file"), async (req,res)=>{
  const project = String(req.body?.project || "").trim();
  if(!project || !req.file) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id FROM games WHERE project=?", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const ext = path.extname(req.file.originalname || ".png").toLowerCase();
  const declaredMime = ext === ".webp" ? "image/webp" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  const imageScan = await scanUploadedImage({
    file: req.file,
    declaredMime,
    uploaderId: req.user.uid,
    context: `game banner upload; project=${project}`
  });
  if (imageScan.blocked) {
    return res.status(400).json({
      error: "bad_image_blocked",
      reason: imageScan.reason || "content_policy_violation",
      punishment: imageScan.punishment || null
    });
  }

  const SERVER_DIR = path.resolve(process.cwd());
  const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
  const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "save", "uploads", "games");

  const mediaDir = path.join(GAME_STORAGE_DIR, project, "media");
  fs.mkdirSync(mediaDir, { recursive:true });

  const filename = "banner" + ext;
  const out = path.join(mediaDir, filename);
  fs.writeFileSync(out, req.file.buffer);

  const url = `/games/${project}/media/${filename}`;
  await run("UPDATE games SET banner_path=? WHERE id=?", [url, g.id]);

  res.json({ ok:true, url });
});

mediaRouter.post("/screenshot", requireAuth, requireRole("moderator"), upload.single("file"), async (req,res)=>{
  const project = String(req.body?.project || "").trim();
  if(!project || !req.file) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, screenshots_json FROM games WHERE project=?", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const ext = path.extname(req.file.originalname || ".png").toLowerCase();
  const declaredMime = ext === ".webp" ? "image/webp" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";
  const imageScan = await scanUploadedImage({
    file: req.file,
    declaredMime,
    uploaderId: req.user.uid,
    context: `game screenshot upload; project=${project}`
  });
  if (imageScan.blocked) {
    return res.status(400).json({
      error: "bad_image_blocked",
      reason: imageScan.reason || "content_policy_violation",
      punishment: imageScan.punishment || null
    });
  }

  const SERVER_DIR = path.resolve(process.cwd());
  const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
  const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "save", "uploads", "games");

  const mediaDir = path.join(GAME_STORAGE_DIR, project, "media");
  fs.mkdirSync(mediaDir, { recursive:true });

  const filename = `${Date.now()}-${safeName(req.file.originalname)}${ext}`.replace(/\.png\.png$/,".png");
  const out = path.join(mediaDir, filename);
  fs.writeFileSync(out, req.file.buffer);

  const url = `/games/${project}/media/${filename}`;
  let arr = [];
  try{ arr = JSON.parse(g.screenshots_json || "[]"); }catch{}
  if(!Array.isArray(arr)) arr = [];
  arr.unshift(url);
  arr = arr.slice(0, 12);
  await run("UPDATE games SET screenshots_json=? WHERE id=?", [JSON.stringify(arr), g.id]);

  res.json({ ok:true, url, screenshots: arr });
});
