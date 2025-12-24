import express from "express";
import { all, get, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { nowMs } from "../util.js";

export const profileRouter = express.Router();

profileRouter.get("/me", requireAuth, async (req,res)=>{
  let p = await get(
    `SELECT u.id,u.username,u.role,u.is_banned,pr.display_name,pr.bio,pr.avatar_url,pr.status_text,pr.updated_at
     FROM users u LEFT JOIN profiles pr ON pr.user_id=u.id WHERE u.id=?`,
    [req.user.uid]
  );
  if (!p) return res.status(404).json({ error: "user_not_found" });
  if (p.is_banned) return res.status(404).json({ error: "not_found" });
  if (!p.display_name) {
    await run(
      "INSERT OR IGNORE INTO profiles(user_id, display_name, updated_at) VALUES(?,?,?)",
      [req.user.uid, p.username, nowMs()]
    );
    p = { ...p, display_name: p.username };
  }
  res.json({ profile: p });
});

profileRouter.patch("/me", requireAuth, async (req,res)=>{
  const { display_name, bio, avatar_url, status_text } = req.body || {};
  await run(
    `UPDATE profiles SET
      display_name=COALESCE(?,display_name),
      bio=COALESCE(?,bio),
      avatar_url=COALESCE(?,avatar_url),
      status_text=COALESCE(?,status_text),
      updated_at=?
     WHERE user_id=?`,
    [display_name ?? null, bio ?? null, avatar_url ?? null, status_text ?? null, nowMs(), req.user.uid]
  );
  res.json({ ok:true });
});

profileRouter.get("/lookup", requireAuth, async (req,res)=>{
  const q = String(req.query.q || "").trim();
  if(!q) return res.json({ users: [] });
  const users = await all(
    `SELECT u.id,u.username,pr.display_name,pr.avatar_url,pr.status_text,pr.bio
     FROM users u LEFT JOIN profiles pr ON pr.user_id=u.id
     WHERE (u.username LIKE ? OR pr.display_name LIKE ?)
       AND (u.is_banned IS NULL OR u.is_banned=0)
     ORDER BY u.username COLLATE NOCASE ASC
     LIMIT 25`,
    [`%${q}%`, `%${q}%`]
  );
  res.json({ users });
});

profileRouter.get("/lookup-exact", requireAuth, async (req,res)=>{
  const u = String(req.query.u || "").trim();
  if(!u) return res.status(400).json({ error: "bad_request" });
  const user = await get(
    `SELECT u.id,u.username,u.role,u.is_banned,u.ban_reason,u.banned_at,u.timeout_until,u.timeout_reason,
            pr.display_name,pr.bio,pr.avatar_url,pr.status_text,pr.updated_at
     FROM users u LEFT JOIN profiles pr ON pr.user_id=u.id
     WHERE LOWER(u.username)=LOWER(?)
     LIMIT 1`,
    [u]
  );
  if(!user) return res.status(404).json({ error: "not_found" });
  if(user.is_banned){
    return res.status(403).json({ error: "account_banned", reason: user.ban_reason || null });
  }
  if(user.timeout_until && user.timeout_until > Date.now()){
    return res.status(403).json({ error: "account_timed_out", until: user.timeout_until, reason: user.timeout_reason || null });
  }
  res.json({ profile: user });
});
