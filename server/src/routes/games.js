import express from "express";
import path from "path";
import fs from "fs";
import { all, get } from "../db.js";

export const gamesRouter = express.Router();

const PROJECT_ROOT = path.resolve(process.cwd(), "server", "..");
const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "game_storage");

/* -----------------------------
   Helpers
----------------------------- */
function isValidSlug(v) {
  return /^[a-z0-9\-]+$/i.test(v);
}
function isValidVersion(v) {
  return /^[0-9a-zA-Z.\-_]+$/.test(v);
}

function listFilesRecursive(baseDir, sub = "") {
  const abs = path.join(baseDir, sub);
  let out = [];

  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "assets.json") continue;

    const rel = path.join(sub, e.name);
    const full = path.join(baseDir, rel);

    if (e.isDirectory()) {
      out.push(...listFilesRecursive(baseDir, rel));
    } else {
      const stat = fs.statSync(full);
      out.push({
        path: rel.replace(/\\/g, "/"),
        size: stat.size
      });
    }
  }
  return out;
}

/* -----------------------------
   GET /api/games
----------------------------- */
gamesRouter.get("/", async (_req, res) => {
  const rows = await all(
    "SELECT slug,title,description,category FROM games WHERE is_hidden=0"
  );
  res.json(rows);
});

/* -----------------------------
   GET /api/games/:slug
----------------------------- */
gamesRouter.get("/:slug", async (req, res) => {
  const { slug } = req.params;
  if (!isValidSlug(slug)) return res.sendStatus(400);

  const row = await get(
    "SELECT slug,title,description,category,is_hidden FROM games WHERE slug=?",
    [slug]
  );
  if (!row || row.is_hidden) return res.status(404).json({ error: "game_deleted" });
  res.json(row);
});

/* -----------------------------
   GET /api/games/:slug/versions
----------------------------- */
gamesRouter.get("/:slug/versions", async (req, res) => {
  const { slug } = req.params;
  if (!isValidSlug(slug)) return res.sendStatus(400);

  const game = await get("SELECT id, is_hidden FROM games WHERE slug=?", [slug]);
  if (!game || game.is_hidden) return res.status(404).json({ error: "game_deleted" });

  const rows = await all(
    `SELECT version, entry_html, is_published, approval_status
     FROM game_versions
     WHERE game_id=? AND approval_status='approved'
     ORDER BY created_at DESC`,
    [game.id]
  );

  if (rows.length) {
    return res.json({ versions: rows });
  }

  const dir = path.join(GAME_STORAGE_DIR, slug);
  if (!fs.existsSync(dir)) return res.json({ versions: [] });

  const versions = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(isValidVersion);

  res.json({ versions: versions.map(v => ({ version: v })) });
});

/* -----------------------------
   GET /api/games/:slug/:version/assets.json
----------------------------- */
gamesRouter.get("/:slug/:version/assets.json", async (req, res) => {
  const { slug, version } = req.params;
  if (!isValidSlug(slug) || !isValidVersion(version)) {
    return res.sendStatus(400);
  }

  const dir = path.join(GAME_STORAGE_DIR, slug, version);
  if (!fs.existsSync(dir)) return res.sendStatus(404);

  res.setHeader("Cache-Control", "public, max-age=60");
  const assets = listFilesRecursive(dir);
  const fileMap = {};
  for (const entry of assets) {
    fileMap[entry.path] = { size: entry.size };
  }
  res.json({ [version]: fileMap });
});
