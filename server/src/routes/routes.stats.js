import express from "express";
import { requireAuth } from "../auth.js";
import { get, run } from "../db.js";

export const statsRouter = express.Router();

statsRouter.get("/:slug/me", requireAuth, async (req,res)=>{
  const slug = String(req.params.slug || "").trim();
  const g = await get("SELECT id FROM games WHERE slug=? AND is_hidden=0", [slug]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const row = await get(
    `SELECT playtime_ms, sessions, last_played
     FROM game_playtime
     WHERE user_id=? AND game_id=?`,
    [req.user.uid, g.id]
  );
  res.json({ stats: row || { playtime_ms:0, sessions:0, last_played:null } });
});

// Start session: returns session_id + started_at
statsRouter.post("/:slug/session/start", requireAuth, async (req,res)=>{
  const slug = String(req.params.slug || "").trim();
  const g = await get("SELECT id FROM games WHERE slug=? AND is_hidden=0", [slug]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const started_at = Date.now();
  // We keep it simple: session_id is a timestamp+uid+game
  const session_id = `${req.user.uid}:${g.id}:${started_at}`;
  res.json({ ok:true, session_id, started_at });
});

// End session: adds elapsed time
statsRouter.post("/:slug/session/end", requireAuth, async (req,res)=>{
  const slug = String(req.params.slug || "").trim();
  const session_id = String(req.body?.session_id || "").trim();
  const started_at = Number(req.body?.started_at);
  const ended_at = Date.now();

  if(!session_id || !Number.isFinite(started_at)){
    return res.status(400).json({ error:"missing_fields" });
  }

  const g = await get("SELECT id FROM games WHERE slug=? AND is_hidden=0", [slug]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const delta = Math.max(0, Math.min(ended_at - started_at, 24*60*60*1000));

  await run(
    `INSERT INTO game_playtime(user_id,game_id,playtime_ms,sessions,last_played)
     VALUES(?,?,?,?,?)
     ON CONFLICT(user_id,game_id) DO UPDATE SET
       playtime_ms=playtime_ms+excluded.playtime_ms,
       sessions=sessions+1,
       last_played=excluded.last_played`,
    [req.user.uid, g.id, delta, 1, ended_at]
  );

  res.json({ ok:true, added_ms: delta });
});
