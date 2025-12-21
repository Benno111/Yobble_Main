import express from "express";
import { requireAuth, requireRole } from "../auth.js";
import { all, get, run } from "../db.js";

export const moderationRouter = express.Router();

const MOD_ROLES = ["admin", "mod", "moderator"];

/* GET /api/mod/overview (stub) */
moderationRouter.get("/overview", requireAuth, requireRole(...MOD_ROLES), async (_req, res) => {
  res.json({ ok: true, reports: 0, pending_items: 0, pending_games: 0 });
});

/* GET /api/mod/stats/bans */
moderationRouter.get("/stats/bans", requireAuth, requireRole(...MOD_ROLES), async (_req, res) => {
  const now = Date.now();
  const activeByType = await all(
    `SELECT target_type, COUNT(*) AS c
     FROM bans
     WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
     GROUP BY target_type`,
    [now]
  );
  const openAppealsRow = await all(
    `SELECT COUNT(*) AS c FROM ban_appeals WHERE status='open'`
  );
  const created24hRow = await all(
    `SELECT COUNT(*) AS c FROM bans WHERE created_at > ?`,
    [now - 24 * 60 * 60 * 1000]
  );
  const created7dRow = await all(
    `SELECT COUNT(*) AS c FROM bans WHERE created_at > ?`,
    [now - 7 * 24 * 60 * 60 * 1000]
  );
  const permaRow = await all(
    `SELECT COUNT(*) AS c FROM bans WHERE lifted_at IS NULL AND expires_at IS NULL`
  );
  const tempRow = await all(
    `SELECT COUNT(*) AS c FROM bans WHERE lifted_at IS NULL AND expires_at IS NOT NULL AND expires_at > ?`,
    [now]
  );

  res.json({
    activeByType,
    openAppeals: openAppealsRow[0]?.c ?? 0,
    created24h: created24hRow[0]?.c ?? 0,
    created7d: created7dRow[0]?.c ?? 0,
    permaActive: permaRow[0]?.c ?? 0,
    tempActive: tempRow[0]?.c ?? 0
  });
});

/* GET /api/mod/reports (stub) */
moderationRouter.get("/reports", requireAuth, requireRole(...MOD_ROLES), async (_req, res) => {
  res.json([]);
});

/* GET /api/mod/queue */
moderationRouter.get("/queue", requireAuth, requireRole(...MOD_ROLES), async (_req, res) => {
  const pendingGames = await all(
    `SELECT 'game' AS type, g.slug AS ref, v.approval_status AS status, v.created_at
     FROM game_versions v
     JOIN games g ON g.id=v.game_id
     WHERE v.approval_status='pending'
     ORDER BY v.created_at ASC
     LIMIT 200`
  );
  const pendingItems = await all(
    `SELECT 'item' AS type, i.code AS ref, i.approval_status AS status, i.created_at
     FROM items i
     WHERE i.approval_status='pending'
     ORDER BY i.created_at ASC
     LIMIT 200`
  );
  res.json({ queue: [...pendingGames, ...pendingItems] });
});

/* POST /api/mod/items/approve */
moderationRouter.post("/items/approve", requireAuth, requireRole(...MOD_ROLES), async (req, res) => {
  const code = String(req.body?.code || "").trim();
  if (!code) return res.status(400).json({ error: "missing_code" });
  await run(
    `UPDATE items SET approval_status='approved', approved_by=?, approved_at=?, rejected_reason=NULL
     WHERE code=?`,
    [req.user.uid, Date.now(), code]
  );
  res.json({ ok: true });
});

/* POST /api/mod/items/reject */
moderationRouter.post("/items/reject", requireAuth, requireRole(...MOD_ROLES), async (req, res) => {
  const code = String(req.body?.code || "").trim();
  const reason = String(req.body?.reason || "").trim().slice(0, 500);
  if (!code) return res.status(400).json({ error: "missing_code" });
  await run(
    `UPDATE items SET approval_status='rejected', rejected_reason=?, approved_by=NULL, approved_at=NULL
     WHERE code=?`,
    [reason || null, code]
  );
  res.json({ ok: true });
});

