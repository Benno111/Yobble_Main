import jwt from "jsonwebtoken";
import { get } from "./db.js";

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
      `SELECT id, username, role, is_banned, ban_reason, timeout_until, timeout_reason
       FROM users WHERE id=?`,
      [decoded.uid]
    );
    if (!u) return res.status(401).json({ error: "invalid_token" });

    if (u.is_banned) {
      return res.status(403).json({ error: "account_banned", reason: u.ban_reason || null });
    }
    const now = Date.now();
    if (u.timeout_until && u.timeout_until > now) {
      return res.status(403).json({ error: "account_timed_out", until: u.timeout_until, reason: u.timeout_reason || null });
    }

    req.user = { uid: u.id, username: u.username, role: u.role };
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
