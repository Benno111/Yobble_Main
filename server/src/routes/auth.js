import express from "express";
import bcrypt from "bcryptjs";
import { get, run } from "../db.js";
import { requireAuth, signToken } from "../auth.js";

export const authRouter = express.Router();

/* -------------------------------------------------
   Routes
------------------------------------------------- */

/* POST /api/auth/register
   { username, password }
*/
authRouter.post("/register", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: "invalid_input" });
  }

  try {
    const r = await run(
      "INSERT INTO users(username,password_hash,role) VALUES(?,?,?)",
      [username, await bcrypt.hash(password, 10), "user"]
    );
    await run(
      "INSERT OR IGNORE INTO profiles(user_id, display_name, updated_at) VALUES(?,?,?)",
      [r.lastID, username, Date.now()]
    );

    const user = { id: r.lastID, username, role: "user" };
    res.json({ token: signToken(user), user });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      return res.status(409).json({ error: "username_taken" });
    }
    throw e;
  }
});

/* POST /api/auth/login
   { username, password }
*/
authRouter.post("/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!username || !password) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const user = await get(
    `SELECT id, username, password_hash, role,
            is_banned, ban_reason,
            timeout_until, timeout_reason
     FROM users WHERE username=?`,
    [username]
  );

  if (!user) {
    return res.status(401).json({ error: "invalid_login" });
  }

  if (user.is_banned) {
    return res.status(403).json({
      error: "banned",
      reason: user.ban_reason || "Account banned"
    });
  }

  if (user.timeout_until && Date.now() < user.timeout_until) {
    return res.status(403).json({
      error: "timeout",
      reason: user.timeout_reason || "Temporary timeout",
      until: user.timeout_until
    });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: "invalid_login" });
  }

  res.json({ token: signToken(user), user: { id: user.id, username: user.username, role: user.role } });
});

/* GET /api/auth/me */
authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await get(
    "SELECT id, username, role FROM users WHERE id=?",
    [req.user.uid]
  );

  if (!user) {
    return res.status(401).json({ error: "invalid_token" });
  }

  res.json({ user });
});

/* POST /api/auth/logout
   (stateless JWT, client just deletes token)
*/
authRouter.post("/logout", (_req, res) => {
  res.json({ ok: true });
});