/* GET /api/mod/search?q= */
moderationRouter.get("/search", requireAuth, requireRole(...MOD_ROLES), async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 3) return res.json({ users: [], games: [], items: [] });

  const like = `%${q}%`;
  const users = await all("SELECT id, username FROM users WHERE username LIKE ?", [like]);
  const games = await all("SELECT id, slug, title FROM games WHERE slug LIKE ? OR title LIKE ?", [like, like]);
  const items = await all("SELECT id, code, name FROM items WHERE code LIKE ? OR name LIKE ?", [like, like]);

  res.json({ users, games, items });
});

/* POST /api/mod/bans/create */
moderationRouter.post("/bans/create", requireAuth, requireRole(...MOD_ROLES), async (req, res) => {
  const { target_type, target_ref, duration_hours, reason } = req.body || {};
  const type = String(target_type || "").trim();
  const ref = String(target_ref || "").trim();
  const hours = duration_hours == null ? null : Number(duration_hours);
  const note = String(reason || "").trim();

  if (!type || !ref) return res.status(400).json({ error: "missing_fields" });
  if (hours != null && (!Number.isFinite(hours) || hours <= 0)) {
    return res.status(400).json({ error: "bad_duration" });
  }

  let target = null;
  let targetUserId = null;
  if (type === "user") {
    target = await get("SELECT id FROM users WHERE username=?", [ref]);
    targetUserId = target?.id || null;
  } else if (type === "game") {
    target = await get("SELECT id FROM games WHERE slug=?", [ref]);
  } else if (type === "item") {
    target = await get("SELECT id FROM items WHERE code=?", [ref]);
  } else {
    return res.status(400).json({ error: "unsupported_target" });
  }
  if (!target) return res.status(404).json({ error: "target_not_found" });

  const now = Date.now();
  const expires_at = hours == null ? null : now + Math.floor(hours * 3600 * 1000);
  const result = await run(
    `INSERT INTO bans(target_type,target_id,reason,created_at,expires_at)
     VALUES(?,?,?,?,?)`,
    [type, target.id, note || null, now, expires_at]
  );

  if (type === "user" && targetUserId) {
    if (expires_at) {
      await run(
        `UPDATE users SET timeout_until=?, timeout_reason=? WHERE id=?`,
        [expires_at, note || "temporary_ban", targetUserId]
      );
    } else {
      await run(
        `UPDATE users SET is_banned=1, ban_reason=?, banned_at=? WHERE id=?`,
        [note || "permanent_ban", now, targetUserId]
      );
    }
  }

  res.json({ ok: true, ban_id: result.lastID, expires_at });
});

/* POST /api/mod/games/remove (soft hide) */
moderationRouter.post("/games/remove", requireAuth, requireRole(...MOD_ROLES), async (req, res) => {
  const slug = String(req.body?.slug || "").trim();
  if (!slug) return res.status(400).json({ error: "missing_slug" });

  const g = await get("SELECT id FROM games WHERE slug=?", [slug]);
  if (!g) return res.status(404).json({ error: "game_not_found" });

  await run("UPDATE games SET is_hidden=1 WHERE id=?", [g.id]);
  res.json({ ok: true });
});

/* POST /api/mod/games/unhide */
moderationRouter.post("/games/unhide", requireAuth, requireRole(...MOD_ROLES), async (req, res) => {
  const slug = String(req.body?.slug || "").trim();
  if (!slug) return res.status(400).json({ error: "missing_slug" });

  const g = await get("SELECT id FROM games WHERE slug=?", [slug]);
  if (!g) return res.status(404).json({ error: "game_not_found" });

  await run("UPDATE games SET is_hidden=0 WHERE id=?", [g.id]);
  res.json({ ok: true });
});
