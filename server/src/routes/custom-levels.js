import express from "express";
import path from "path";
import fs from "fs";
import sqlite3 from "sqlite3";
import { requireAuth, optionalAuth } from "../auth.js";
import { get, run } from "../db.js";

export const customLevelsRouter = express.Router();

customLevelsRouter.use(express.json({ limit: "12mb" }));

const SERVER_DIR = path.resolve(process.cwd());
const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
const LEVEL_DB_DIR = path.join(PROJECT_ROOT, "save", "custom_levels");
fs.mkdirSync(LEVEL_DB_DIR, { recursive: true });

const dbCache = new Map();
const dbInitCache = new Map();

function getLevelDb(project) {
  const safeproject = String(project || "").replace(/[^a-z0-9-_]+/gi, "");
  const dbPath = path.join(LEVEL_DB_DIR, `${safeproject}.sqlite`);
  if (dbCache.has(dbPath)) return dbCache.get(dbPath);
  const db = new sqlite3.Database(dbPath);
  dbCache.set(dbPath, db);
  return db;
}

function getLevelDbKey(project) {
  const safeproject = String(project || "").replace(/[^a-z0-9-_]+/gi, "");
  return path.join(LEVEL_DB_DIR, `${safeproject}.sqlite`);
}

async function ensureLevelTable(db, dbKey) {
  if (!dbKey) return;
  if (dbInitCache.has(dbKey)) {
    await dbInitCache.get(dbKey);
    return;
  }
  const initPromise = dbRun(
    db,
    `CREATE TABLE IF NOT EXISTS levels(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      description TEXT,
      raw_data TEXT NOT NULL,
      uploader_user_id INTEGER NOT NULL,
      uploader_username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      difficulty INTEGER,
      difficulty_set_by INTEGER,
      difficulty_set_at INTEGER,
      difficulty_awarded INTEGER DEFAULT 0
    )`
  );
  dbInitCache.set(dbKey, initPromise);
  await initPromise;
}

function dbRun(db, sql, params = []) {
  return new Promise((ok, err) => {
    db.run(sql, params, function (e) {
      e ? err(e) : ok(this);
    });
  });
}

function dbGet(db, sql, params = []) {
  return new Promise((ok, err) => {
    db.get(sql, params, (e, row) => (e ? err(e) : ok(row)));
  });
}

function dbAll(db, sql, params = []) {
  return new Promise((ok, err) => {
    db.all(sql, params, (e, rows) => (e ? err(e) : ok(rows)));
  });
}

function clampDifficulty(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < 1 || i > 10) return null;
  return i;
}

async function requireGame(project) {
  const g = await get(
    "SELECT id, owner_user_id, custom_levels_enabled FROM games WHERE project=?",
    [project]
  );
  return g;
}

function isPrivileged(user) {
  return user?.role === "admin" || user?.role === "moderator";
}

function canUseCustomLevels(game, user) {
  if (!game) return false;
  if (game.custom_levels_enabled === 1) return true;
  const isOwner = user && game.owner_user_id === user.uid;
  return isOwner || isPrivileged(user);
}

