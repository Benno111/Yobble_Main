import express from "express";
import { all, get, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { nowMs } from "../util.js";

export const profileRouter = express.Router();

profileRouter.get("/me", requireAuth, async (req,res)=>{
  let p = await get(
    `SELECT u.id,u.username,u.role,u.is_banned,
            pr.display_name,pr.bio,pr.avatar_url,pr.status_text,pr.updated_at,
            pr.hair_color,pr.hair_length,pr.hair_type_back,pr.hair_type_front,
            pr.hair_type_left,pr.hair_type_right,pr.hair_variation,
            pr.skin_tone,pr.eyes,pr.outfit,pr.accessories,
            u.delete_requested_at,u.delete_at,u.deleted_at
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

profileRouter.post("/me/delete", requireAuth, async (req,res)=>{
  const now = nowMs();
  const row = await get(
    "SELECT id, delete_at, deleted_at FROM users WHERE id=?",
    [req.user.uid]
  );
  if (!row) return res.status(404).json({ error: "user_not_found" });
  if (row.deleted_at) return res.status(400).json({ error: "already_deleted" });
  if (row.delete_at && row.delete_at > now) {
    return res.json({ ok: true, delete_at: row.delete_at });
  }
  const deleteAt = now + 30 * 24 * 60 * 60 * 1000;
  await run(
    "UPDATE users SET delete_requested_at=?, delete_at=? WHERE id=?",
    [now, deleteAt, req.user.uid]
  );
  res.json({ ok: true, delete_at: deleteAt });
});

profileRouter.post("/me/delete-cancel", requireAuth, async (req,res)=>{
  const now = nowMs();
  const row = await get(
    "SELECT id, delete_at, deleted_at FROM users WHERE id=?",
    [req.user.uid]
  );
  if (!row) return res.status(404).json({ error: "user_not_found" });
  if (row.deleted_at) return res.status(400).json({ error: "already_deleted" });
  if (!row.delete_at || row.delete_at <= now) {
    return res.status(400).json({ error: "delete_not_pending" });
  }
  await run(
    "UPDATE users SET delete_requested_at=NULL, delete_at=NULL WHERE id=?",
    [req.user.uid]
  );
  res.json({ ok: true });
});

profileRouter.patch("/me", requireAuth, async (req,res)=>{
  const {
    display_name,
    bio,
    avatar_url,
    status_text,
    hair_color,
    hair_length,
    hair_type_back,
    hair_type_front,
    hair_type_left,
    hair_type_right,
    hair_variation,
    skin_tone,
    eyes,
    outfit,
    accessories
  } = req.body || {};
  await run(
    `UPDATE profiles SET
      display_name=COALESCE(?,display_name),
      bio=COALESCE(?,bio),
      avatar_url=COALESCE(?,avatar_url),
      status_text=COALESCE(?,status_text),
      hair_color=COALESCE(?,hair_color),
      hair_length=COALESCE(?,hair_length),
      hair_type_back=COALESCE(?,hair_type_back),
      hair_type_front=COALESCE(?,hair_type_front),
      hair_type_left=COALESCE(?,hair_type_left),
      hair_type_right=COALESCE(?,hair_type_right),
      hair_variation=COALESCE(?,hair_variation),
      skin_tone=COALESCE(?,skin_tone),
      eyes=COALESCE(?,eyes),
      outfit=COALESCE(?,outfit),
      accessories=COALESCE(?,accessories),
      updated_at=?
     WHERE user_id=?`,
    [
      display_name ?? null,
      bio ?? null,
      avatar_url ?? null,
      status_text ?? null,
      hair_color ?? null,
      hair_length ?? null,
      hair_type_back ?? null,
      hair_type_front ?? null,
      hair_type_left ?? null,
      hair_type_right ?? null,
      hair_variation ?? null,
      skin_tone ?? null,
      eyes ?? null,
      outfit ?? null,
      accessories ?? null,
      nowMs(),
      req.user.uid
    ]
  );
  res.json({ ok:true });
});

profileRouter.get("/lookup", requireAuth, async (req,res)=>{
  const q = String(req.query.q || "").trim();
  if(!q) return res.json({ users: [] });
  const users = await all(
    `SELECT u.id,u.username,pr.display_name,pr.avatar_url,pr.status_text,pr.bio,
            pr.hair_color,pr.hair_length,pr.hair_type_back,pr.hair_type_front,
            pr.hair_type_left,pr.hair_type_right,pr.hair_variation,
            pr.skin_tone,pr.eyes,pr.outfit,pr.accessories
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
            pr.display_name,pr.bio,pr.avatar_url,pr.status_text,pr.updated_at,
            pr.hair_color,pr.hair_length,pr.hair_type_back,pr.hair_type_front,
            pr.hair_type_left,pr.hair_type_right,pr.hair_variation,
            pr.skin_tone,pr.eyes,pr.outfit,pr.accessories
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
