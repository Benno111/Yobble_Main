import express from "express";
import path from "path";
import fs from "fs";
import { all, get } from "../db.js";
import { requireAuth } from "../auth.js";

export const gamesRouter = express.Router();

const PROJECT_ROOT = path.resolve(process.cwd(), "server", "..");
const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "game_storage");

/* -----------------------------
   Helpers
----------------------------- */
function isValidproject(v) {
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
gamesRouter.get("/", requireAuth, async (req, res) => {
  const games = await all(
    `SELECT g.id, g.project, g.title, g.description, g.category, g.banner_path, g.screenshots_json, g.is_featured,
            g.owner_user_id,
            u.username AS owner_username, pr.display_name AS owner_display_name,
            (SELECT v.version FROM game_versions v
             WHERE v.game_id=g.id AND v.is_published=1 AND v.approval_status='approved'
             ORDER BY v.created_at DESC LIMIT 1) AS latest_version,
            (SELECT v.entry_html FROM game_versions v
             WHERE v.game_id=g.id AND v.is_published=1 AND v.approval_status='approved'
             ORDER BY v.created_at DESC LIMIT 1) AS entry_html,
            (SELECT ROUND(AVG(r.rating),2) FROM game_reviews r WHERE r.game_id=g.id) AS avg_rating,
            (SELECT COUNT(*) FROM game_reviews r WHERE r.game_id=g.id) AS rating_count,
            (SELECT COUNT(*) FROM game_versions v
             WHERE v.game_id=g.id AND v.is_published=1 AND v.approval_status='approved') AS playable_count,
            (SELECT COUNT(*) FROM game_version_whitelist w
             WHERE w.game_id=g.id AND w.user_id=?) AS whitelisted_count
     FROM games g
     LEFT JOIN users u ON u.id = g.owner_user_id
     LEFT JOIN profiles pr ON pr.user_id = g.owner_user_id
     WHERE g.is_hidden=0
     ORDER BY g.title`,
    [req.user.uid]
  );

  const out = games.map(g => ({
    ...g,
    screenshots: (() => {
      try{
        const a = JSON.parse(g.screenshots_json || "[]");
        return Array.isArray(a) ? a : [];
      }catch{
        return [];
      }
    })()
  }));

  const filtered = out.filter(g =>
    (g.playable_count || 0) > 0 ||
    g.owner_user_id === req.user.uid ||
    (g.whitelisted_count || 0) > 0
  );
  res.json({ games: filtered });
});

/* -----------------------------
   GET /api/games/:project
----------------------------- */
gamesRouter.get("/:project", async (req, res) => {
  const { project } = req.params;
  if (!isValidproject(project)) return res.sendStatus(400);

  const g = await get(
    `SELECT g.id, g.project, g.title, g.description, g.category, g.banner_path, g.screenshots_json, g.is_featured, g.is_hidden,
            u.username AS owner_username, pr.display_name AS owner_display_name,
            (SELECT v.version FROM game_versions v
             WHERE v.game_id=g.id AND v.is_published=1 AND v.approval_status='approved'
             ORDER BY v.created_at DESC LIMIT 1) AS latest_version,
            (SELECT v.entry_html FROM game_versions v
             WHERE v.game_id=g.id AND v.is_published=1 AND v.approval_status='approved'
             ORDER BY v.created_at DESC LIMIT 1) AS entry_html,
            (SELECT ROUND(AVG(r.rating),2) FROM game_reviews r WHERE r.game_id=g.id) AS avg_rating,
            (SELECT COUNT(*) FROM game_reviews r WHERE r.game_id=g.id) AS rating_count
     FROM games g
     LEFT JOIN users u ON u.id = g.owner_user_id
     LEFT JOIN profiles pr ON pr.user_id = g.owner_user_id
     WHERE g.project=?`,
    [project]
  );
  if (!g || g.is_hidden) return res.status(404).json({ error: "game_deleted" });
  let screenshots = [];
  try{
    const a = JSON.parse(g.screenshots_json || "[]");
    screenshots = Array.isArray(a) ? a : [];
  }catch{}
  res.json({ game: { ...g, screenshots } });
});

/* -----------------------------
   GET /api/games/:project/versions
----------------------------- */
gamesRouter.get("/:project/versions", requireAuth, async (req, res) => {
  const { project } = req.params;
  if (!isValidproject(project)) return res.sendStatus(400);

  const game = await get("SELECT id, is_hidden, owner_user_id FROM games WHERE project=?", [project]);
  if (!game || game.is_hidden) return res.status(404).json({ error: "game_deleted" });

  const isOwner = game.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  let rows = await all(
    `SELECT version, entry_html, is_published, approval_status
     FROM game_versions
     WHERE game_id=? AND approval_status='approved'
     ORDER BY created_at DESC`,
    [game.id]
  );

  if (!isOwner && !isPrivileged) {
    const wl = await all(
      `SELECT version FROM game_version_whitelist
       WHERE game_id=? AND user_id=?`,
      [game.id, req.user.uid]
    );
    const allowed = new Set(wl.map(r => r.version));
    rows = rows.filter(r => r.is_published === 1 || allowed.has(r.version));
  }

  if (rows.length) {
    return res.json({ versions: rows });
  }

  const dir = path.join(GAME_STORAGE_DIR, project);
  if (!fs.existsSync(dir)) return res.json({ versions: [] });

  const versions = fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(isValidVersion);

  res.json({ versions: versions.map(v => ({ version: v })) });
});

/* -----------------------------
   GET /api/games/:project/:version/assets.json
----------------------------- */
gamesRouter.get("/:project/:version/assets.json", async (req, res) => {
  const { project, version } = req.params;
  if (!isValidproject(project) || !isValidVersion(version)) {
    return res.sendStatus(400);
  }

  const dir = path.join(GAME_STORAGE_DIR, project, version);
  if (!fs.existsSync(dir)) return res.sendStatus(404);

  res.setHeader("Cache-Control", "public, max-age=60");
  const assets = listFilesRecursive(dir);
  const fileMap = {};
  for (const entry of assets) {
    fileMap[entry.path] = { size: entry.size };
  }
  res.json({ [version]: fileMap });
});
