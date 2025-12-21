import express from "express";
import { all, get } from "../db.js";
import { requireAuth } from "../auth.js";

export const gamesRouter = express.Router();

gamesRouter.get("/", requireAuth, async (_req,res)=>{
  const games = await all(
    `SELECT g.id, g.slug, g.title, g.description, g.category, g.banner_path, g.screenshots_json,
            (SELECT v.version FROM game_versions v
             WHERE v.game_id=g.id AND v.is_published=1 AND v.approval_status='approved'
             ORDER BY v.created_at DESC LIMIT 1) AS latest_version,
            (SELECT v.entry_html FROM game_versions v
             WHERE v.game_id=g.id AND v.is_published=1 AND v.approval_status='approved'
             ORDER BY v.created_at DESC LIMIT 1) AS entry_html,
            (SELECT ROUND(AVG(r.rating),2) FROM game_reviews r WHERE r.game_id=g.id) AS avg_rating,
            (SELECT COUNT(*) FROM game_reviews r WHERE r.game_id=g.id) AS rating_count
     FROM games g
     WHERE g.is_hidden=0
     ORDER BY g.title`
  );

  // Parse screenshots JSON
  const out = games.map(g => ({
    ...g,
    screenshots: (()=>{ try{ const a=JSON.parse(g.screenshots_json||"[]"); return Array.isArray(a)?a:[]; }catch{return [];} })()
  }));

  res.json({ games: out });
});

gamesRouter.get("/:slug", requireAuth, async (req,res)=>{
  const slug = String(req.params.slug || "").trim();
  const g = await get(
    `SELECT g.id, g.slug, g.title, g.description, g.category, g.banner_path, g.screenshots_json,
            (SELECT v.version FROM game_versions v
             WHERE v.game_id=g.id AND v.is_published=1 AND v.approval_status='approved'
             ORDER BY v.created_at DESC LIMIT 1) AS latest_version,
            (SELECT v.entry_html FROM game_versions v
             WHERE v.game_id=g.id AND v.is_published=1 AND v.approval_status='approved'
             ORDER BY v.created_at DESC LIMIT 1) AS entry_html,
            (SELECT ROUND(AVG(r.rating),2) FROM game_reviews r WHERE r.game_id=g.id) AS avg_rating,
            (SELECT COUNT(*) FROM game_reviews r WHERE r.game_id=g.id) AS rating_count
     FROM games g
     WHERE g.slug=? AND g.is_hidden=0`,
    [slug]
  );
  if(!g) return res.status(404).json({ error:"game_deleted" });

  let screenshots=[];
  try{ const a=JSON.parse(g.screenshots_json||"[]"); screenshots=Array.isArray(a)?a:[]; }catch{}
  res.json({ game: { ...g, screenshots } });
});
