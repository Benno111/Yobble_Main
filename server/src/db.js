import sqlite3 from "sqlite3";

/* -----------------------------
   DB connection
------------------------------ */
export const db = new sqlite3.Database("../save/db");

/* IMPORTANT: enable foreign keys */
db.serialize(() => {
  db.run("PRAGMA foreign_keys = ON");
});

/* -----------------------------
   DB helpers
------------------------------ */
export function run(sql, params = []) {
  return new Promise((ok, err) => {
    db.run(sql, params, function (e) {
      e ? err(e) : ok(this);
    });
  });
}

export function get(sql, params = []) {
  return new Promise((ok, err) => {
    db.get(sql, params, (e, row) => (e ? err(e) : ok(row)));
  });
}

export function all(sql, params = []) {
  return new Promise((ok, err) => {
    db.all(sql, params, (e, rows) => (e ? err(e) : ok(rows)));
  });
}

/* -----------------------------
   Object key helpers (API-level)
------------------------------ */

const DEFAULT_KEY_MAP = {
  slug: "project"
};

export function renameKeys(obj, keyMap = {}) {
  if (!obj) return obj;
  const map = { ...DEFAULT_KEY_MAP, ...keyMap };
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    out[map[key] ?? key] = value;
  }
  return out;
}

export function renameKeysBulk(rows, keyMap = {}) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => renameKeys(r, keyMap));
}

export function remapKeys(obj, rules = {}) {
  if (!obj) return obj;

  const out = {};
  const mergedRules = {
    slug: "project",
    ...rules
  };

  for (const [key, value] of Object.entries(obj)) {
    const rule = mergedRules[key];

    if (!rule) {
      out[key] = value;
      continue;
    }

    if (typeof rule === "string") {
      out[rule] = value;
      continue;
    }

    if (typeof rule === "function") {
      const res = rule(value, obj);
      if (Array.isArray(res)) {
        const [newKey, newValue] = res;
        out[newKey] = newValue;
      }
    }
  }

  return out;
}

/* -----------------------------
   Schema migration helpers
------------------------------ */
async function getColumns(table) {
  const rows = await all(`PRAGMA table_info(${table})`);
  return rows.map(r => r.name);
}

async function addColumnIfMissing(table, column, typeSql) {
  const cols = await getColumns(table);
  if (!cols.includes(column)) {
    console.log(`[DB] add column ${table}.${column}`);
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${typeSql}`);
  }
}

async function renameColumnIfExists(table, from, to) {
  const cols = await getColumns(table);
  if (cols.includes(from) && !cols.includes(to)) {
    console.log(`[DB] rename column ${table}.${from} -> ${to}`);
    await run(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  }
}

async function copyColumnData(table, from, to) {
  const cols = await getColumns(table);
  if (cols.includes(from) && cols.includes(to)) {
    console.log(`[DB] migrate data ${table}.${from} -> ${to}`);
    await run(`
      UPDATE ${table}
      SET ${to} = ${from}
      WHERE ${to} IS NULL AND ${from} IS NOT NULL
    `);
  }
}

/* -----------------------------
   Init & migrate schema
------------------------------ */
export async function initDb() {

  /* USERS */
  await run(`CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE,
    password_hash TEXT,
    role TEXT DEFAULT 'user'
  )`);
  await addColumnIfMissing("users", "is_banned", "INTEGER DEFAULT 0");
  await addColumnIfMissing("users", "ban_reason", "TEXT");
  await addColumnIfMissing("users", "banned_at", "INTEGER");
  await addColumnIfMissing("users", "timeout_until", "INTEGER");
  await addColumnIfMissing("users", "timeout_reason", "TEXT");
  await addColumnIfMissing("users", "wallet_address", "TEXT");
  await addColumnIfMissing("users", "wallet_connected_at", "INTEGER");
  await addColumnIfMissing("users", "wallet_label", "TEXT");
  await addColumnIfMissing("users", "platform_score", "INTEGER DEFAULT 0");
  await addColumnIfMissing("users", "totp_secret", "TEXT");
  await addColumnIfMissing("users", "totp_enabled", "INTEGER DEFAULT 0");

  /* GAMES */
  await run(`CREATE TABLE IF NOT EXISTS games(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    is_hidden INTEGER DEFAULT 0
  )`);

  /* 🔁 slug → project migration */
  await copyColumnData("games", "slug", "project");
  await renameColumnIfExists("games", "slug", "project");

  await addColumnIfMissing("games", "is_featured", "INTEGER DEFAULT 0");
  await addColumnIfMissing("games", "owner_user_id", "INTEGER");
  await addColumnIfMissing("games", "category", "TEXT");
  await addColumnIfMissing("games", "banner_path", "TEXT");
  await addColumnIfMissing("games", "screenshots_json", "TEXT");

  /* GAME VERSIONS */
  await run(`CREATE TABLE IF NOT EXISTS game_versions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    version TEXT NOT NULL,
    entry_html TEXT NOT NULL DEFAULT 'index.html',
    changelog TEXT,
    created_at INTEGER NOT NULL,
    is_published INTEGER NOT NULL DEFAULT 0,
    UNIQUE(game_id, version),
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
  )`);

  console.log("[DB] schema ready");
}
