import express from "express";
import { all, get, run } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

export const changelogRouter = express.Router();

const CHANGELOG_ROLES = ["admin", "mod", "moderator"];

changelogRouter.get("/", async (req, res) => {
  try {
    const status = String(req.query.status || "published");
    const needsMod = status !== "published";
    if (needsMod) {
      return requireAuth(req, res, () =>
        requireRole(...CHANGELOG_ROLES)(req, res, async () => {
          const rows = await all(
            `SELECT id, title, body, status, created_at, updated_at, created_by
             FROM changelog_entries
             WHERE (?='all' OR status=?)
             ORDER BY created_at DESC, id DESC`,
            [status, status]
          );
          res.json({ entries: rows });
        })
      );
    }
    const rows = await all(
      `SELECT id, title, body, status, created_at, updated_at, created_by
       FROM changelog_entries
       WHERE status='published'
       ORDER BY created_at DESC, id DESC`
    );
    res.json({ entries: rows });
  } catch (err) {
    console.error("changelog list error", err);
    res.status(500).json({ error: "server_error" });
  }
});

changelogRouter.post("/", requireAuth, requireRole(...CHANGELOG_ROLES), async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim().slice(0, 140);
    const body = String(req.body?.body || "").trim().slice(0, 20000);
    const status = String(req.body?.status || "published").trim();
    if (!title || !body) return res.status(400).json({ error: "missing_fields" });
    if (!["published", "draft"].includes(status)) {
      return res.status(400).json({ error: "invalid_status" });
    }
    const now = Date.now();
    const result = await run(
      `INSERT INTO changelog_entries(title, body, created_at, created_by, status, updated_at)
       VALUES(?,?,?,?,?,?)`,
      [title, body, now, req.user.username, status, now]
    );
    res.json({ ok: true, id: result.lastID });
  } catch (err) {
    console.error("changelog create error", err);
    res.status(500).json({ error: "server_error" });
  }
});

changelogRouter.put("/:id", requireAuth, requireRole(...CHANGELOG_ROLES), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid_id" });
    const row = await get("SELECT id FROM changelog_entries WHERE id=?", [id]);
    if (!row) return res.status(404).json({ error: "not_found" });
    const title = req.body?.title != null ? String(req.body.title || "").trim().slice(0, 140) : null;
    const body = req.body?.body != null ? String(req.body.body || "").trim().slice(0, 20000) : null;
    const status = req.body?.status != null ? String(req.body.status || "").trim() : null;
    if (status && !["published", "draft"].includes(status)) {
      return res.status(400).json({ error: "invalid_status" });
    }
    const now = Date.now();
    await run(
      `UPDATE changelog_entries
       SET title=COALESCE(?, title),
           body=COALESCE(?, body),
           status=COALESCE(?, status),
           updated_at=?
       WHERE id=?`,
      [title, body, status, now, id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("changelog update error", err);
    res.status(500).json({ error: "server_error" });
  }
});