customLevelsRouter.post("/:project/upload", requireAuth, async (req, res) => {
  const project = String(req.params.project || "").trim();
  const title = String(req.body?.title || "").trim();
  const version = String(req.body?.version || "").trim();
  const description = String(req.body?.description || "").trim();
  const raw_data = String(req.body?.raw_data || "");

  if (!project || !title || !version || !raw_data) {
    return res.status(400).json({ error: "missing_fields" });
  }
  if (raw_data.length > 10 * 1024 * 1024) {
    return res.status(413).json({ error: "payload_too_large" });
  }

  const game = await requireGame(project);
  if (!game) return res.status(404).json({ error: "game_not_found" });
  if (!canUseCustomLevels(game, req.user)) {
    return res.status(403).json({ error: "custom_levels_disabled" });
  }

  const db = getLevelDb(project);
  await ensureLevelTable(db, getLevelDbKey(project));
  const now = Date.now();
  const existing = await dbGet(
    db,
    `SELECT id FROM levels WHERE uploader_user_id=? AND title=? LIMIT 1`,
    [req.user.uid, title]
  );

  if (existing?.id) {
    await dbRun(
      db,
      `UPDATE levels
       SET version=?, description=?, raw_data=?, updated_at=?
       WHERE id=?`,
      [version, description, raw_data, now, existing.id]
    );
    return res.json({ ok: true, id: existing.id, replaced: true });
  }

  const result = await dbRun(
    db,
    `INSERT INTO levels(title, version, description, raw_data, uploader_user_id, uploader_username, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    [
      title,
      version,
      description,
      raw_data,
      req.user.uid,
      req.user.username,
      now,
      now
    ]
  );

  res.json({ ok: true, id: result.lastID, replaced: false });
});

customLevelsRouter.put("/:project/update/:id", requireAuth, async (req, res) => {
  const project = String(req.params.project || "").trim();
  const id = Number(req.params.id);
  const title = String(req.body?.title || "").trim();
  const version = String(req.body?.version || "").trim();
  const description = String(req.body?.description || "").trim();
  const raw_data = String(req.body?.raw_data || "");

  if (!project || !Number.isFinite(id)) {
    return res.status(400).json({ error: "missing_fields" });
  }
  if (!title || !version || !raw_data) {
    return res.status(400).json({ error: "missing_fields" });
  }
  if (raw_data.length > 10 * 1024 * 1024) {
    return res.status(413).json({ error: "payload_too_large" });
  }

  const game = await requireGame(project);
  if (!game) return res.status(404).json({ error: "game_not_found" });
  if (!canUseCustomLevels(game, req.user)) {
    return res.status(403).json({ error: "custom_levels_disabled" });
  }

  const db = getLevelDb(project);
  await ensureLevelTable(db, getLevelDbKey(project));
  const existing = await dbGet(db, "SELECT * FROM levels WHERE id=?", [id]);
  if (!existing) return res.status(404).json({ error: "level_not_found" });

  const isOwner = game.owner_user_id === req.user.uid;
  if (
    existing.uploader_user_id !== req.user.uid &&
    !isOwner &&
    !isPrivileged(req.user)
  ) {
    return res.status(403).json({ error: "forbidden" });
  }

  const now = Date.now();
  await dbRun(
    db,
    `UPDATE levels
     SET title=?, version=?, description=?, raw_data=?, updated_at=?
     WHERE id=?`,
    [title, version, description, raw_data, now, id]
  );

  res.json({ ok: true });
});

customLevelsRouter.post("/:project/difficulty/:id", requireAuth, async (req, res) => {
  const project = String(req.params.project || "").trim();
  const id = Number(req.params.id);
  const difficulty = clampDifficulty(req.body?.difficulty);
  if (!project || !Number.isFinite(id) || difficulty == null) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const game = await requireGame(project);
  if (!game) return res.status(404).json({ error: "game_not_found" });
  if (!canUseCustomLevels(game, req.user)) {
    return res.status(403).json({ error: "custom_levels_disabled" });
  }

  const isOwner = game.owner_user_id === req.user.uid;
  if (!isOwner && !isPrivileged(req.user)) {
    return res.status(403).json({ error: "forbidden" });
  }

  const db = getLevelDb(project);
  await ensureLevelTable(db, getLevelDbKey(project));
  const existing = await dbGet(db, "SELECT * FROM levels WHERE id=?", [id]);
  if (!existing) return res.status(404).json({ error: "level_not_found" });

  const previous = Number(existing.difficulty || 0);
  const delta = difficulty - previous;
  const now = Date.now();

  await dbRun(
    db,
    `UPDATE levels
     SET difficulty=?, difficulty_set_by=?, difficulty_set_at=?, difficulty_awarded=difficulty_awarded + ?
     WHERE id=?`,
    [difficulty, req.user.uid, now, delta, id]
  );

  if (delta !== 0) {
    await run(
      `UPDATE users
       SET platform_score = COALESCE(platform_score, 0) + ?
       WHERE id=?`,
      [delta, existing.uploader_user_id]
    );
  }

  res.json({ ok: true, awarded: delta });
});

customLevelsRouter.get("/:project/download/:id", optionalAuth, async (req, res) => {
  const project = String(req.params.project || "").trim();
  const id = Number(req.params.id);
  if (!project || !Number.isFinite(id)) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const game = await requireGame(project);
  if (!game) return res.status(404).json({ error: "game_not_found" });
  if (!canUseCustomLevels(game, req.user)) {
    return res.status(403).json({ error: "custom_levels_disabled" });
  }

  const db = getLevelDb(project);
  await ensureLevelTable(db, getLevelDbKey(project));
  const row = await dbGet(
    db,
    `SELECT id, title, version, description, raw_data, uploader_username, created_at, updated_at, difficulty
     FROM levels WHERE id=?`,
    [id]
  );
  if (!row) return res.status(404).json({ error: "level_not_found" });
  res.json({ level: row });
});

customLevelsRouter.delete("/:project/delete/:id", requireAuth, async (req, res) => {
  const project = String(req.params.project || "").trim();
  const id = Number(req.params.id);
  if (!project || !Number.isFinite(id)) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const game = await requireGame(project);
  if (!game) return res.status(404).json({ error: "game_not_found" });
  if (!canUseCustomLevels(game, req.user)) {
    return res.status(403).json({ error: "custom_levels_disabled" });
  }

  const db = getLevelDb(project);
  await ensureLevelTable(db, getLevelDbKey(project));
  const existing = await dbGet(db, "SELECT * FROM levels WHERE id=?", [id]);
  if (!existing) return res.status(404).json({ error: "level_not_found" });

  const isOwner = game.owner_user_id === req.user.uid;
  if (existing.uploader_user_id !== req.user.uid && !isOwner && !isPrivileged(req.user)) {
    return res.status(403).json({ error: "forbidden" });
  }

  await dbRun(db, "DELETE FROM levels WHERE id=?", [id]);
  res.json({ ok: true });
});

customLevelsRouter.get("/:project/list", optionalAuth, async (req, res) => {
  const project = String(req.params.project || "").trim();
  if (!project) return res.status(400).json({ error: "missing_project" });

  const game = await requireGame(project);
  if (!game) return res.status(404).json({ error: "game_not_found" });
  if (!canUseCustomLevels(game, req.user)) {
    return res.status(403).json({ error: "custom_levels_disabled" });
  }

  const db = getLevelDb(project);
  await ensureLevelTable(db, getLevelDbKey(project));
  const rows = await dbAll(
    db,
    `SELECT id, title, version, description, uploader_username, created_at, updated_at, difficulty
     FROM levels
     ORDER BY updated_at DESC
     LIMIT 200`
  );
  res.json({ levels: rows });
});

customLevelsRouter.get("/:project/search", optionalAuth, async (req, res) => {
  const project = String(req.params.project || "").trim();
  const q = String(req.query?.q || "").trim();
  const creator = String(req.query?.creator || "").trim();
  const difficulty = clampDifficulty(req.query?.difficulty);
  if (!project) return res.status(400).json({ error: "missing_project" });

  const game = await requireGame(project);
  if (!game) return res.status(404).json({ error: "game_not_found" });
  if (!canUseCustomLevels(game, req.user)) {
    return res.status(403).json({ error: "custom_levels_disabled" });
  }

  const db = getLevelDb(project);
  await ensureLevelTable(db, getLevelDbKey(project));
  const where = [];
  const params = [];
  if (q) {
    where.push("(title LIKE ? OR description LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like);
  }
  if (creator) {
    where.push("uploader_username LIKE ?");
    params.push(`%${creator}%`);
  }
  if (difficulty != null) {
    where.push("difficulty = ?");
    params.push(difficulty);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = await dbAll(
    db,
    `SELECT id, title, version, description, uploader_username, created_at, updated_at, difficulty
     FROM levels
     ${clause}
     ORDER BY updated_at DESC
     LIMIT 200`,
    params
  );
  res.json({ levels: rows });
});
