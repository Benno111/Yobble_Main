import express from "express";
import { requireAuth, requireRole } from "../auth.js";
import { all, get, run } from "../db.js";

export const blogRouter = express.Router();

const BLOG_ROLES = ["admin", "mod", "moderator"];
const MAX_LIMIT = 100;

function projectify(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80) || "post";
}

async function ensureUniqueproject(baseproject) {
  let project = baseproject;
  let attempt = 2;
  while (await get(`SELECT id FROM blog_posts WHERE project=?`, [project])) {
    project = `${baseproject}-${attempt}`;
    attempt += 1;
  }
  return project;
}

function normalizeTags(tags) {
  if (!tags) return [];
  const list = Array.isArray(tags) ? tags : String(tags).split(",");
  return list
    .map((t) => String(t || "").trim().slice(0, 32))
    .filter(Boolean)
    .slice(0, 10);
}

function mapPost(row) {
  return {
    id: row.id,
    title: row.title,
    project: row.project,
    summary: row.summary,
    body: row.body,
    tags: row.tags_json ? JSON.parse(row.tags_json) : [],
    status: row.status,
    featured: !!row.featured,
    author: row.author,
    author_id: row.author_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at
  };
}

blogRouter.get("/posts", async (req, res) => {
  const status = String(req.query.status || "published");
  const limit = Math.min(Number(req.query.limit) || 20, MAX_LIMIT);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const needsMod = status !== "published";
  if (needsMod) {
    return requireAuth(req, res, () =>
      requireRole(...BLOG_ROLES)(req, res, async () => {
        const rows = await all(
          `SELECT p.*, u.username AS author
           FROM blog_posts p
           LEFT JOIN users u ON u.id=p.author_user_id
           WHERE (?='all' OR p.status=?)
           ORDER BY p.updated_at DESC
           LIMIT ? OFFSET ?`,
          [status, status, limit, offset]
        );
        res.json({ posts: rows.map(mapPost) });
      })
    );
  }

  const rows = await all(
    `SELECT p.*, u.username AS author
     FROM blog_posts p
     LEFT JOIN users u ON u.id=p.author_user_id
     WHERE p.status='published'
     ORDER BY p.published_at DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  res.json({ posts: rows.map(mapPost) });
});

blogRouter.get("/posts/:project", async (req, res) => {
  const project = String(req.params.project || "").trim();
  const row = await get(
    `SELECT p.*, u.username AS author
     FROM blog_posts p
     LEFT JOIN users u ON u.id=p.author_user_id
     WHERE p.project=? OR p.id=?`,
    [project, Number(project) || 0]
  );
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.status !== "published") {
    return requireAuth(req, res, () =>
      requireRole(...BLOG_ROLES)(req, res, () => res.json(mapPost(row)))
    );
  }
  res.json(mapPost(row));
});

blogRouter.post("/posts", requireAuth, requireRole(...BLOG_ROLES), async (req, res) => {
  const title = String(req.body?.title || "").trim().slice(0, 140);
  const summary = String(req.body?.summary || "").trim().slice(0, 240) || null;
  const body = String(req.body?.body || "").trim().slice(0, 20000);
  const status = String(req.body?.status || "draft");
  const featured = req.body?.featured ? 1 : 0;

  if (!title || !body) {
    return res.status(400).json({ error: "missing_fields" });
  }
  const baseproject = projectify(req.body?.project || title);
  const project = await ensureUniqueproject(baseproject);
  const tags = normalizeTags(req.body?.tags);
  const now = Date.now();
  const publishedAt = status === "published" ? now : null;

  const result = await run(
    `INSERT INTO blog_posts(title, project, summary, body, tags_json, status, featured, author_user_id, created_at, updated_at, published_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [
      title,
      project,
      summary,
      body,
      JSON.stringify(tags),
      status,
      featured,
      req.user.uid,
      now,
      now,
      publishedAt
    ]
  );

  res.json({ ok: true, id: result.lastID, project });
});

blogRouter.put("/posts/:id", requireAuth, requireRole(...BLOG_ROLES), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid_id" });

  const row = await get("SELECT * FROM blog_posts WHERE id=?", [id]);
  if (!row) return res.status(404).json({ error: "not_found" });

  const title = req.body?.title != null ? String(req.body.title || "").trim().slice(0, 140) : row.title;
  const summary = req.body?.summary != null ? String(req.body.summary || "").trim().slice(0, 240) || null : row.summary;
  const body = req.body?.body != null ? String(req.body.body || "").trim().slice(0, 20000) : row.body;
  const status = req.body?.status != null ? String(req.body.status || "").trim() : row.status;
  const featured = req.body?.featured != null ? (req.body.featured ? 1 : 0) : row.featured;
  const tags = req.body?.tags != null ? normalizeTags(req.body.tags) : (row.tags_json ? JSON.parse(row.tags_json) : []);
  const publishedAt = status === "published" && !row.published_at ? Date.now() : row.published_at;
  const now = Date.now();

  await run(
    `UPDATE blog_posts
     SET title=?, summary=?, body=?, tags_json=?, status=?, featured=?, updated_at=?, published_at=?
     WHERE id=?`,
    [
      title,
      summary,
      body,
      JSON.stringify(tags),
      status,
      featured,
      now,
      publishedAt,
      id
    ]
  );

  res.json({ ok: true });
});

blogRouter.delete("/posts/:id", requireAuth, requireRole(...BLOG_ROLES), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid_id" });
  await run("DELETE FROM blog_posts WHERE id=?", [id]);
  res.json({ ok: true });
});
