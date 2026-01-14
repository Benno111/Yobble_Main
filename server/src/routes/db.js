import sqlite3 from "sqlite3";

export const db = new sqlite3.Database("benno111engene.sqlite");

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

  /* GAMES */
  await run(`CREATE TABLE IF NOT EXISTS games(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    is_hidden INTEGER DEFAULT 0
  )`);
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
  await addColumnIfMissing("game_versions", "approval_status", "TEXT DEFAULT 'pending'");
  await addColumnIfMissing("game_versions", "approved_by", "INTEGER");
  await addColumnIfMissing("game_versions", "approved_at", "INTEGER");
  await addColumnIfMissing("game_versions", "rejected_reason", "TEXT");

  /* UPLOAD HISTORY */
  await run(`CREATE TABLE IF NOT EXISTS game_uploads(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uploader_user_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    version TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(uploader_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE
  )`);
  await run(
    `UPDATE games
     SET owner_user_id = (
       SELECT uploader_user_id
       FROM game_uploads gu
       WHERE gu.game_id = games.id
       ORDER BY gu.created_at ASC
       LIMIT 1
     )
     WHERE owner_user_id IS NULL`
  );

  /* ITEMS */
  await run(`CREATE TABLE IF NOT EXISTS items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL
  )`);

  /* ---- Item moderation & metadata ---- */
  await addColumnIfMissing("items", "description", "TEXT");
  await addColumnIfMissing("items", "icon_path", "TEXT");
  await addColumnIfMissing("items", "approval_status", "TEXT DEFAULT 'pending'");
  await addColumnIfMissing("items", "uploaded_by", "INTEGER");
  await addColumnIfMissing("items", "approved_by", "INTEGER");
  await addColumnIfMissing("items", "approved_at", "INTEGER");
  await addColumnIfMissing("items", "rejected_reason", "TEXT");
  await addColumnIfMissing("items", "created_at", "INTEGER");

  /* INVENTORY */
  await run(`CREATE TABLE IF NOT EXISTS inventory(
    user_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    UNIQUE(user_id, item_id)
  )`);

  /* FRIENDS */
  await run(`CREATE TABLE IF NOT EXISTS friends(
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, friend_id)
  )`);

  /* WALLETS */
  await run(`CREATE TABLE IF NOT EXISTS wallets(
    user_id INTEGER PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await run(`CREATE TABLE IF NOT EXISTS wallet_transactions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    ref_type TEXT,
    ref_id INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  /* MARKETPLACE */
  await run(`CREATE TABLE IF NOT EXISTS marketplace(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    price INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  /* LAUNCHER TOKENS */
  await run(`CREATE TABLE IF NOT EXISTS launcher_tokens(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    game_project TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT,
    ip_hint TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  /* REVIEWS */
  await run(`CREATE TABLE IF NOT EXISTS game_reviews(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    rating INTEGER NOT NULL,
    comment TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(game_id, user_id),
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  /* PLAYTIME */
  await run(`CREATE TABLE IF NOT EXISTS game_playtime(
    user_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    playtime_ms INTEGER NOT NULL DEFAULT 0,
    sessions INTEGER NOT NULL DEFAULT 0,
    last_played INTEGER,
    UNIQUE(user_id, game_id),
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  /* LIBRARY */
  await run(`CREATE TABLE IF NOT EXISTS user_library(
    user_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    UNIQUE(user_id, game_id),
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  console.log("[DB] schema ready");
}
