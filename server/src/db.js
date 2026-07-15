import { DatabaseSync } from "node:sqlite";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SAVE_DIR = path.join(PROJECT_ROOT, "save");
const DB_PATH = path.join(SAVE_DIR, "db");
const GENERIC_SAVE_PATH = path.join(SAVE_DIR, "save.json");

function ensureSaveFolder() {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  if (!fs.existsSync(GENERIC_SAVE_PATH)) {
    fs.writeFileSync(
      GENERIC_SAVE_PATH,
      JSON.stringify({
        name: "Yobble Save",
        created_at: Date.now(),
        version: 1
      }, null, 2) + "\n"
    );
  }
}

ensureSaveFolder();

/* -----------------------------
   DB connection
------------------------------ */
export const db = new DatabaseSync(DB_PATH);

/* IMPORTANT: enable foreign keys */
db.exec("PRAGMA foreign_keys = ON");

/* -----------------------------
   DB helpers
------------------------------ */
export function run(sql, params = []) {
  const stmt = db.prepare(sql);
  const info = stmt.run(...params);
  return { lastID: Number(info.lastInsertRowid ?? 0), changes: Number(info.changes ?? 0) };
}

export function get(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.get(...params);
}

export function all(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.all(...params);
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

async function tableExists(table) {
  const row = await get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    [table]
  );
  return !!row;
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
  await addColumnIfMissing("users", "email", "TEXT");
  await addColumnIfMissing("users", "delete_requested_at", "INTEGER");
  await addColumnIfMissing("users", "delete_at", "INTEGER");
  await addColumnIfMissing("users", "deleted_at", "INTEGER");
  await addColumnIfMissing("users", "deleted_reason", "TEXT");

  /* BANS */
  await run(`CREATE TABLE IF NOT EXISTS bans(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    lifted_at INTEGER,
    lift_reason TEXT
  )`);
  await addColumnIfMissing("bans", "expires_at", "INTEGER");
  await addColumnIfMissing("bans", "lifted_at", "INTEGER");
  await addColumnIfMissing("bans", "lift_reason", "TEXT");

  await run(`CREATE TABLE IF NOT EXISTS ban_appeals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ban_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    message TEXT,
    created_at INTEGER NOT NULL,
    decided_by INTEGER,
    decided_at INTEGER,
    decision_note TEXT,
    FOREIGN KEY(ban_id) REFERENCES bans(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(decided_by) REFERENCES users(id) ON DELETE SET NULL
  )`);
  await addColumnIfMissing("ban_appeals", "decided_by", "INTEGER");
  await addColumnIfMissing("ban_appeals", "decided_at", "INTEGER");
  await addColumnIfMissing("ban_appeals", "decision_note", "TEXT");

  /* GIFT CODES */
  await run(`CREATE TABLE IF NOT EXISTS gift_codes(
    code TEXT PRIMARY KEY,
    amount INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    created_by INTEGER,
    redeemed_at INTEGER,
    redeemed_by INTEGER,
    expires_at INTEGER,
    FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(redeemed_by) REFERENCES users(id) ON DELETE SET NULL
  )`);
  await addColumnIfMissing("gift_codes", "created_by", "INTEGER");
  await addColumnIfMissing("gift_codes", "redeemed_at", "INTEGER");
  await addColumnIfMissing("gift_codes", "redeemed_by", "INTEGER");
  await addColumnIfMissing("gift_codes", "expires_at", "INTEGER");

  /* PROFILES */
  await run(`CREATE TABLE IF NOT EXISTS profiles(
    user_id INTEGER PRIMARY KEY,
    display_name TEXT,
    bio TEXT,
    avatar_url TEXT,
    status_text TEXT,
    theme TEXT,
    updated_at INTEGER,
    hair_color TEXT,
    hair_length TEXT,
    hair_type_back TEXT,
    hair_type_front TEXT,
    hair_type_left TEXT,
    hair_type_right TEXT,
    hair_variation TEXT,
    skin_tone TEXT,
    eyes TEXT,
    outfit TEXT,
    accessories TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await addColumnIfMissing("profiles", "display_name", "TEXT");
  await addColumnIfMissing("profiles", "bio", "TEXT");
  await addColumnIfMissing("profiles", "avatar_url", "TEXT");
  await addColumnIfMissing("profiles", "status_text", "TEXT");
  await addColumnIfMissing("profiles", "theme", "TEXT");
  await addColumnIfMissing("profiles", "updated_at", "INTEGER");
  await addColumnIfMissing("profiles", "hair_color", "TEXT");
  await addColumnIfMissing("profiles", "hair_length", "TEXT");
  await addColumnIfMissing("profiles", "hair_type_back", "TEXT");
  await addColumnIfMissing("profiles", "hair_type_front", "TEXT");
  await addColumnIfMissing("profiles", "hair_type_left", "TEXT");
  await addColumnIfMissing("profiles", "hair_type_right", "TEXT");
  await addColumnIfMissing("profiles", "hair_variation", "TEXT");
  await addColumnIfMissing("profiles", "skin_tone", "TEXT");
  await addColumnIfMissing("profiles", "eyes", "TEXT");
  await addColumnIfMissing("profiles", "outfit", "TEXT");
  await addColumnIfMissing("profiles", "accessories", "TEXT");

  /* GAMES */
  await run(`CREATE TABLE IF NOT EXISTS games(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    is_hidden INTEGER DEFAULT 0,
    custom_levels_enabled INTEGER DEFAULT 1
  )`);

  // Ensure project exists for older schemas before slug migration runs.
  await addColumnIfMissing("games", "project", "TEXT");

  /* 🔁 slug → project migration */
  await copyColumnData("games", "slug", "project");
  await renameColumnIfExists("games", "slug", "project");

  await addColumnIfMissing("games", "is_featured", "INTEGER DEFAULT 0");
  await addColumnIfMissing("games", "owner_user_id", "INTEGER");
  await addColumnIfMissing("games", "category", "TEXT");
  await addColumnIfMissing("games", "banner_path", "TEXT");
  await addColumnIfMissing("games", "screenshots_json", "TEXT");
  await addColumnIfMissing("games", "custom_levels_enabled", "INTEGER DEFAULT 1");
  await addColumnIfMissing("games", "created_at", "INTEGER");

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

  await run(`CREATE TABLE IF NOT EXISTS game_version_whitelist(
    game_id INTEGER NOT NULL,
    version TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    UNIQUE(game_id, version, user_id),
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  /* BLOG POSTS */
  await run(`CREATE TABLE IF NOT EXISTS blog_posts(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    project TEXT UNIQUE NOT NULL,
    summary TEXT,
    body TEXT NOT NULL,
    tags_json TEXT,
    status TEXT DEFAULT 'draft',
    featured INTEGER DEFAULT 0,
    author_user_id INTEGER,
    created_at INTEGER,
    updated_at INTEGER,
    published_at INTEGER
  )`);
  await addColumnIfMissing("blog_posts", "project", "TEXT");
  await copyColumnData("blog_posts", "slug", "project");
  await renameColumnIfExists("blog_posts", "slug", "project");

  /* GAME KV (storage sync) */
  await run(`CREATE TABLE IF NOT EXISTS game_kv(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    project TEXT NOT NULL,
    version TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, project, version, key)
  )`);
  await addColumnIfMissing("game_kv", "project", "TEXT");
  await copyColumnData("game_kv", "slug", "project");
  await renameColumnIfExists("game_kv", "slug", "project");

  /* ITEMS */
  await run(`CREATE TABLE IF NOT EXISTS items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL
  )`);
  await addColumnIfMissing("items", "description", "TEXT");
  await addColumnIfMissing("items", "icon_path", "TEXT");
  await addColumnIfMissing("items", "price", "INTEGER DEFAULT 0");
  await addColumnIfMissing("items", "approval_status", "TEXT DEFAULT 'pending'");
  await addColumnIfMissing("items", "uploaded_by", "INTEGER");
  await addColumnIfMissing("items", "approved_by", "INTEGER");
  await addColumnIfMissing("items", "approved_at", "INTEGER");
  await addColumnIfMissing("items", "rejected_reason", "TEXT");
  await addColumnIfMissing("items", "created_at", "INTEGER");
  await addColumnIfMissing("items", "ai_flag", "TEXT");

  await run(`CREATE TABLE IF NOT EXISTS inventory(
    user_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    UNIQUE(user_id, item_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS friends(
    user_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, friend_id),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(friend_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS wallets(
    user_id INTEGER PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await addColumnIfMissing("wallets", "updated_at", "INTEGER");

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
  await addColumnIfMissing("wallet_transactions", "ref_type", "TEXT");
  await addColumnIfMissing("wallet_transactions", "ref_id", "INTEGER");

  await run(`CREATE TABLE IF NOT EXISTS currency_transactions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    meta_json TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await addColumnIfMissing("currency_transactions", "meta_json", "TEXT");

  await run(`CREATE TABLE IF NOT EXISTS marketplace(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    price INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  await run(`CREATE TABLE IF NOT EXISTS marketplace_listings(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_user_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    price_each INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(seller_user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
  )`);
  await addColumnIfMissing("marketplace_listings", "status", "TEXT DEFAULT 'active'");
  await addColumnIfMissing("marketplace_listings", "updated_at", "INTEGER");

  await run(`CREATE TABLE IF NOT EXISTS marketplace_auto_stock(
    seller_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    qty_remaining INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE(seller_id, item_id),
    FOREIGN KEY(seller_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
  )`);

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
  await addColumnIfMissing("launcher_tokens", "used_at", "INTEGER");
  await addColumnIfMissing("launcher_tokens", "used_by", "TEXT");
  await addColumnIfMissing("launcher_tokens", "ip_hint", "TEXT");

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
  await addColumnIfMissing("game_reviews", "comment", "TEXT");
  await addColumnIfMissing("game_reviews", "updated_at", "INTEGER");

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
  await addColumnIfMissing("game_playtime", "sessions", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("game_playtime", "last_played", "INTEGER");

  await run(`CREATE TABLE IF NOT EXISTS user_library(
    user_id INTEGER NOT NULL,
    game_id INTEGER NOT NULL,
    added_at INTEGER NOT NULL,
    UNIQUE(user_id, game_id),
    FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS notifications(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT,
    title TEXT,
    body TEXT,
    link TEXT,
    is_read INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await addColumnIfMissing("notifications", "is_read", "INTEGER DEFAULT 0");

  await run(`CREATE TABLE IF NOT EXISTS reports(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL,
    target_type TEXT NOT NULL,
    target_ref TEXT NOT NULL,
    category TEXT,
    message TEXT NOT NULL,
    status TEXT DEFAULT 'open',
    created_at INTEGER NOT NULL,
    resolved_by INTEGER,
    resolved_at INTEGER,
    resolution_note TEXT,
    FOREIGN KEY(reporter_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(resolved_by) REFERENCES users(id) ON DELETE SET NULL
  )`);
  await addColumnIfMissing("reports", "status", "TEXT DEFAULT 'open'");
  await addColumnIfMissing("reports", "resolved_by", "INTEGER");
  await addColumnIfMissing("reports", "resolved_at", "INTEGER");
  await addColumnIfMissing("reports", "resolution_note", "TEXT");
  await addColumnIfMissing("reports", "ai_priority", "TEXT");
  await addColumnIfMissing("reports", "ai_action", "TEXT");
  await addColumnIfMissing("reports", "ai_note", "TEXT");
  await addColumnIfMissing("reports", "ai_reviewed_at", "INTEGER");

  await run(`CREATE TABLE IF NOT EXISTS report_evidence(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    filename TEXT,
    stored_path TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL,
    FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS stats(
    user_id INTEGER PRIMARY KEY,
    playtime_seconds INTEGER NOT NULL DEFAULT 0,
    matches_played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await addColumnIfMissing("stats", "matches_played", "INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("stats", "wins", "INTEGER NOT NULL DEFAULT 0");

  await run(`CREATE TABLE IF NOT EXISTS game_editor_projects(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS trades(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user INTEGER NOT NULL,
    to_user INTEGER NOT NULL,
    from_currency INTEGER NOT NULL DEFAULT 0,
    to_currency INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    FOREIGN KEY(from_user) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(to_user) REFERENCES users(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS trade_items(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    FOREIGN KEY(trade_id) REFERENCES trades(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS trade_offers(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER
  )`);

  await run(`CREATE TABLE IF NOT EXISTS support_tickets(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number TEXT UNIQUE NOT NULL,
    user_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'open',
    assigned_to INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    closed_at INTEGER,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY(assigned_to) REFERENCES users(id) ON DELETE SET NULL
  )`);
  await addColumnIfMissing("support_tickets", "assigned_to", "INTEGER");
  await addColumnIfMissing("support_tickets", "updated_at", "INTEGER");
  await addColumnIfMissing("support_tickets", "closed_at", "INTEGER");

  await run(`CREATE TABLE IF NOT EXISTS support_messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    is_staff_reply INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  await addColumnIfMissing("support_messages", "is_staff_reply", "INTEGER DEFAULT 0");

  // Remove legacy items without uploader info (and any related records).
  await run("DELETE FROM items WHERE uploaded_by IS NULL");
  if (await tableExists("inventory")) {
    await run("DELETE FROM inventory WHERE item_id NOT IN (SELECT id FROM items)");
  }
  if (await tableExists("marketplace")) {
    await run("DELETE FROM marketplace WHERE item_id NOT IN (SELECT id FROM items)");
  }
  if (await tableExists("marketplace_listings")) {
    await run("DELETE FROM marketplace_listings WHERE item_id NOT IN (SELECT id FROM items)");
  }
  if (await tableExists("marketplace_auto_stock")) {
    await run("DELETE FROM marketplace_auto_stock WHERE item_id NOT IN (SELECT id FROM items)");
  }

  /* CHAT */
  if (await tableExists("chat_channels")) {
    const cols = await getColumns("chat_channels");
    if (!cols.includes("channel_uuid")) {
      console.log("[DB] migrate chat_channels to channel_uuid");
      await run(`CREATE TABLE IF NOT EXISTS chat_channels_new(
        channel_uuid TEXT PRIMARY KEY,
        name TEXT,
        is_dm INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        created_by TEXT
      )`);

      const rows = await all("SELECT id, name, is_dm, created_at, created_by FROM chat_channels");
      const idMap = new Map();
      for (const row of rows) {
        const channelUuid = crypto.randomUUID();
        idMap.set(row.id, channelUuid);
        await run(
          `INSERT INTO chat_channels_new (channel_uuid, name, is_dm, created_at, created_by)
           VALUES (?, ?, ?, ?, ?)`,
          [channelUuid, row.name, row.is_dm || 0, row.created_at || Date.now(), row.created_by || null]
        );
      }

      await run(`CREATE TABLE IF NOT EXISTS chat_channel_members_new(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_uuid TEXT NOT NULL,
        username TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        UNIQUE(channel_uuid, username),
        FOREIGN KEY(channel_uuid) REFERENCES chat_channels_new(channel_uuid) ON DELETE CASCADE
      )`);

      if (await tableExists("chat_channel_members")) {
        const memberRows = await all(
          "SELECT channel_id, username, added_at FROM chat_channel_members"
        );
        for (const row of memberRows) {
          const channelUuid = idMap.get(row.channel_id);
          if (!channelUuid) continue;
          await run(
            `INSERT OR IGNORE INTO chat_channel_members_new
             (channel_uuid, username, added_at) VALUES (?, ?, ?)`,
            [channelUuid, row.username, row.added_at || Date.now()]
          );
        }
      }

      if (await tableExists("chat_messages")) {
        await addColumnIfMissing("chat_messages", "channel_uuid", "TEXT");
        await run(`
          UPDATE chat_messages
          SET channel_uuid = (
            SELECT channel_uuid FROM chat_channels_new
            WHERE chat_channels_new.name = chat_messages.channel
            LIMIT 1
          )
          WHERE channel_uuid IS NULL
        `);
      }

      await run("DROP TABLE chat_channels");
      if (await tableExists("chat_channel_members")) {
        await run("DROP TABLE chat_channel_members");
      }
      await run("ALTER TABLE chat_channels_new RENAME TO chat_channels");
      await run("ALTER TABLE chat_channel_members_new RENAME TO chat_channel_members");
    }
  }

  await run(`CREATE TABLE IF NOT EXISTS chat_channels(
    channel_uuid TEXT PRIMARY KEY,
    name TEXT,
    is_dm INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    created_by TEXT
  )`);

  await run(
    "DELETE FROM chat_channels WHERE is_dm = 0 AND name IN ('general','rules','announcements','offtopic')"
  );

  await run(`CREATE TABLE IF NOT EXISTS chat_channel_members(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_uuid TEXT NOT NULL,
    username TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    UNIQUE(channel_uuid, username),
    FOREIGN KEY(channel_uuid) REFERENCES chat_channels(channel_uuid) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS chat_messages(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_uuid TEXT,
    channel TEXT,
    user TEXT NOT NULL,
    text TEXT,
    ts INTEGER NOT NULL,
    deleted INTEGER DEFAULT 0
  )`);

  await addColumnIfMissing("chat_messages", "channel_uuid", "TEXT");

  await run(`CREATE TABLE IF NOT EXISTS chat_invites(
    token TEXT PRIMARY KEY,
    channel_uuid TEXT NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    FOREIGN KEY(channel_uuid) REFERENCES chat_channels(channel_uuid) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS chat_attachments(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    stored_name TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT,
    size INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
  )`);

  await run(`CREATE TABLE IF NOT EXISTS changelog_entries(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT,
    status TEXT DEFAULT 'published',
    updated_at INTEGER
  )`);
  await addColumnIfMissing("changelog_entries", "status", "TEXT DEFAULT 'published'");
  await addColumnIfMissing("changelog_entries", "updated_at", "INTEGER");

  await run(`CREATE TABLE IF NOT EXISTS roadmap_entries(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT,
    status TEXT DEFAULT 'published',
    updated_at INTEGER,
    sort_order INTEGER DEFAULT 0
  )`);
  await addColumnIfMissing("roadmap_entries", "status", "TEXT DEFAULT 'published'");
  await addColumnIfMissing("roadmap_entries", "updated_at", "INTEGER");
  await addColumnIfMissing("roadmap_entries", "sort_order", "INTEGER DEFAULT 0");

  await run(`CREATE TABLE IF NOT EXISTS ai_mod_settings(
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER NOT NULL,
    updated_by INTEGER,
    FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL
  )`);
  await addColumnIfMissing("ai_mod_settings", "updated_by", "INTEGER");

  await run(`CREATE TABLE IF NOT EXISTS ai_mod_dependencies(
    name TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'service',
    status TEXT NOT NULL DEFAULT 'unknown',
    version TEXT,
    details TEXT,
    updated_at INTEGER NOT NULL
  )`);
  await addColumnIfMissing("ai_mod_dependencies", "kind", "TEXT NOT NULL DEFAULT 'service'");
  await addColumnIfMissing("ai_mod_dependencies", "status", "TEXT NOT NULL DEFAULT 'unknown'");
  await addColumnIfMissing("ai_mod_dependencies", "version", "TEXT");
  await addColumnIfMissing("ai_mod_dependencies", "details", "TEXT");
  await addColumnIfMissing("ai_mod_dependencies", "updated_at", "INTEGER");

  console.log("[DB] schema ready");
}
