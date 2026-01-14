import express from "express";
import crypto from "crypto";
import { requireAuth } from "../auth.js";
import { get, run } from "../db.js";

export const launcherRouter = express.Router();

launcherRouter.post("/token", requireAuth, async (req,res)=>{
  const game_project = String(req.body?.game_project || "").trim();
  if(!game_project) return res.status(400).json({ error:"missing_game_project" });

  const game = await get("SELECT project FROM games WHERE project=? AND is_hidden=0", [game_project]);
  if(!game) return res.status(404).json({ error:"game_not_found" });

  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const expires_at = now + 2 * 60 * 1000;

  await run(
    `INSERT INTO launcher_tokens(token,user_id,game_project,created_at,expires_at,ip_hint)
     VALUES(?,?,?,?,?,?)`,
    [token, req.user.uid, game_project, now, expires_at, req.ip || null]
  );

  res.json({ token, expires_at, user_id: req.user.uid, game_project });
});

launcherRouter.post("/verify", async (req,res)=>{
  const token = String(req.body?.token || "").trim();
  const game_project = String(req.body?.game_project || "").trim();
  const used_by = String(req.body?.used_by || "").slice(0,120);

  if(!token || !game_project) return res.status(400).json({ error:"missing_fields" });

  const row = await get(
    `SELECT id, user_id, game_project, expires_at, used_at, ip_hint
     FROM launcher_tokens WHERE token=?`,
    [token]
  );
  if(!row) return res.status(404).json({ error:"invalid_token" });
  if(row.used_at) return res.status(400).json({ error:"token_used" });
  if(row.game_project !== game_project) return res.status(400).json({ error:"wrong_game" });
  if(row.expires_at < Date.now()) return res.status(400).json({ error:"token_expired" });

  const verifyIp = req.ip;
  if(row.ip_hint && verifyIp !== row.ip_hint){
    return res.status(403).json({ error:"ip_mismatch" });
  }

  await run(`UPDATE launcher_tokens SET used_at=?, used_by=? WHERE id=?`, [Date.now(), used_by || null, row.id]);
  res.json({ ok:true, user_id: row.user_id, game_project: row.game_project });
});
