import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { requireAuth, requireRole } from "../auth.js";
import { get, run } from "../db.js";

export const mediaRouter = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

function safeName(name){
  return String(name||"").toLowerCase().replace(/[^a-z0-9._-]+/g,"-").slice(0,80);
}

mediaRouter.post("/banner", requireAuth, requireRole("moderator"), upload.single("file"), async (req,res)=>{
  const slug = String(req.body?.slug || "").trim();
  if(!slug || !req.file) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id FROM games WHERE slug=?", [slug]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const SERVER_DIR = path.resolve(process.cwd());
  const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
  const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "game_storage");

  const mediaDir = path.join(GAME_STORAGE_DIR, slug, "media");
  fs.mkdirSync(mediaDir, { recursive:true });

  const ext = path.extname(req.file.originalname || ".png") || ".png";
  const filename = "banner" + ext;
  const out = path.join(mediaDir, filename);
  fs.writeFileSync(out, req.file.buffer);

  const url = `/games/${slug}/media/${filename}`;
  await run("UPDATE games SET banner_path=? WHERE id=?", [url, g.id]);

  res.json({ ok:true, url });
});

mediaRouter.post("/screenshot", requireAuth, requireRole("moderator"), upload.single("file"), async (req,res)=>{
  const slug = String(req.body?.slug || "").trim();
  if(!slug || !req.file) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, screenshots_json FROM games WHERE slug=?", [slug]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const SERVER_DIR = path.resolve(process.cwd());
  const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
  const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "game_storage");

  const mediaDir = path.join(GAME_STORAGE_DIR, slug, "media");
  fs.mkdirSync(mediaDir, { recursive:true });

  const ext = path.extname(req.file.originalname || ".png") || ".png";
  const filename = `${Date.now()}-${safeName(req.file.originalname)}${ext}`.replace(/\.png\.png$/,".png");
  const out = path.join(mediaDir, filename);
  fs.writeFileSync(out, req.file.buffer);

  const url = `/games/${slug}/media/${filename}`;
  let arr = [];
  try{ arr = JSON.parse(g.screenshots_json || "[]"); }catch{}
  if(!Array.isArray(arr)) arr = [];
  arr.unshift(url);
  arr = arr.slice(0, 12);
  await run("UPDATE games SET screenshots_json=? WHERE id=?", [JSON.stringify(arr), g.id]);

  res.json({ ok:true, url, screenshots: arr });
});
