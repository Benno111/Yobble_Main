import jwt from "jsonwebtoken";
import { get, run } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const TOKEN_TTL = "7d";
const ROLE_ORDER = { user: 0, moderator: 1, admin: 2 };

export function signToken(user) {
  return jwt.sign(
    { uid: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export async function requireAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: "not_authenticated" });

  try {
    const decoded = verifyToken(t);
    const u = await get(
      `SELECT id, username, role, is_banned, ban_reason, banned_at, timeout_until, timeout_reason
       FROM users WHERE id=?`,
      [decoded.uid]
    );
    if (!u) return res.status(401).json({ error: "invalid_token" });

    const now = Date.now();
    const permaBan = await get(
      `SELECT reason, created_at
       FROM bans
       WHERE target_type='user' AND target_id=?
         AND lifted_at IS NULL
         AND expires_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [u.id]
    );
    if (permaBan && (u.timeout_until || u.timeout_reason)) {
      await run(
        `UPDATE users SET timeout_until=NULL, timeout_reason=NULL WHERE id=?`,
        [u.id]
      );
      u.timeout_until = null;
      u.timeout_reason = null;
    }
    let activeTempBan = null;
    if (!permaBan) {
      activeTempBan = await get(
        `SELECT id, reason, created_at, expires_at
         FROM bans
         WHERE target_type='user' AND target_id=?
           AND lifted_at IS NULL
           AND expires_at IS NOT NULL
           AND expires_at > ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [u.id, now]
      );
      if (activeTempBan) {
        if (u.timeout_until !== activeTempBan.expires_at || u.timeout_reason !== (activeTempBan.reason || "temporary_ban")) {
          await run(
            `UPDATE users SET timeout_until=?, timeout_reason=? WHERE id=?`,
            [activeTempBan.expires_at, activeTempBan.reason || "temporary_ban", u.id]
          );
          u.timeout_until = activeTempBan.expires_at;
          u.timeout_reason = activeTempBan.reason || "temporary_ban";
        }
      } else if (!activeTempBan && u.is_banned) {
        await run(
          `UPDATE users
           SET is_banned=0, ban_reason=NULL, banned_at=NULL
           WHERE id=?`,
          [u.id]
        );
        u.is_banned = 0;
        u.ban_reason = null;
        u.banned_at = null;
      }
      if (!activeTempBan && u.timeout_until) {
        await run(
          `UPDATE users SET timeout_until=NULL, timeout_reason=NULL WHERE id=?`,
          [u.id]
        );
        u.timeout_until = null;
        u.timeout_reason = null;
      }
    }
    if (permaBan || (u.is_banned && activeTempBan)) {
      const ban = permaBan || activeTempBan;
      if (permaBan && (u.timeout_until || u.timeout_reason)) {
        await run(
          `UPDATE users SET timeout_until=NULL, timeout_reason=NULL WHERE id=?`,
          [u.id]
        );
      }
      return res.status(403).json({
        error: "account_banned",
        reason: ban?.reason || u.ban_reason || null,
        banned_at: u.banned_at || ban?.created_at || null
      });
    }
    if (!permaBan && activeTempBan) {
      const appeal = await get(
        `SELECT id FROM ban_appeals WHERE ban_id=? AND status='open'`,
        [activeTempBan.id]
      );
      if (!appeal) {
        return res.status(403).json({
          error: "account_timed_out",
          until: activeTempBan.expires_at,
          reason: activeTempBan.reason || u.timeout_reason || null
        });
      }
    }
    if (u.timeout_until && u.timeout_until > now) {
      return res.status(403).json({ error: "account_timed_out", until: u.timeout_until, reason: u.timeout_reason || null });
    }

    req.user = { uid: u.id, username: u.username, role: u.role };
    next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}

export async function requireAuthAllowBanned(req, res, next) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: "not_authenticated" });

  try {
    const decoded = verifyToken(t);
    const u = await get(
      `SELECT id, username, role, is_banned, ban_reason, banned_at, timeout_until, timeout_reason
       FROM users WHERE id=?`,
      [decoded.uid]
    );
    if (!u) return res.status(401).json({ error: "invalid_token" });

    const now = Date.now();
    const permaBan = await get(
      `SELECT reason, created_at
       FROM bans
       WHERE target_type='user' AND target_id=?
         AND lifted_at IS NULL
         AND expires_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [u.id]
    );
    let activeTempBan = null;
    if (!permaBan) {
      activeTempBan = await get(
        `SELECT id, reason, created_at, expires_at
         FROM bans
         WHERE target_type='user' AND target_id=?
           AND lifted_at IS NULL
           AND expires_at IS NOT NULL
           AND expires_at > ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [u.id, now]
      );
      if (activeTempBan) {
        if (u.timeout_until !== activeTempBan.expires_at || u.timeout_reason !== (activeTempBan.reason || "temporary_ban")) {
          await run(
            `UPDATE users SET timeout_until=?, timeout_reason=? WHERE id=?`,
            [activeTempBan.expires_at, activeTempBan.reason || "temporary_ban", u.id]
          );
          u.timeout_until = activeTempBan.expires_at;
          u.timeout_reason = activeTempBan.reason || "temporary_ban";
        }
      } else if (!activeTempBan && u.is_banned) {
        await run(
          `UPDATE users
           SET is_banned=0, ban_reason=NULL, banned_at=NULL
           WHERE id=?`,
          [u.id]
        );
        u.is_banned = 0;
        u.ban_reason = null;
        u.banned_at = null;
      }
      if (!activeTempBan && u.timeout_until) {
        await run(
          `UPDATE users SET timeout_until=NULL, timeout_reason=NULL WHERE id=?`,
          [u.id]
        );
        u.timeout_until = null;
        u.timeout_reason = null;
      }
    }
    // allow timed-out users for appeals flow

    req.user = {
      uid: u.id,
      username: u.username,
      role: u.role,
      is_banned: !!permaBan || (!!u.is_banned && !!activeTempBan),
      ban_reason: u.ban_reason || permaBan?.reason || activeTempBan?.reason || null,
      banned_at: u.banned_at || permaBan?.created_at || activeTempBan?.created_at || null,
      timeout_until: activeTempBan?.expires_at || u.timeout_until || null,
      timeout_reason: u.timeout_reason || activeTempBan?.reason || null
    };
    next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}

export function requireRole(...rolesOrMin) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "not_authenticated" });

    if (rolesOrMin.length > 1) {
      if (!rolesOrMin.includes(req.user.role)) {
        return res.status(403).json({ error: "forbidden" });
      }
      return next();
    }

    const minRole = rolesOrMin[0];
    if (minRole && ROLE_ORDER[minRole] != null) {
      const u = ROLE_ORDER[req.user.role] ?? -1;
      const m = ROLE_ORDER[minRole] ?? 999;
      if (u < m) return res.status(403).json({ error: "forbidden" });
      return next();
    }

    if (minRole && req.user.role !== minRole) {
      return res.status(403).json({ error: "forbidden" });
    }
    next();
  };
}
