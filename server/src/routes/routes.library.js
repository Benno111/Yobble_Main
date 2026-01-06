import express from "express";
import { requireAuth } from "../auth.js";
import { all, get, run } from "../db.js";

export const libraryRouter = express.Router();

libraryRouter.get("/", requireAuth, async (req,res)=>{
  const rows = await all(
    `SELECT g.slug, g.title, g.description, g.category, ul.added_at
     FROM user_library ul
     JOIN games g ON g.id=ul.game_id
     WHERE ul.user_id=?
     ORDER BY ul.added_at DESC`,
    [req.user.uid]
  );
  res.json({ games: rows });
});

libraryRouter.post("/add", requireAuth, async (req,res)=>{
  const slug = String(req.body?.slug || "").trim();
  if(!slug) return res.status(400).json({ error:"missing_slug" });
  const g = await get("SELECT id FROM games WHERE slug=? AND is_hidden=0", [slug]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  await run(
    `INSERT OR IGNORE INTO user_library(user_id, game_id, added_at) VALUES(?,?,?)`,
    [req.user.uid, g.id, Date.now()]
  );
  res.json({ ok:true });
});

libraryRouter.post("/remove", requireAuth, async (req,res)=>{
  const slug = String(req.body?.slug || "").trim();
  if(!slug) return res.status(400).json({ error:"missing_slug" });
  const g = await get("SELECT id FROM games WHERE slug=?", [slug]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  await run(`DELETE FROM user_library WHERE user_id=? AND game_id=?`, [req.user.uid, g.id]);
  res.json({ ok:true });
});

libraryRouter.get("/has", requireAuth, async (req,res)=>{
  const slug = String(req.query?.slug || "").trim();
  if(!slug) return res.status(400).json({ error:"missing_slug" });
  const g = await get("SELECT id FROM games WHERE slug=?", [slug]);
  if(!g) return res.json({ in_library:false });

  const row = await get(`SELECT 1 AS ok FROM user_library WHERE user_id=? AND game_id=?`, [req.user.uid, g.id]);
  res.json({ in_library: !!row });
});
