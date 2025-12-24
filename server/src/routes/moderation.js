import express from "express";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { requireAuth, requireRole } from "../auth.js";
import { all, get, run } from "../db.js";

export const moderationRouter = express.Router();

const MOD_ROLES = ["admin", "mod", "moderator"];
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const TOS_PATH = path.join(PROJECT_ROOT, "web", "tos.json");

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
    `SELECT 'game' AS type, g.slug AS ref, v.version AS version, v.entry_html AS entry_html,
            v.approval_status AS status, v.created_at
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

/* GET /api/mod/appeals/open */
moderationRouter.get("/appeals/open", requireAuth, requireRole(...MOD_ROLES), async (_req, res) => {
  const rows = await all(`
    SELECT a.id,a.ban_id,a.message,a.created_at,
           b.reason,b.expires_at,b.target_type,b.target_id,
           u.username
    FROM ban_appeals a
    JOIN bans b ON b.id=a.ban_id
    JOIN users u ON u.id=a.user_id
    WHERE a.status='open'
    ORDER BY a.created_at
  `);
  res.json({ appeals: rows });
});

/* POST /api/mod/appeals/decide */
moderationRouter.post("/appeals/decide", requireAuth, requireRole(...MOD_ROLES), async (req, res) => {
  const id = Number(req.body?.id);
  const decision = String(req.body?.decision || "");
  const note = String(req.body?.note || "");
  if (!Number.isFinite(id) || !["accepted", "rejected"].includes(decision)) {
    return res.status(400).json({ error: "bad_request" });
  }

  await run(
    `UPDATE ban_appeals
     SET status=?,decided_by=?,decided_at=?,decision_note=?
     WHERE id=? AND status='open'`,
    [decision, req.user.uid, Date.now(), note, id]
  );

  if (decision === "accepted") {
    const row = await get(
      `SELECT b.id, b.target_type, b.target_id
       FROM ban_appeals a
       JOIN bans b ON b.id=a.ban_id
       WHERE a.id=?`,
      [id]
    );
    if (row) {
      await run(
        `UPDATE bans SET lifted_at=?, lift_reason=? WHERE id=?`,
        [Date.now(), "Appeal accepted: " + note, row.id]
      );
      if (row.target_type === "user") {
        await run(
          `UPDATE users
           SET is_banned=0, ban_reason=NULL, banned_at=NULL
           WHERE id=?`,
          [row.target_id]
        );
      }
    }
  }

  res.json({ ok: true });
});

/* GET /api/mod/games/pending */
moderationRouter.get("/games/pending", requireAuth, requireRole(...MOD_ROLES), async (_req, res) => {
  const rows = await all(
    `SELECT g.slug, g.title, v.version, v.entry_html, v.created_at, v.approval_status,
            u.username AS uploader
     FROM game_versions v
     JOIN games g ON g.id=v.game_id
     LEFT JOIN game_uploads gu ON gu.game_id=g.id AND gu.version=v.version
     LEFT JOIN users u ON u.id=gu.uploader_user_id
     WHERE v.approval_status='pending'
     ORDER BY v.created_at ASC`
  );
  res.json({ pending: rows });
});

/* POST /api/mod/games/approve */
moderationRouter.post("/games/approve", requireAuth, requireRole(...MOD_ROLES), async (req, res) => {
  const slug = String(req.body?.slug || "").trim();
  const version = String(req.body?.version || "").trim();
  const publish = !!req.body?.publish;
  if (!slug || !version) return res.status(400).json({ error: "missing_fields" });

  const g = await get("SELECT id FROM games WHERE slug=?", [slug]);
  if (!g) return res.status(404).json({ error: "game_not_found" });

  await run(
    `UPDATE game_versions
     SET approval_status='approved', approved_by=?, approved_at=?, rejected_reason=NULL
     WHERE game_id=? AND version=?`,
    [req.user.uid, Date.now(), g.id, version]
  );

  if (publish) {
    await run("UPDATE game_versions SET is_published=0 WHERE game_id=?", [g.id]);
    await run("UPDATE game_versions SET is_published=1 WHERE game_id=? AND version=?", [g.id, version]);
  }

  res.json({ ok: true });
});

/* POST /api/mod/games/reject */
moderationRouter.post("/games/reject", requireAuth, requireRole(...MOD_ROLES), async (req, res) => {
  const slug = String(req.body?.slug || "").trim();
  const version = String(req.body?.version || "").trim();
  const reason = String(req.body?.reason || "").slice(0, 500);
  if (!slug || !version) return res.status(400).json({ error: "missing_fields" });

  const g = await get("SELECT id FROM games WHERE slug=?", [slug]);
  if (!g) return res.status(404).json({ error: "game_not_found" });

  await run(
    `UPDATE game_versions
     SET approval_status='rejected', rejected_reason=?, approved_by=NULL, approved_at=NULL, is_published=0
     WHERE game_id=? AND version=?`,
    [reason || null, g.id, version]
  );

  res.json({ ok: true });
});

/* POST /api/mod/games/reject-ban */
moderationRouter.post("/games/reject-ban", requireAuth, requireRole(...MOD_ROLES), async (req, res) => {
  const slug = String(req.body?.slug || "").trim();
  const version = String(req.body?.version || "").trim();
  const reason = String(req.body?.reason || "").slice(0, 500);
  const hours = req.body?.duration_hours == null ? null : Number(req.body.duration_hours);
  if (!slug || !version) return res.status(400).json({ error: "missing_fields" });
  if (hours != null && (!Number.isFinite(hours) || hours <= 0)) {
    return res.status(400).json({ error: "bad_duration" });
  }

  const g = await get("SELECT id FROM games WHERE slug=?", [slug]);
  if (!g) return res.status(404).json({ error: "game_not_found" });

  const uploader = await get(
    `SELECT u.id, u.username
     FROM game_uploads gu
     JOIN users u ON u.id=gu.uploader_user_id
     WHERE gu.game_id=? AND gu.version=?
     ORDER BY gu.created_at DESC
     LIMIT 1`,
    [g.id, version]
  );
  if (!uploader) return res.status(404).json({ error: "uploader_not_found" });

  await run(
    `UPDATE game_versions
     SET approval_status='rejected', rejected_reason=?, approved_by=NULL, approved_at=NULL, is_published=0
     WHERE game_id=? AND version=?`,
    [reason || null, g.id, version]
  );

  const now = Date.now();
  const expires_at = hours == null ? null : now + Math.floor(hours * 3600 * 1000);
  await run(
    `INSERT INTO bans(target_type,target_id,reason,created_at,expires_at)
     VALUES(?,?,?,?,?)`,
    ["user", uploader.id, reason || null, now, expires_at]
  );

  if (expires_at) {
    await run(
      `UPDATE users SET timeout_until=?, timeout_reason=? WHERE id=?`,
      [expires_at, reason || "temporary_ban", uploader.id]
    );
  } else {
    await run(
      `UPDATE users
       SET is_banned=1, ban_reason=?, banned_at=?,
           timeout_until=NULL, timeout_reason=NULL
       WHERE id=?`,
      [reason || "permanent_ban", now, uploader.id]
    );
  }

  res.json({ ok: true });
});

/* GET /api/mod/tos */
moderationRouter.get("/tos", requireAuth, requireRole(...MOD_ROLES), async (_req, res) => {
  try{
    const raw = await fs.readFile(TOS_PATH, "utf8");
    const json = JSON.parse(raw);
    res.json(json);
  }catch{
    res.json({});
  }
});

/* PUT /api/mod/tos */
moderationRouter.put("/tos", requireAuth, requireRole(...MOD_ROLES), async (req, res) => {
  const json = req.body || {};
  const serialized = JSON.stringify(json, null, 2);
  if (serialized.length > 200000) {
    return res.status(413).json({ error: "too_large" });
  }
  await fs.writeFile(TOS_PATH, serialized + "\n", "utf8");
  res.json({ ok: true });
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
        `UPDATE users
         SET is_banned=1, ban_reason=?, banned_at=?,
             timeout_until=NULL, timeout_reason=NULL
         WHERE id=?`,
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

/* POST /api/mod/games/feature */
moderationRouter.post("/games/feature", requireAuth, requireRole(...MOD_ROLES), async (req, res) => {
  const slug = String(req.body?.slug || "").trim();
  const featured = req.body?.featured ? 1 : 0;
  if (!slug) return res.status(400).json({ error: "missing_slug" });

  const g = await get("SELECT id FROM games WHERE slug=?", [slug]);
  if (!g) return res.status(404).json({ error: "game_not_found" });

  await run("UPDATE games SET is_featured=? WHERE id=?", [featured, g.id]);
  res.json({ ok: true });
});
