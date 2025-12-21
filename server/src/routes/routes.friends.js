import express from "express";
import { all, run, get } from "../db.js";
import { requireAuth } from "../auth.js";

export const friendsRouter = express.Router();

friendsRouter.get("/", requireAuth, async (req,res)=>{
  const rows = await all(
    `SELECT u.username, f.status
     FROM friends f
     JOIN users u ON u.id=f.friend_id
     WHERE f.user_id=?
     ORDER BY u.username`,
    [req.user.uid]
  );
  res.json({ friends: rows });
});

friendsRouter.post("/request", requireAuth, async (req,res)=>{
  const username = String(req.body?.username||"").trim();
  if(!username) return res.status(400).json({ error:"missing_fields" });

  const target = await get("SELECT id FROM users WHERE username=?", [username]);
  if(!target) return res.status(404).json({ error:"user_not_found" });
  if(target.id === req.user.uid) return res.status(400).json({ error:"cannot_friend_self" });

  const now = Date.now();
  await run(`INSERT OR IGNORE INTO friends(user_id,friend_id,status,created_at) VALUES(?,?, 'pending', ?)`, [req.user.uid, target.id, now]);
  await run(`INSERT OR IGNORE INTO friends(user_id,friend_id,status,created_at) VALUES(?,?, 'pending', ?)`, [target.id, req.user.uid, now]);
  res.json({ ok:true });
});

friendsRouter.post("/accept", requireAuth, async (req,res)=>{
  const username = String(req.body?.username||"").trim();
  if(!username) return res.status(400).json({ error:"missing_fields" });

  const target = await get("SELECT id FROM users WHERE username=?", [username]);
  if(!target) return res.status(404).json({ error:"user_not_found" });

  await run(`UPDATE friends SET status='accepted' WHERE user_id=? AND friend_id=?`, [req.user.uid, target.id]);
  await run(`UPDATE friends SET status='accepted' WHERE user_id=? AND friend_id=?`, [target.id, req.user.uid]);
  res.json({ ok:true });
});

friendsRouter.post("/remove", requireAuth, async (req,res)=>{
  const username = String(req.body?.username||"").trim();
  if(!username) return res.status(400).json({ error:"missing_fields" });

  const target = await get("SELECT id FROM users WHERE username=?", [username]);
  if(!target) return res.status(404).json({ error:"user_not_found" });

  await run(`DELETE FROM friends WHERE user_id=? AND friend_id=?`, [req.user.uid, target.id]);
  await run(`DELETE FROM friends WHERE user_id=? AND friend_id=?`, [target.id, req.user.uid]);
  res.json({ ok:true });
});
