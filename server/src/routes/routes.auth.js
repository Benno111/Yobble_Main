import express from "express";
import bcrypt from "bcryptjs";
import { get, run } from "../db.js";
import { requireAuth, signToken } from "../auth.js";

export const authRouter = express.Router();

authRouter.post("/register", async (req,res)=>{
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if(username.length < 3 || password.length < 6){
    return res.status(400).json({ error:"invalid_input" });
  }

  const existing = await get("SELECT id FROM users WHERE username=?", [username]);
  if(existing) return res.status(409).json({ error:"username_taken" });

  const hash = await bcrypt.hash(password, 10);
  const r = await run(
    "INSERT INTO users(username,password_hash,role) VALUES(?,?,?)",
    [username, hash, "user"]
  );
  await run(
    "INSERT OR IGNORE INTO profiles(user_id, display_name, updated_at) VALUES(?,?,?)",
    [r.lastID, username, Date.now()]
  );

  const user = { id: r.lastID, username, role: "user" };
  res.json({ token: signToken(user), user });
});

authRouter.post("/login", async (req,res)=>{
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  const user = await get(
    `SELECT id, password_hash, role, is_banned, ban_reason, timeout_until, timeout_reason
     FROM users WHERE username=?`,
    [username]
  );
  if(!user) return res.status(401).json({ error:"invalid_login" });

  if(user.is_banned){
    return res.status(403).json({ error:"account_banned", reason: user.ban_reason || null });
  }
  const now = Date.now();
  if(user.timeout_until && user.timeout_until > now){
    return res.status(403).json({ error:"account_timed_out", until: user.timeout_until, reason: user.timeout_reason || null });
  }

  const ok = await bcrypt.compare(password, user.password_hash || "");
  if(!ok) return res.status(401).json({ error:"invalid_login" });

  const outUser = { id: user.id, username, role: user.role };
  res.json({ token: signToken(outUser), user: outUser });
});

authRouter.get("/me", requireAuth, async (req,res)=>{
  res.json({ user: { id:req.user.uid, username: req.user.username, role: req.user.role } });
});
