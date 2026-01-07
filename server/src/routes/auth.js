import express from "express";
import bcrypt from "bcryptjs";
import { get, run } from "../db.js";
import { requireAuth, requireAuthAllowBanned, signToken } from "../auth.js";
import { buildTotpUri, generateTotpSecret, verifyTotp } from "../totp.js";

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
    const isBenno = username.toLowerCase() === "benno111";
    const role = isBenno ? "moderator" : "user";
    const r = await run(
      "INSERT INTO users(username,password_hash,role) VALUES(?,?,?)",
      [username, await bcrypt.hash(password, 10), role]
    );
    await run(
      "INSERT OR IGNORE INTO profiles(user_id, display_name, updated_at) VALUES(?,?,?)",
      [r.lastID, username, Date.now()]
    );

    const user = { id: r.lastID, username, role };
    const token = signToken(user);
    res.json({ token, user });
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
            is_banned, ban_reason, banned_at,
            timeout_until, timeout_reason,
            totp_enabled, totp_secret
     FROM users WHERE username=?`,
    [username]
  );

  if (!user) {
    return res.status(401).json({ error: "invalid_login" });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: "invalid_login" });
  }

  if (user.totp_enabled) {
    const totp = String(req.body?.totp || req.body?.code || "").trim();
    if (!totp) {
      return res.status(401).json({ error: "totp_required" });
    }
    if (!user.totp_secret || !verifyTotp(user.totp_secret, totp)) {
      return res.status(401).json({ error: "invalid_totp" });
    }
  }

  const now = Date.now();
  const permaBan = await get(
    `SELECT reason, created_at
     FROM bans
     WHERE target_type='user' AND target_id=?
       AND lifted_at IS NULL
       AND expires_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [user.id]
  );
  if (permaBan) {
    const token = signToken(user);
    return res.status(403).json({
      error: "account_banned",
      token,
      reason: permaBan.reason || user.ban_reason || "Account banned",
      banned_at: user.banned_at || permaBan.created_at || null
    });
  }

  const tempBan = await get(
    `SELECT reason, expires_at
     FROM bans
     WHERE target_type='user' AND target_id=?
       AND lifted_at IS NULL
       AND expires_at IS NOT NULL
       AND expires_at > ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [user.id, now]
  );
  if (tempBan) {
    const token = signToken(user);
    return res.status(403).json({
      error: "account_timed_out",
      token,
      until: tempBan.expires_at,
      reason: tempBan.reason || user.timeout_reason || "Temporary timeout"
    });
  }

  if (user.is_banned) {
    await run(
      `UPDATE users SET is_banned=0, ban_reason=NULL, banned_at=NULL WHERE id=?`,
      [user.id]
    );
    user.is_banned = 0;
    user.ban_reason = null;
    user.banned_at = null;
  }

  if (user.timeout_until && now < user.timeout_until) {
    return res.status(403).json({
      error: "account_timed_out",
      reason: user.timeout_reason || "Temporary timeout",
      until: user.timeout_until
    });
  }

  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    is_banned: !!user.is_banned,
    ban_reason: user.ban_reason || null,
    banned_at: user.banned_at || null
  };

  const token = signToken(user);
  res.json({ token, user: payload });
});

authRouter.post("/logout", (req, res) => {
  res.json({ ok: true });
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

/* GET /api/auth/me-allow-banned */
authRouter.get("/me-allow-banned", requireAuthAllowBanned, async (req, res) => {
  const user = await get(
    "SELECT id, username, role, is_banned, ban_reason, banned_at FROM users WHERE id=?",
    [req.user.uid]
  );

  if (!user) {
    return res.status(401).json({ error: "invalid_token" });
  }

  res.json({ user });
});

/* GET /api/auth/2fa/status */
authRouter.get("/2fa/status", requireAuth, async (req, res) => {
  const row = await get(
    "SELECT totp_enabled FROM users WHERE id=?",
    [req.user.uid]
  );
  res.json({ enabled: !!row?.totp_enabled });
});

/* POST /api/auth/2fa/setup */
authRouter.post("/2fa/setup", requireAuth, async (req, res) => {
  const row = await get("SELECT username FROM users WHERE id=?", [req.user.uid]);
  if (!row) return res.status(404).json({ error: "user_not_found" });
  const secret = generateTotpSecret();
  await run(
    "UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?",
    [secret, req.user.uid]
  );
  res.json({ secret, otpauth: buildTotpUri(row.username, secret) });
});

/* POST /api/auth/2fa/enable */
authRouter.post("/2fa/enable", requireAuth, async (req, res) => {
  const code = String(req.body?.code || req.body?.totp || "").trim();
  const row = await get(
    "SELECT totp_secret FROM users WHERE id=?",
    [req.user.uid]
  );
  if (!row?.totp_secret) {
    return res.status(400).json({ error: "totp_not_setup" });
  }
  if (!verifyTotp(row.totp_secret, code)) {
    return res.status(400).json({ error: "invalid_totp" });
  }
  await run("UPDATE users SET totp_enabled=1 WHERE id=?", [req.user.uid]);
  res.json({ enabled: true });
});

/* POST /api/auth/2fa/disable */
authRouter.post("/2fa/disable", requireAuth, async (req, res) => {
  const code = String(req.body?.code || req.body?.totp || "").trim();
  const row = await get(
    "SELECT totp_secret, totp_enabled FROM users WHERE id=?",
    [req.user.uid]
  );
  if (!row?.totp_enabled) {
    return res.json({ enabled: false });
  }
  if (!verifyTotp(row.totp_secret, code)) {
    return res.status(400).json({ error: "invalid_totp" });
  }
  await run(
    "UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?",
    [req.user.uid]
  );
  res.json({ enabled: false });
});

/* POST /api/auth/logout
   (stateless JWT, client just deletes token)
*/
authRouter.post("/logout", (_req, res) => {
  res.json({ ok: true });
});
