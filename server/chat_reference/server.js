const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const crypto = require("crypto");
const multer = require("multer");
const net = require("net");
const nodemailer = require("nodemailer");

const uuidv4 = () => crypto.randomUUID();
const app = express();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) || 3000 : 3000;
const DB_FILE = "chat.db";
const DF_LEVELS_DIR = path.join(__dirname, "df", "levels");
const DF_LEVELS_DB_FILE = path.join(DF_LEVELS_DIR, "levels.db");
const MOD_USERS = new Set(["admin", "Benno111"]);
const FAVICON_PATH = path.join(__dirname, "favicon.ico");
const UPLOAD_DIR = path.join(__dirname, "uploads");

const RATE_LIMIT_WINDOW_MS = 15 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const RATE_LIMIT_MAX_MSGS = 40;
const PASSWORD_RESET_TTL_MS = 15 * 60 * 1000;
const LINK_PREVIEW_TIMEOUT_MS = 5000;
const LINK_PREVIEW_MAX_BYTES = 150 * 1024;
const LINK_PREVIEW_MAX_REDIRECTS = 3;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_USERNAME_LENGTH = 32;
const MAX_REASON_LENGTH = 500;
const APP_LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
const APP_LOGIN_CODES_PER_USER = 3;
const DF_MAX_NAME_LENGTH = 120;
const DF_MAX_TAGS_LENGTH = 200;
const DF_MAX_DESC_LENGTH = 600;
const ipBuckets = new Map();
let wss = null;
let wsPingInterval = null;
const sessions = new Map();
const loginChallenges = new Map();
const appLoginCodes = new Map();
let mailTransport = null;
let mailConfigLoaded = false;
let mailConfig = null;
const mutedUntil = new Map();
const bannedUsers = new Set();
const bannedReasons = new Map();

function isValidEmail(email) {
  return typeof email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
}

function deleteSessionsFromDb(tokens) {
  if (!Array.isArray(tokens) || !tokens.length) return;
  const placeholders = tokens.map(() => "?").join(",");
  db.run(`DELETE FROM sessions WHERE token IN (${placeholders})`, tokens, (err) => {
    if (err) console.error("Failed to delete sessions:", err);
  });
}

function safeReason(reason) {
  const text = typeof reason === "string" ? reason.trim() : "";
  return text.slice(0, MAX_REASON_LENGTH) || "[no reason]";
}

function usernameTooLong(name) {
  return typeof name !== "string" || name.length > MAX_USERNAME_LENGTH;
}

function persistSession(token, username) {
  const created = Date.now();
  db.run(
    "INSERT OR REPLACE INTO sessions (token, username, created) VALUES (?, ?, ?)",
    [token, username, created],
    (err) => {
      if (err) console.error("Failed to persist session:", err);
    }
  );
}

function invalidateUserSessions(username) {
  const tokensToRemove = [];
  for (const [token, name] of sessions.entries()) {
    if (name === username) {
      tokensToRemove.push(token);
      sessions.delete(token);
    }
  }
  deleteSessionsFromDb(tokensToRemove);
}

function revokeSessionToken(token) {
  if (!token) return null;
  const user = sessions.get(token);
  sessions.delete(token);
  deleteSessionsFromDb([token]);
  return user || null;
}

function disconnectUserSockets(username, reason = "Account banned", code = 4003) {
  if (!wss) return;
  wss.clients.forEach((client) => {
    if (
      client.readyState === WebSocket.OPEN &&
      client.username === username
    ) {
      try {
        client.close(code, reason);
      } catch (_) {
        // ignore close errors
      }
    }
  });
}

function getIpFromReq(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function checkHttpRateLimit(req, res) {
  const ip = getIpFromReq(req);
  let bucket = ipBuckets.get(ip);
  const now = Date.now();
  if (!bucket) {
    bucket = {
      http: { count: 0, reset: now + RATE_LIMIT_WINDOW_MS },
      ws: { count: 0, reset: now + RATE_LIMIT_WINDOW_MS },
    };
    ipBuckets.set(ip, bucket);
  }
  if (now > bucket.http.reset) {
    bucket.http.count = 0;
    bucket.http.reset = now + RATE_LIMIT_WINDOW_MS;
  }
  bucket.http.count++;
  if (bucket.http.count > RATE_LIMIT_MAX_REQUESTS) {
    res.status(429).json({ error: "Too many requests, slow down." });
    return false;
  }
  return true;
}

function checkWsRateLimit(ws) {
  const ip = ws._socket?.remoteAddress || ws.ip || "unknown";
  let bucket = ipBuckets.get(ip);
  const now = Date.now();
  if (!bucket) {
    bucket = {
      http: { count: 0, reset: now + RATE_LIMIT_WINDOW_MS },
      ws: { count: 0, reset: now + RATE_LIMIT_WINDOW_MS },
    };
    ipBuckets.set(ip, bucket);
  }
  if (now > bucket.ws.reset) {
    bucket.ws.count = 0;
    bucket.ws.reset = now + RATE_LIMIT_WINDOW_MS;
  }
  bucket.ws.count++;
  if (bucket.ws.count > RATE_LIMIT_MAX_MSGS) {
    // Soft block: drop the message but keep the connection alive
    return false;
  }
  return true;
}

function isPrivateIPv4(host) {
  const parts = host.split(".").map((n) => parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  return false;
}

function isBlockedPreviewHost(hostname) {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();
  if (["localhost", "0.0.0.0", "127.0.0.1", "::1"].includes(lower)) {
    return true;
  }
  const ipVersion = net.isIP(hostname);
  if (ipVersion === 6) return true;
  if (ipVersion === 4 && isPrivateIPv4(hostname)) return true;
  return false;
}

function normalizePreviewUrl(raw) {
  if (!raw || typeof raw !== "string") return "";
  let working = raw.trim();
  if (!working) return "";
  if (!/^https?:\/\//i.test(working)) {
    working = "https://" + working;
  }
  try {
    const parsed = new URL(working);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch (err) {
    return "";
  }
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return str.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity.startsWith("#")) {
      const base = entity[1]?.toLowerCase() === "x" ? 16 : 10;
      const num = parseInt(entity.slice(base === 16 ? 2 : 1), base);
      if (!Number.isNaN(num)) {
        return String.fromCharCode(num);
      }
      return match;
    }
    const key = entity.toLowerCase();
    return named[key] ?? match;
  });
}

function extractTitleFromHtml(html) {
  if (!html) return "";
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim().slice(0, 160);
}

function collectIconCandidatesFromHtml(html, baseUrl) {
  const results = [];
  if (!html) return results;
  const relPattern =
    /(^|\s)(icon|shortcut icon|apple-touch-icon|mask-icon)(\s|$)/i;
  const linkRegex = /<link\b[^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const tag = match[0];
    const relMatch = tag.match(/rel=["']([^"']+)["']/i);
    if (!relMatch || !relPattern.test(relMatch[1])) continue;
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch || !hrefMatch[1]) continue;
    try {
      results.push(new URL(hrefMatch[1], baseUrl).toString());
    } catch (_) {
      continue;
    }
  }

  const metaRegex = /<meta\b[^>]+>/gi;
  const metaTargets = ["og:image", "twitter:image", "msapplication-tileimage"];
  while ((match = metaRegex.exec(html)) !== null) {
    const tag = match[0];
    const nameMatch = tag.match(
      /(property|name)=["']([^"']+)["']/i
    );
    if (!nameMatch) continue;
    const prop = nameMatch[2].toLowerCase();
    if (metaTargets.indexOf(prop) === -1) continue;
    const contentMatch = tag.match(/content=["']([^"']+)["']/i);
    if (!contentMatch || !contentMatch[1]) continue;
    try {
      results.push(new URL(contentMatch[1], baseUrl).toString());
    } catch (_) {
      continue;
    }
  }
  return results;
}

function extractFaviconFromHtml(html, baseUrl) {
  if (!html) return [];
  return collectIconCandidatesFromHtml(html, baseUrl);
}

function extractManifestLinks(html, baseUrl) {
  if (!html) return [];
  const links = [];
  const manifestRegex = /<link\b[^>]*rel=["'][^"']*manifest[^"']*["'][^>]*>/gi;
  let match;
  while ((match = manifestRegex.exec(html)) !== null) {
    const tag = match[0];
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch || !hrefMatch[1]) continue;
    try {
      links.push(new URL(hrefMatch[1], baseUrl).toString());
    } catch (_) {
      continue;
    }
  }
  return links;
}

async function resolveIconFromManifest(html, baseUrl) {
  const manifestLinks = extractManifestLinks(html, baseUrl);
  for (const manifestUrl of manifestLinks) {
    try {
      const manifestText = await fetchLinkPreviewSource(
        manifestUrl,
        LINK_PREVIEW_MAX_REDIRECTS,
        {
          accept: "application/json,text/plain;q=0.8",
          maxBytes: 80 * 1024,
        }
      );
      const manifest = JSON.parse(manifestText);
      if (!manifest || !Array.isArray(manifest.icons)) continue;
      for (const icon of manifest.icons) {
        if (!icon || !icon.src) continue;
        try {
          const candidate = new URL(icon.src, manifestUrl).toString();
          const confirmed = await confirmFaviconUrl(candidate);
          if (confirmed) return confirmed;
        } catch (_) {
          continue;
        }
      }
    } catch (_) {
      continue;
    }
  }
  return "";
}

async function resolveFaviconFromHtml(html, baseUrl) {
  if (!baseUrl) return "";
  const effectiveBase = resolveHtmlBase(baseUrl, html);
  if (!effectiveBase) return "";
  const direct = extractFaviconFromHtml(html, effectiveBase);
  for (const candidate of direct) {
    const confirmed = await confirmFaviconUrl(candidate);
    if (confirmed) return confirmed;
  }
  const manifestIcon = await resolveIconFromManifest(html, effectiveBase);
  if (manifestIcon) return manifestIcon;
  const fallbackPaths = [
    "/favicon.ico",
    "/favicon.png",
    "/apple-touch-icon.png",
    "/favicon-32x32.png",
    "/favicon-16x16.png",
  ];
  for (const pathSuffix of fallbackPaths) {
    try {
      const candidate = new URL(pathSuffix, effectiveBase.origin).toString();
      const confirmed = await confirmFaviconUrl(candidate);
      if (confirmed) return confirmed;
    } catch (_) {
      continue;
    }
  }
  return "";
}

async function confirmFaviconUrl(url) {
  try {
    await fetchLinkPreviewSource(url, LINK_PREVIEW_MAX_REDIRECTS, {
      accept: "image/*,*/*;q=0.8",
      maxBytes: 80 * 1024,
      method: "GET",
    });
    return url;
  } catch (_) {
    return "";
  }
}

function resolveHtmlBase(baseUrl, html) {
  if (!baseUrl) return null;
  const baseMatch = html?.match(/<base[^>]+href=["']([^"']+)["']/i);
  if (baseMatch && baseMatch[1]) {
    try {
      return new URL(baseMatch[1], baseUrl);
    } catch (_) {
      return baseUrl;
    }
  }
  return baseUrl;
}

function fetchLinkPreviewSource(
  urlStr,
  redirectsLeft = LINK_PREVIEW_MAX_REDIRECTS,
  options = {}
) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }
    const client = parsedUrl.protocol === "http:" ? http : https;
    const acceptHeader =
      options.accept || "text/html,application/xhtml+xml;q=0.9";
    const maxBytes = options.maxBytes || LINK_PREVIEW_MAX_BYTES;
    const method = options.method || "GET";
    const requestOptions = {
      method,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "http:" ? 80 : 443),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        "User-Agent": "Benno111ChatLinkPreview/1.0",
        Accept: acceptHeader,
      },
    };
    const request = client.request(requestOptions, (response) => {
      const status = response.statusCode || 0;
      if (
        status >= 300 &&
        status < 400 &&
        response.headers.location &&
        redirectsLeft > 0
      ) {
        const nextUrl = new URL(response.headers.location, urlStr).toString();
        response.resume();
        fetchLinkPreviewSource(nextUrl, redirectsLeft - 1)
          .then(resolve)
          .catch(reject);
        return;
      }
      if (status >= 400) {
        response.resume();
        reject(new Error("Status " + status));
        return;
      }
      if (method === "HEAD") {
        response.resume();
        resolve("");
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy();
          reject(new Error("Response too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
    request.setTimeout(LINK_PREVIEW_TIMEOUT_MS, () => {
      request.destroy(new Error("timeout"));
    });
    request.on("error", (err) => {
      reject(err);
    });
    request.end();
  });
}

const server = http.createServer(app);

// --------------------------------------------------
// EXPRESS MIDDLEWARE + STATIC
// --------------------------------------------------
app.use(express.json());
app.use((req, res, next) => {
  if (req.path.startsWith("/avatars/")) {
    const file = path.posix.basename(req.path);
    const username = file.split(".")[0];
    if (username && bannedUsers.has(username)) {
      return res.status(404).end();
    }
  }
  next();
});
const STATIC_BLOCKLIST = new Set([`/${DB_FILE}`, `/${DB_FILE}-journal`]);
app.use((req, res, next) => {
  // Prevent database files from being served by the static handler
  const normalized = path.posix.normalize(req.path);
  const trimmed = normalized.replace(/\/+$/, "") || "/";
  if (STATIC_BLOCKLIST.has(normalized) || STATIC_BLOCKLIST.has(trimmed)) {
    return res.status(404).end();
  }
  next();
});
function serveFavicon(req, res) {
  res.type("image/x-icon");
  res.sendFile(FAVICON_PATH, (err) => {
    if (err) {
      res.status(err?.statusCode || 404).end();
    }
  });
}

app.get(/^\/.*favicon\.ico$/, serveFavicon);
app.use(express.static(__dirname));

const SUBPAGES_DIR = path.join(__dirname, "subpages");
const SUBPAGE_NAMES = [
  "appeal",
  "appeals_list",
  "ban_info",
  "banned",
  "chat",
  "2fa",
  "mod",
  "modlogs",
  "embed-login",
  "token",
  "levels",
  "reset",
  "tos",
];
SUBPAGE_NAMES.forEach((name) => {
  const dir = path.join(SUBPAGES_DIR, name);
  if (fs.existsSync(dir)) {
    app.use(`/${name}`, express.static(dir));
  }
});

SUBPAGE_NAMES.forEach((name) => {
  app.get(`/${name}.html`, (req, res) => {
    res.redirect(301, `/${name}/`);
  });
});

// Aliases for levels paths (include common misspelling)
app.get(["/levels/search", "/levels/seach"], (req, res) => {
  res.sendFile(path.join(__dirname, "subpages", "levels", "search", "index.html"));
});
app.get("/levels/level", (req, res) => {
  res.sendFile(path.join(__dirname, "subpages", "levels", "level", "index.html"));
});

// Legacy /login path now points to the main index
app.get(["/login", "/login/", "/login.html"], (req, res) => {
  res.redirect(301, "/");
});

// Root route → index.html (fixes "Cannot GET /")
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/banStatus", (req, res) => {
  const token = getTokenFromReq(req);
  const session = resolveSessionUser(token);
  let targetUser = null;
  if (session.username) targetUser = session.username;
  else if (session.banned && session.user) targetUser = session.user;
  if (!targetUser) {
    const qUser = (req.query.username || "").trim();
    if (qUser) targetUser = qUser;
  }
  if (!targetUser) {
    res.json({ banned: false });
    return;
  }
  const banned = bannedUsers.has(targetUser);
  const banReason = banned
    ? bannedReasons.get(targetUser) || "Account banned"
    : "";
  res.json({ banned, banReason });
});

app.get("/api/accountSummary", (req, res) => {
  const target = (req.query.username || "").trim();
  if (!target) {
    res.status(400).json({ error: "Missing username" });
    return;
  }
  getUserModState(target, (state) => {
    const banned = !!state.isBanned;
    const rawReason =
      banned && (state.banReason || bannedReasons.get(target))
        ? state.banReason || bannedReasons.get(target)
        : "";
    const banReason = banned
      ? rawReason
          .replace(/^Report reason:\s*/i, "")
          .replace(/^Ban reason:\s*/i, "")
          .trim() || "Account banned"
      : "";
    const muteUntil = mutedUntil.get(target) || 0;
    const muted =
      typeof muteUntil === "number" && muteUntil > Date.now();
    const isAdmin = MOD_USERS.has(target);
    res.json({
      username: target,
      banned,
      banReason,
      muted,
      muteUntil,
      isAdmin,
    });
  });
});

app.get("/api/linkPreview", async (req, res) => {
  const normalized = normalizePreviewUrl(req.query.url || "");
  if (!normalized) {
    res.status(400).json({ error: "Invalid url" });
    return;
  }
  const parsed = new URL(normalized);
  if (isBlockedPreviewHost(parsed.hostname)) {
    res.status(400).json({ error: "Host not allowed" });
    return;
  }
  try {
    const html = await fetchLinkPreviewSource(normalized);
    const title = extractTitleFromHtml(html) || parsed.hostname;
    const favicon = await resolveFaviconFromHtml(html, parsed);
    res.json({
      title,
      host: parsed.hostname,
      favicon,
    });
  } catch (err) {
    res.json({
      title: parsed.hostname,
      host: parsed.hostname,
      favicon: new URL("/favicon.ico", parsed.origin).toString(),
    });
  }
});

const AVATAR_DIR = path.join(__dirname, "avatars");
if (!fs.existsSync(AVATAR_DIR)) {
  fs.mkdirSync(AVATAR_DIR);
}
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, AVATAR_DIR),
  filename: (req, file, cb) => {
    const token = getTokenFromReq(req);
    const session = resolveSessionUser(token);
    if (!session.username) {
      return cb(
        new Error(
          session.banned
            ? bannedReasons.get(session.user) || "Account banned"
            : "Not logged in"
        )
      );
    }
    cb(null, `${session.username}.png`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only images allowed"));
    }
    cb(null, true);
  },
});
app.use("/avatars", express.static(AVATAR_DIR));
app.use("/uploads", express.static(UPLOAD_DIR));

const attachmentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").slice(0, 10);
    cb(null, Date.now() + "-" + crypto.randomUUID() + ext);
  },
});

const uploadAttachments = multer({
  storage: attachmentStorage,
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 5,
  },
});

// --------------------------------------------------
// DB SETUP
// --------------------------------------------------
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      channel  TEXT NOT NULL,
      user     TEXT NOT NULL,
      text     TEXT,
      ts       INTEGER NOT NULL,
      deleted  INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      messageId INTEGER NOT NULL,
      storedName TEXT NOT NULL,
      originalName TEXT NOT NULL,
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      blocked INTEGER DEFAULT 0,
      created INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_attachments_messageId ON attachments (messageId)
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      passwordHash TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      created INTEGER NOT NULL,
      isBanned INTEGER DEFAULT 0,
      isShadowBanned INTEGER DEFAULT 0,
      toxicity INTEGER DEFAULT 5,
      twoFactorEnabled INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter TEXT,
      offender TEXT,
      attachmentId INTEGER,
      attachmentName TEXT,
      messageId INTEGER,
      messageText TEXT,
      channel TEXT,
      reason TEXT,
      ts INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS moderation (
      username TEXT PRIMARY KEY,
      warnings INTEGER DEFAULT 0,
      isBanned INTEGER DEFAULT 0,
      isShadowBanned INTEGER DEFAULT 0,
      toxicity INTEGER DEFAULT 5,
      banReason TEXT DEFAULT ''
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS mod_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT,
      action TEXT,
      target TEXT,
      details TEXT,
      ts INTEGER
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS ban_appeals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT,
      message TEXT,
      ts INTEGER,
      status TEXT DEFAULT 'open'
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      friend TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_unique
    ON friends (username, friend)
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user TEXT NOT NULL,
      to_user TEXT NOT NULL,
      created INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_friend_requests_unique
    ON friend_requests (from_user, to_user)
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS status (
      username TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      message TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS user_settings (
      username TEXT PRIMARY KEY,
      theme TEXT DEFAULT 'classic',
      uiScale REAL DEFAULT 1
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      expires INTEGER NOT NULL
    )
  `);
  db.all("PRAGMA table_info(users)", (err, columns) => {
    if (err) {
      console.error("Failed to inspect users table:", err);
      return;
    }
    const hasCreated = columns.some((col) => col.name === "created");
    const hasEmail = columns.some((col) => col.name === "email");
    const hasPhone = columns.some((col) => col.name === "phone");
    const hasTwoFactorFlag = columns.some((col) => col.name === "twoFactorEnabled");
    if (!hasCreated) {
      db.run("ALTER TABLE users ADD COLUMN created INTEGER DEFAULT 0", (alterErr) => {
        if (alterErr) {
          console.error("Failed to add created column:", alterErr);
        }
      });
    }
    if (!hasEmail) {
      db.run("ALTER TABLE users ADD COLUMN email TEXT", (alterErr) => {
        if (alterErr) {
          console.error("Failed to add email column:", alterErr);
        }
      });
    }
    if (!hasPhone) {
      db.run("ALTER TABLE users ADD COLUMN phone TEXT", (alterErr) => {
        if (alterErr) {
          console.error("Failed to add phone column:", alterErr);
        }
      });
    }
    if (!hasTwoFactorFlag) {
      db.run("ALTER TABLE users ADD COLUMN twoFactorEnabled INTEGER DEFAULT 0", (alterErr) => {
        if (alterErr) {
          console.error("Failed to add twoFactorEnabled column:", alterErr);
        }
      });
    }
  });

  db.all("PRAGMA table_info(reports)", (err, columns) => {
    if (err) {
      console.error("Failed to inspect reports table:", err);
      return;
    }
    const hasAttachmentId = columns.some((c) => c.name === "attachmentId");
    const hasAttachmentName = columns.some((c) => c.name === "attachmentName");
    if (!hasAttachmentId) {
      db.run("ALTER TABLE reports ADD COLUMN attachmentId INTEGER", (alterErr) => {
        if (alterErr) console.error("Failed to add attachmentId column:", alterErr);
      });
    }
    if (!hasAttachmentName) {
      db.run("ALTER TABLE reports ADD COLUMN attachmentName TEXT", (alterErr) => {
        if (alterErr) console.error("Failed to add attachmentName column:", alterErr);
      });
    }
  });

  db.all("PRAGMA table_info(attachments)", (err, columns) => {
    if (err) {
      console.error("Failed to inspect attachments table:", err);
      return;
    }
    const hasBlocked = columns.some((c) => c.name === "blocked");
    if (!hasBlocked) {
      db.run("ALTER TABLE attachments ADD COLUMN blocked INTEGER DEFAULT 0", (alterErr) => {
        if (alterErr) console.error("Failed to add blocked column:", alterErr);
      });
    }
  });
  db.all("PRAGMA table_info(moderation)", (err, columns) => {
    if (err) {
      console.error("Failed to inspect moderation table:", err);
      return;
    }
    const hasBanReason = columns.some((col) => col.name === "banReason");
    if (!hasBanReason) {
      db.run("ALTER TABLE moderation ADD COLUMN banReason TEXT DEFAULT ''", (alterErr) => {
        if (alterErr) {
          console.error("Failed to add banReason column:", alterErr);
        }
      });
    }
  });

  db.all("PRAGMA table_info(user_settings)", (err, columns) => {
    if (err) {
      console.error("Failed to inspect user_settings table:", err);
      return;
    }
    const hasUiScale = columns.some((col) => col.name === "uiScale");
    if (!hasUiScale) {
      db.run("ALTER TABLE user_settings ADD COLUMN uiScale REAL DEFAULT 1", (alterErr) => {
        if (alterErr) {
          console.error("Failed to add uiScale column:", alterErr);
        }
      });
    }
  });

  db.all(
    "SELECT username, banReason FROM moderation WHERE isBanned=1",
    (err, rows) => {
      if (err || !rows) return;
      rows.forEach((row) => {
        if (row?.username) {
          bannedUsers.add(row.username);
          if (row.banReason) bannedReasons.set(row.username, row.banReason);
        }
      });
    }
  );
  db.all("SELECT token, username FROM sessions", (err, rows) => {
    if (err) {
      console.error("Failed to load sessions:", err);
      return;
    }
    (rows || []).forEach((row) => {
      if (row?.token && row?.username) {
        sessions.set(row.token, row.username);
      }
    });
    if (rows?.length) {
      console.log("Restored sessions:", rows.length);
    }
  });
});

function ensureDfLevelsDb() {
  fs.mkdirSync(DF_LEVELS_DIR, { recursive: true });
  const database = new sqlite3.Database(DF_LEVELS_DB_FILE);
  database.serialize(() => {
    database.run(`
      CREATE TABLE IF NOT EXISTS levels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        description TEXT,
        rating REAL DEFAULT 0,
        created INTEGER NOT NULL
      )
    `);
  });
  return database;
}

const dfLevelsDb = ensureDfLevelsDb();

function ensureModRow(user, cb) {
  db.run(
    "INSERT OR IGNORE INTO moderation (username, warnings, isBanned, isShadowBanned, toxicity, banReason) VALUES (?, ?, ?, ?, ?, ?)",
    [user, 0, 0, 0, 5, ""],
    (err) => {
      if (err) console.error("Failed to ensure moderation row:", err);
      if (cb) cb();
    }
  );
}

const AUTO_MOD_RULES = [
  { pattern: /\bkill yourself\b/i, severity: 5 },
  { pattern: /\bsuicide\b/i, severity: 4 },
  { pattern: /\bfuck you\b/i, severity: 3 },
  { pattern: /\bfree nitro\b/i, severity: 3 },
  { pattern: /\bdiscord\.gg\/\w+/i, severity: 3 },
  { pattern: /https?:\/\/.+/i, severity: 2 },
  { pattern: /(.)\1{7,}/i, severity: 2 },
];

function isMuted(user) {
  const until = mutedUntil.get(user);
  return until && Date.now() < until;
}
function applyAutoModeration(user, channel, text) {
  let score = 0;
  AUTO_MOD_RULES.forEach((rule) => {
    if (rule.pattern.test(text)) score += rule.severity;
  });
  return score;
}

async function moderateTextWithOpenAI(text) {
  const key = process.env.OPENAI_API_KEY;
  if (!key || !text) return null;
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: "omni-moderation-latest",
      input: text,
    });
    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/moderations",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: "Bearer " + key,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const result = body?.results?.[0];
            if (!result) {
              resolve(null);
              return;
            }
            const categories = Object.entries(result.categories || {})
              .filter(([, v]) => v)
              .map(([k]) => k.replace(/_/g, " "));
            const reason =
              "Ban reason: AI flagged (" +
              (categories.join(", ") || "policy") +
              ")";
            resolve({
              flagged: !!result.flagged,
              reason,
              categories,
            });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
function getUserModState(user, cb) {
  db.get(
    "SELECT warnings,isBanned,isShadowBanned,toxicity,banReason FROM moderation WHERE username=?",
    [user],
    (err, row) => {
      if (!row) {
        db.run(
          "INSERT INTO moderation (username,warnings,isBanned,isShadowBanned,toxicity,banReason) VALUES (?,?,?,?,?,?)",
          [user, 0, 0, 0, 5, ""]
        );
        return cb({
          warnings: 0,
          isBanned: 0,
          isShadowBanned: 0,
          toxicity: 5,
          banReason: "",
        });
      }
      if (row.isBanned) {
        bannedUsers.add(user);
        if (row.banReason) bannedReasons.set(user, row.banReason);
      }
      cb(row);
    }
  );
}
function updateModState(user, field, value, opts = {}) {
  ensureModRow(user, () => {
    db.run(
      `UPDATE moderation SET ${field}=? WHERE username=?`,
      [value, user],
      (err) => {
        if (err) {
          console.error("Failed to update moderation state:", err);
          return;
        }
        if (field === "isBanned") {
          if (value) {
            const finalReason =
              opts.reason ||
              bannedReasons.get(user) ||
              `Banned by ${opts.actor || "moderation"}`;
            db.run("UPDATE moderation SET banReason=? WHERE username=?", [
              finalReason,
              user,
            ]);
            bannedReasons.set(user, finalReason);
            bannedUsers.add(user);
            invalidateUserSessions(user);
            disconnectUserSockets(user, finalReason, 4003);
          } else {
            bannedUsers.delete(user);
            bannedReasons.delete(user);
            db.run("UPDATE moderation SET banReason=? WHERE username=?", [
              "",
              user,
            ]);
          }
        } else if (field === "banReason" && typeof value === "string") {
          if (value) bannedReasons.set(user, value);
          else bannedReasons.delete(user);
        }
      }
    );
  });
}
function addWarning(user) {
  getUserModState(user, (state) => {
    const newWarnings = state.warnings + 1;
    updateModState(user, "warnings", newWarnings);
    if (newWarnings >= 3) {
      updateModState(user, "isBanned", 1, {
        reason: "Auto-ban: accumulated 3 warnings",
        actor: "auto-mod",
      });
      logModEvent("auto-mod", "auto-ban", user, "3+ warnings");
    }
  });
}

// --------------------------------------------------
// LOGGING HELPERS
// --------------------------------------------------
function logModEvent(actor, action, target, details) {
  const ts = Date.now();
  db.run(
    `INSERT INTO mod_logs (actor, action, target, details, ts)
     VALUES (?, ?, ?, ?, ?)`,
    [actor || "system", action, target || "", details || "", ts]
  );
}

function broadcastPresenceSnapshot() {
  if (!wss) return;
  const set = new Set();
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN && c.username) set.add(c.username);
  });
  const payload = JSON.stringify({
    type: "presence_snapshot",
    users: Array.from(set),
  });
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(payload);
  });
}

function broadcastToUser(username, data) {
  const msg = JSON.stringify(data);
  if (!wss) return;
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN && c.username === username) {
      c.send(msg);
    }
  });
}

function isDmChannel(channel) {
  return channel.startsWith("dm:");
}
function dmParticipants(channel) {
  return channel.slice(3).split(",");
}
function userAllowedForChannel(username, channel) {
  if (channel === "staff") return MOD_USERS.has(username);
  if (isDmChannel(channel)) {
    const people = dmParticipants(channel);
    return people.includes(username);
  }
  return true;
}

function getTokenFromReq(req) {
  const h = req.headers["authorization"];
  if (!h) return null;
  const parts = h.split(" ");
  if (parts.length === 2 && parts[0] === "Bearer") return parts[1];
  return null;
}

function resolveSessionUser(token) {
  if (!token) return { username: null, banned: false };
  const username = sessions.get(token);
  if (!username) return { username: null, banned: false };
  if (usernameTooLong(username)) {
    sessions.delete(token);
    deleteSessionsFromDb([token]);
    return { username: null, banned: false };
  }
  if (bannedUsers.has(username)) {
    sessions.delete(token);
    deleteSessionsFromDb([token]);
    return { username: null, banned: true, user: username };
  }
  return { username, banned: false };
}

function requireAuthedUser(req, res) {
  const token = getTokenFromReq(req);
  const result = resolveSessionUser(token);
  if (!result.username) {
    if (result.banned) {
      const reason =
        bannedReasons.get(result.user) || "You are banned from this service.";
      res.status(403).json({ error: "Account banned", reason });
    } else {
      res.status(401).json({ error: "Not logged in" });
    }
    return null;
  }
  return { username: result.username, token };
}

function generateTwoFactorCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeDfText(input, maxLen) {
  const val = typeof input === "string" ? input.trim() : "";
  if (!maxLen) return val;
  return val.slice(0, maxLen);
}

function normalizeDfTags(tags) {
  if (Array.isArray(tags)) {
    return tags
      .map((t) => normalizeDfText(t, 40))
      .filter(Boolean)
      .join(",");
  }
  return normalizeDfText(tags, DF_MAX_TAGS_LENGTH);
}

function maskContact(contact) {
  if (!contact) return "";
  if (contact.phone) {
    const digits = contact.phone.replace(/\D/g, "");
    if (digits.length <= 4) return contact.phone;
    return digits.slice(0, -4).replace(/\d/g, "•") + digits.slice(-4);
  }
  if (contact.email) {
    const [user, domain] = contact.email.split("@");
    if (!domain) return contact.email;
    const maskedUser =
      user.length <= 2
        ? user[0] + "•"
        : user[0] + "•".repeat(Math.max(1, user.length - 2)) + user.slice(-1);
    return maskedUser + "@" + domain;
  }
  return "";
}

function loadMailConfig() {
  if (mailConfigLoaded) return mailConfig;
  mailConfigLoaded = true;
  const envHost = process.env.SMTP_HOST;
  const envUser = process.env.SMTP_USER;
  const envPass = process.env.SMTP_PASS;
  const envPort = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null;
  const envSecure = process.env.SMTP_SECURE
    ? ["1", "true", "yes", "on"].includes(
        String(process.env.SMTP_SECURE).toLowerCase()
      )
    : null;
  if (envHost && envUser && envPass) {
    mailConfig = {
      host: envHost,
      port: envPort || 587,
      secure: envSecure ?? (envPort === 465),
      auth: { user: envUser, pass: envPass },
      from: process.env.SMTP_FROM || envUser,
    };
    return mailConfig;
  }
  const configPath = path.join(__dirname, "smtp.config.json");
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (parsed && parsed.host && parsed.auth?.user && parsed.auth?.pass) {
        mailConfig = {
          host: parsed.host,
          port: Number(parsed.port) || 587,
          secure:
            typeof parsed.secure === "boolean"
              ? parsed.secure
              : (Number(parsed.port) || 587) === 465,
          auth: parsed.auth,
          from: parsed.from || parsed.auth.user,
        };
        return mailConfig;
      }
    } catch (err) {
      console.error("Failed to read smtp.config.json:", err);
    }
  }
  mailConfig = null;
  return null;
}

function getMailTransport() {
  if (mailTransport) return mailTransport;
  const config = loadMailConfig();
  if (!config) return null;
  mailTransport = nodemailer.createTransport(config);
  return mailTransport;
}

function sendTwoFactorCode(username, contact, code) {
  const destination = contact.phone ? `SMS:${contact.phone}` : `Email:${contact.email}`;
  if (contact.email) {
    const transporter = getMailTransport();
    if (transporter) {
      const from = (loadMailConfig() && mailConfig?.from) || process.env.SMTP_FROM || process.env.SMTP_USER;
      transporter
        .sendMail({
          from,
          to: contact.email,
          subject: "Your Benno111 Chat verification code",
          text: `Your verification code is ${code}. It expires in 10 minutes.`,
        })
        .catch((err) => {
          console.error("Failed to send 2FA email:", err);
        });
    } else {
      console.warn("SMTP is not configured. Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS.");
      console.log(`[2FA] Code for ${username} -> ${destination}: ${code}`);
    }
  } else {
    console.log(`[2FA] Code for ${username} -> ${destination}: ${code}`);
  }
}

function pruneLoginChallenges() {
  const now = Date.now();
  for (const [id, value] of loginChallenges.entries()) {
    if (!value || typeof value.expiresAt !== "number" || value.expiresAt < now) {
      loginChallenges.delete(id);
    }
  }
}

function pruneAppLoginCodes() {
  const now = Date.now();
  for (const [code, entry] of appLoginCodes.entries()) {
    if (!entry || typeof entry.expiresAt !== "number" || entry.expiresAt < now) {
      appLoginCodes.delete(code);
    }
  }
}

function prunePasswordResetTokens() {
  const now = Date.now();
  db.run("DELETE FROM password_resets WHERE expires < ?", [now]);
}

function createPasswordResetToken(username) {
  return new Promise((resolve, reject) => {
    prunePasswordResetTokens();
    const token = uuidv4();
    const expires = Date.now() + PASSWORD_RESET_TTL_MS;
    db.serialize(() => {
      db.run("DELETE FROM password_resets WHERE username=?", [username]);
      db.run(
        "INSERT INTO password_resets (token, username, expires) VALUES (?, ?, ?)",
        [token, username, expires],
        (err) => {
          if (err) return reject(err);
          resolve({ token, expires });
        }
      );
    });
  });
}

function getPasswordResetEntry(token) {
  return new Promise((resolve, reject) => {
    prunePasswordResetTokens();
    db.get(
      "SELECT token, username, expires FROM password_resets WHERE token=?",
      [token],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

function deletePasswordResetToken(token) {
  db.run("DELETE FROM password_resets WHERE token=?", [token]);
}

function sendPasswordResetEmail(username, email, link, expiresAt) {
  const transporter = getMailTransport();
  const expiresInMin = Math.max(
    1,
    Math.round((expiresAt - Date.now()) / 60000)
  );
  const body =
    "Hello " +
    username +
    ",\n\n" +
    "We received a request to reset your Benno111 Chat password.\n" +
    "Reset link (valid for " +
    expiresInMin +
    " minutes):\n" +
    link +
    "\n\nIf you did not request this, you can ignore this email.";

  if (transporter) {
    const from =
      (loadMailConfig() && mailConfig?.from) ||
      process.env.SMTP_FROM ||
      process.env.SMTP_USER;
    transporter
      .sendMail({
        from,
        to: email,
        subject: "Reset your Benno111 Chat password",
        text: body,
      })
      .catch((err) => {
        console.error("Failed to send password reset email:", err);
      });
  } else {
    console.warn(
      "SMTP is not configured. Set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS."
    );
    console.log(`[Password Reset] Link for ${username}: ${link}`);
  }
}

function createLoginChallenge(username, contact) {
  pruneLoginChallenges();
  const code = generateTwoFactorCode();
  const challengeId = uuidv4();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  loginChallenges.set(challengeId, { username, code, expiresAt });
  sendTwoFactorCode(username, contact, code);
  return { challengeId, code, expiresAt };
}

function createAppLoginCodeForUser(username) {
  pruneAppLoginCodes();
  const now = Date.now();
  const existing = [];
  for (const [code, entry] of appLoginCodes.entries()) {
    if (entry.username === username) {
      existing.push({ code, created: entry.created || 0 });
    }
  }
  existing.sort((a, b) => (a.created || 0) - (b.created || 0));
  while (existing.length >= APP_LOGIN_CODES_PER_USER) {
    const oldest = existing.shift();
    if (oldest) appLoginCodes.delete(oldest.code);
  }
  let code = generateTwoFactorCode();
  while (appLoginCodes.has(code)) {
    code = generateTwoFactorCode();
  }
  const expiresAt = now + APP_LOGIN_CODE_TTL_MS;
  appLoginCodes.set(code, { username, expiresAt, created: now });
  return { code, expiresAt };
}

function getUserRecord(username) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT username, passwordHash, email, phone, twoFactorEnabled FROM users WHERE username=?",
      [username],
      (err, row) => {
        if (err) return reject(err);
        resolve(row || null);
      }
    );
  });
}

function createUserRecord(username, passwordHash, email, phone) {
  return new Promise((resolve, reject) => {
    const created = Date.now();
    db.run(
      "INSERT INTO users (username, passwordHash, email, phone, created, twoFactorEnabled) VALUES (?, ?, ?, ?, ?, 0)",
      [username, passwordHash, email || "", phone || "", created],
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

// --------------------------------------------------
// AUTH / USERS
// --------------------------------------------------
app.post("/api/register", async (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const { username, password, email, phone } = req.body || {};
  if (!username || !password || !email)
    return res
      .status(400)
      .json({ error: "Username, password, and email required" });
  const cleanUser = username.trim();
  if (cleanUser.length > MAX_USERNAME_LENGTH) {
    return res.status(400).json({ error: "Username too long" });
  }
  const trimmedEmail = (email || "").trim();
  if (!isValidEmail(trimmedEmail)) {
    return res.status(400).json({ error: "A valid email is required" });
  }
  const trimmedPhone = (phone || "").trim();
  try {
    const existing = await getUserRecord(cleanUser);
    if (existing)
      return res.status(400).json({ error: "Username already exists" });
    const hash = await bcrypt.hash(password, 10);
    await createUserRecord(cleanUser, hash, trimmedEmail, trimmedPhone);
    db.run(
      "INSERT OR IGNORE INTO moderation (username,warnings,isBanned,isShadowBanned,toxicity,banReason) VALUES (?,0,0,0,5,'')",
      [cleanUser],
      (err) => {
        if (err) console.error("Failed to seed moderation row:", err);
      }
    );
    console.log("Registered:", cleanUser);
    res.json({ success: true });
  } catch (err) {
    console.error("Register error:", err);
    if (err && err.message?.includes("UNIQUE")) {
      return res.status(400).json({ error: "Username already exists" });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/login", async (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const { username, password, email } = req.body || {};
  if (!username || !password || !email)
    return res
      .status(400)
      .json({ error: "Username, password, and email required" });
  const loginUser = (username || "").trim();
  if (loginUser.length > MAX_USERNAME_LENGTH) {
    return res.status(400).json({ error: "Username too long" });
  }
  const loginEmail = (email || "").trim();
  if (!isValidEmail(loginEmail)) {
    return res.status(400).json({ error: "Valid email required" });
  }
  try {
    const record = await getUserRecord(loginUser);
    if (!record)
      return res
        .status(400)
        .json({ error: "Invalid username or password" });
    const ok = await bcrypt.compare(password, record.passwordHash);
    if (!ok)
      return res
        .status(400)
        .json({ error: "Invalid username or password" });
    getUserModState(loginUser, (state) => {
      if (state.isBanned) {
        if (state.banReason) bannedReasons.set(loginUser, state.banReason);
        return res
          .status(403)
          .json({ error: "Account banned", reason: state.banReason || "" });
      }
      let effectiveEmail = (record.email || "").trim();
      if (!effectiveEmail) {
        effectiveEmail = loginEmail;
      }
      if (!isValidEmail(effectiveEmail)) {
        return res
          .status(400)
          .json({ error: "Email required for login. Please update your account." });
      }
      if (effectiveEmail !== (record.email || "").trim()) {
        db.run("UPDATE users SET email=? WHERE username=?", [effectiveEmail, loginUser]);
      }
      const contact = {
        email: effectiveEmail,
        phone: (record.phone || "").trim(),
      };
      const twoFactorEnabled = Number(record.twoFactorEnabled) === 1;
      if (!twoFactorEnabled) {
        const token = uuidv4();
        sessions.set(token, loginUser);
        persistSession(token, loginUser);
        console.log("Login (2FA disabled):", loginUser, "=>", token);
        res.json({ success: true, token, username: loginUser, require2fa: false });
        return;
      }
      const challenge = createLoginChallenge(loginUser, contact);
      const masked = maskContact(contact);
      const deliveryMethod = contact.phone ? "phone" : "email";
      const payload = {
        success: true,
        require2fa: true,
        challengeId: challenge.challengeId,
        deliveryMethod,
        destination: masked || deliveryMethod,
        expiresAt: challenge.expiresAt,
        username: loginUser,
      };
      res.json(payload);
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Optional login flow: returns session info if token is provided, otherwise anonymous.
app.get("/api/optional-login", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const token = getTokenFromReq(req);
  const session = resolveSessionUser(token);
  if (session.banned) {
    return res.status(403).json({
      error: "Account banned",
      reason: bannedReasons.get(session.user) || "",
    });
  }
  if (session.username) {
    return res.json({
      success: true,
      loggedIn: true,
      username: session.username,
    });
  }
  res.json({ success: true, loggedIn: false });
});

// Simple echo endpoint for integrations: returns whatever JSON body is sent.
app.post("/api/echo", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  res.json({
    success: true,
    echo: req.body || {},
  });
});

app.post("/api/app/login/code", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const entry = createAppLoginCodeForUser(auth.username);
  res.json({
    success: true,
    code: entry.code,
    expiresAt: entry.expiresAt,
  });
});

app.post("/api/app/login/consume", async (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const { username, code } = req.body || {};
  const cleanUser = typeof username === "string" ? username.trim() : "";
  const providedCode = typeof code === "string" ? code.trim() : "";
  if (!cleanUser || !providedCode) {
    return res.status(400).json({ error: "Username and code required" });
  }
  if (cleanUser.length > MAX_USERNAME_LENGTH) {
    return res.status(400).json({ error: "Invalid username" });
  }
  pruneAppLoginCodes();
  const entry = appLoginCodes.get(providedCode);
  if (!entry || entry.username !== cleanUser) {
    return res.status(400).json({ error: "Invalid or expired code" });
  }
  if (Date.now() > entry.expiresAt) {
    appLoginCodes.delete(providedCode);
    return res.status(400).json({ error: "Code expired" });
  }
  try {
    const record = await getUserRecord(cleanUser);
    if (!record) {
      appLoginCodes.delete(providedCode);
      return res.status(400).json({ error: "Invalid or expired code" });
    }
    getUserModState(cleanUser, (state) => {
      if (state.isBanned) {
        if (state.banReason) bannedReasons.set(cleanUser, state.banReason);
        appLoginCodes.delete(providedCode);
        return res
          .status(403)
          .json({ error: "Account banned", reason: state.banReason || "" });
      }
      appLoginCodes.delete(providedCode);
      const token = uuidv4();
      sessions.set(token, cleanUser);
      persistSession(token, cleanUser);
      console.log("App login via code:", cleanUser, "=>", token);
      res.json({ success: true, token, username: cleanUser });
    });
  } catch (err) {
    console.error("App login code consume error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --------------------------------------------------
// DORF PLATFORMER LEVELS
// --------------------------------------------------
app.post("/api/df/levels", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const name = normalizeDfText(req.body?.name, DF_MAX_NAME_LENGTH);
  const content = typeof req.body?.content === "string" ? req.body.content : "";
  const description = normalizeDfText(
    req.body?.description,
    DF_MAX_DESC_LENGTH
  );
  const tags = normalizeDfTags(req.body?.tags);
  const ratingRaw = req.body?.rating;
  const rating =
    typeof ratingRaw === "number" && Number.isFinite(ratingRaw)
      ? ratingRaw
      : ratingRaw
      ? parseFloat(ratingRaw)
      : 0;

  if (!name || !content) {
    return res
      .status(400)
      .json({ error: "Level name and content are required" });
  }

  const created = Date.now();
  dfLevelsDb.run(
    `INSERT INTO levels (name, content, tags, description, rating, created)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, content, tags, description, isNaN(rating) ? 0 : rating, created],
    function (err) {
      if (err) {
        console.error("DF level insert error:", err);
        return res.status(500).json({ error: "Failed to save level" });
      }
      res.json({ success: true, id: this.lastID, created });
    }
  );
});

app.get("/api/df/levels", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const limit = Math.min(parseInt(req.query.limit || "20", 10) || 20, 100);
  dfLevelsDb.all(
    `SELECT id, name, tags, description, rating, created
     FROM levels
     ORDER BY created DESC
     LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) {
        console.error("DF level list error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      res.json({ success: true, levels: rows || [] });
    }
  );
});

app.get("/api/df/levels/search", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const q = normalizeDfText(req.query.q, 200);
  const limit = Math.min(parseInt(req.query.limit || "20", 10) || 20, 100);
  if (!q) {
    return res.status(400).json({ error: "Search query required" });
  }
  const like = `%${q}%`;
  dfLevelsDb.all(
    `SELECT id, name, tags, description, rating, created
     FROM levels
     WHERE name LIKE ? OR tags LIKE ? OR description LIKE ?
     ORDER BY created DESC
     LIMIT ?`,
    [like, like, like, limit],
    (err, rows) => {
      if (err) {
        console.error("DF level search error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      res.json({ success: true, levels: rows || [] });
    }
  );
});

app.get("/api/df/levels/:id", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid level id" });
  }
  dfLevelsDb.get(
    `SELECT id, name, content, tags, description, rating, created
     FROM levels
     WHERE id=?`,
    [id],
    (err, row) => {
      if (err) {
        console.error("DF level fetch error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ success: true, level: row });
    }
  );
});

app.post("/api/df/levels/:id/rate", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  if (!MOD_USERS.has(auth.username)) {
    return res.status(403).json({ error: "Admins only" });
  }
  const id = parseInt(req.params.id, 10);
  const ratingRaw = req.body?.rating;
  const rating =
    typeof ratingRaw === "number" && Number.isFinite(ratingRaw)
      ? ratingRaw
      : ratingRaw
      ? parseFloat(ratingRaw)
      : NaN;
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid level id" });
  }
  if (isNaN(rating)) {
    return res.status(400).json({ error: "Invalid rating" });
  }
  dfLevelsDb.run(
    `UPDATE levels SET rating=? WHERE id=?`,
    [rating, id],
    function (err) {
      if (err) {
        console.error("DF level rate error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      if (this.changes === 0) {
        return res.status(404).json({ error: "Not found" });
      }
      res.json({ success: true, id, rating });
    }
  );
});

app.post("/api/password/reset/request", async (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const { username } = req.body || {};
  if (!username || typeof username !== "string") {
    return res.status(400).json({ error: "Username required" });
  }
  const cleanUser = username.trim();
  try {
    const record = await getUserRecord(cleanUser);
    if (!record || !record.email) {
      // Do not reveal whether the user exists or has email
      return res.json({ success: true });
    }
    const { token, expires } = await createPasswordResetToken(cleanUser);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const link = `${baseUrl}/reset/?token=${encodeURIComponent(token)}`;
    sendPasswordResetEmail(cleanUser, record.email, link, expires);
    res.json({ success: true });
  } catch (err) {
    console.error("Password reset request error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/password/reset/confirm", async (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword) {
    return res.status(400).json({ error: "Token and new password required" });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: "Password too short" });
  }
  try {
    const entry = await getPasswordResetEntry(String(token).trim());
    if (!entry || entry.expires < Date.now()) {
      if (entry && entry.token) deletePasswordResetToken(entry.token);
      return res.status(400).json({ error: "Invalid or expired token" });
    }
    const record = await getUserRecord(entry.username);
    if (!record) {
      deletePasswordResetToken(entry.token);
      return res.status(404).json({ error: "User not found" });
    }
    const hash = await bcrypt.hash(String(newPassword), 10);
    db.run(
      "UPDATE users SET passwordHash=? WHERE username=?",
      [hash, entry.username],
      (err) => {
        if (err) {
          console.error("Password reset error:", err);
          return res.status(500).json({ error: "DB error" });
        }
        deletePasswordResetToken(entry.token);
        invalidateUserSessions(entry.username);
        disconnectUserSockets(entry.username, "Password reset", 4001);
        res.json({ success: true, username: entry.username });
      }
    );
  } catch (err) {
    console.error("Password reset confirm error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/logout", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const token = getTokenFromReq(req);
  if (token) {
    const username = revokeSessionToken(token);
    if (username) {
      disconnectUserSockets(username, "Logged out", 4000);
    }
  }
  res.json({ success: true });
});

app.get("/download/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid attachment id" });
  }
  db.get(
    "SELECT storedName, originalName, mime, blocked FROM attachments WHERE id=?",
    [id],
    (err, row) => {
      if (err) {
        console.error("Download lookup error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      if (!row) return res.status(404).json({ error: "Not found" });
      if (row.blocked) return res.status(410).json({ error: "File blocked" });
      const filePath = path.join(UPLOAD_DIR, path.basename(row.storedName));
      const filename = row.originalName || row.storedName || "file";
      res.download(filePath, filename, (downloadErr) => {
        if (downloadErr) {
          if (!res.headersSent) {
            res.status(downloadErr.statusCode || 500).end();
          }
        }
      });
    }
  );
});

app.post("/api/attachment/delete", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const requester = auth.username;
  const { attachmentId } = req.body || {};
  const attId = parseInt(attachmentId, 10);
  if (!attId) return res.status(400).json({ error: "Missing attachment id" });
  db.get(
    `SELECT attachments.id, attachments.storedName, attachments.originalName,
            messages.user as owner, messages.channel
     FROM attachments
     JOIN messages ON attachments.messageId = messages.id
     WHERE attachments.id=?`,
    [attId],
    (err, row) => {
      if (err) {
        console.error("Attachment lookup error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      if (!row) return res.status(404).json({ error: "Not found" });
      const isOwner = row.owner === requester;
      const isMod = MOD_USERS.has(requester);
      if (!isOwner && !isMod) {
        return res.status(403).json({ error: "Not allowed" });
      }
      db.run("UPDATE attachments SET blocked=1 WHERE id=?", [attId], (delErr) => {
        if (delErr) {
          console.error("Attachment delete error:", delErr);
          return res.status(500).json({ error: "DB error" });
        }
        const payload = JSON.stringify({
          type: "attachment_delete",
          id: attId,
          channel: row.channel,
        });
        if (wss) {
          wss.clients.forEach((c) => {
            if (c.readyState === WebSocket.OPEN && c.channel === row.channel) {
              c.send(payload);
            }
          });
        }
        res.json({ success: true });
      });
    }
  );
});

app.post("/api/verify2fa", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const { challengeId, code } = req.body || {};
  if (!challengeId || !code) {
    return res.status(400).json({ error: "Missing challenge or code" });
  }
  pruneLoginChallenges();
  const entry = loginChallenges.get(challengeId);
  if (!entry) {
    return res.status(400).json({ error: "Invalid or expired code" });
  }
  if (Date.now() > entry.expiresAt) {
    loginChallenges.delete(challengeId);
    return res.status(400).json({ error: "Code expired" });
  }
  const provided = String(code).trim();
  if (entry.code !== provided) {
    return res.status(400).json({ error: "Incorrect code" });
  }
  loginChallenges.delete(challengeId);
  const username = entry.username;
  getUserModState(username, (state) => {
    if (state.isBanned) {
      if (state.banReason) bannedReasons.set(username, state.banReason);
      return res
        .status(403)
        .json({ error: "Account banned", reason: state.banReason || "" });
    }
    const token = uuidv4();
    sessions.set(token, username);
    persistSession(token, username);
    console.log("Login (2FA):", username, "=>", token);
    res.json({ success: true, token, username });
  });
});

// --------------------------------------------------
// MESSAGES / HISTORY
// --------------------------------------------------
app.get("/api/messages", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const { username } = auth;
  const channel = req.query.channel || "general";
  if (!userAllowedForChannel(username, channel))
    return res.status(403).json({ error: "Not allowed for this channel" });
  const beforeId = req.query.beforeId
    ? parseInt(req.query.beforeId, 10)
    : null;
  const limit = Math.min(parseInt(req.query.limit || "30", 10), 100);
  let sql = `
    SELECT id, user, text, ts, deleted, channel
    FROM messages
    WHERE channel = ?
      AND deleted = 0
  `;
  const params = [channel];
  if (beforeId) {
    sql += " AND id < ?";
    params.push(beforeId);
  }
  sql += " ORDER BY id DESC LIMIT ?";
  params.push(limit);
  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error("DB error:", err);
      return res.status(500).json({ error: "Database error" });
    }
    const filtered = (rows || []).filter(
      (row) => !bannedUsers.has(row.user) && !usernameTooLong(row.user || "")
    );
    const messageIds = filtered.map((row) => row.id);
    if (!messageIds.length) {
      return res.json({ messages: [] });
    }
    const placeholders = messageIds.map(() => "?").join(",");
    db.all(
      `SELECT id, messageId, storedName, originalName, mime, size
       FROM attachments
       WHERE messageId IN (${placeholders}) AND blocked=0`,
      messageIds,
      (attachErr, attachRows) => {
        if (attachErr) {
          console.error("Attachments load error:", attachErr);
          return res.status(500).json({ error: "Database error" });
        }
        const attachMap = new Map();
        (attachRows || []).forEach((r) => {
          const list = attachMap.get(r.messageId) || [];
          list.push({
            id: r.id,
            url: "/uploads/" + encodeURIComponent(r.storedName),
            downloadUrl: "/download/" + r.id,
            name: r.originalName,
            mime: r.mime,
            size: r.size,
            isImage: (r.mime || "").startsWith("image/"),
            isVideo: (r.mime || "").startsWith("video/"),
            messageId: r.messageId,
          });
          attachMap.set(r.messageId, list);
        });
        const enriched = filtered
          .map((row) => ({
            ...row,
            attachments: (attachMap.get(row.id) || []).map((a) => ({
              ...a,
              user: row.user,
              owner: row.user,
            })),
          }))
          .reverse();
        res.json({ messages: enriched });
      }
    );
  });
});

app.post("/api/messages", uploadAttachments.array("files", 5), (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const { username } = auth;
  const channel = (req.body?.channel || "general").trim() || "general";
  if (!userAllowedForChannel(username, channel)) {
    return res.status(403).json({ error: "Not allowed for this channel" });
  }
  if (usernameTooLong(username)) {
    return res.status(400).json({ error: "Username too long" });
  }
  const text = (req.body?.text || "").trim().slice(0, MAX_MESSAGE_LENGTH);
  const files = Array.isArray(req.files) ? req.files : [];
  if (!text && !files.length) {
    return res.status(400).json({ error: "Message or file required" });
  }
  const safeFiles = files.map((f) => ({
    storedName: path.basename(f.filename),
    originalName: f.originalname || f.filename,
    mime: f.mimetype || "application/octet-stream",
    size: f.size || 0,
  }));
  const ts = Date.now();
  db.run(
    "INSERT INTO messages (channel, user, text, ts) VALUES (?, ?, ?, ?)",
    [channel, username, text, ts],
    function (err) {
      if (err) {
        console.error("DB error:", err);
        return res.status(500).json({ error: "Database error" });
      }
      const messageId = this.lastID;
      const attachments = [];
      if (!safeFiles.length) {
        const msg = {
          type: "chat",
          id: messageId,
          user: username,
          text,
          ts,
          deleted: 0,
          channel,
          attachments,
        };
        const msgStr = JSON.stringify(msg);
        if (wss) {
          wss.clients.forEach((client) => {
            if (
              client.readyState === WebSocket.OPEN &&
              client.channel === channel
            ) {
              client.send(msgStr);
            }
          });
        }
        return res.json({ success: true, message: msg });
      }

      let remaining = safeFiles.length;
      safeFiles.forEach((file) => {
        db.run(
          "INSERT INTO attachments (messageId, storedName, originalName, mime, size, created) VALUES (?, ?, ?, ?, ?, ?)",
          [
            messageId,
            file.storedName,
            file.originalName,
            file.mime,
            file.size,
            ts,
          ],
          function (attachErr) {
            if (attachErr) {
              console.error("Attachment save error:", attachErr);
            } else {
              const originalName = file.originalName || file.storedName;
              attachments.push({
                id: this.lastID,
                url: "/uploads/" + encodeURIComponent(file.storedName),
                downloadUrl: "/download/" + this.lastID,
                name: originalName,
                mime: file.mime,
                size: file.size,
                isImage: (file.mime || "").startsWith("image/"),
                isVideo: (file.mime || "").startsWith("video/"),
                messageId,
                user: username,
                owner: username,
              });
            }
            remaining -= 1;
            if (remaining === 0) {
              const msg = {
                type: "chat",
                id: messageId,
                user: username,
                text,
                ts,
                deleted: 0,
                channel,
                attachments,
              };
              const msgStr = JSON.stringify(msg);
              if (wss) {
                wss.clients.forEach((client) => {
                  if (
                    client.readyState === WebSocket.OPEN &&
                    client.channel === channel
                  ) {
                    client.send(msgStr);
                  }
                });
              }
              res.json({ success: true, message: msg });
            }
          }
        );
      });
    }
  );
});

app.post("/api/deleteMessage", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const { username } = auth;
  const { id } = req.body || {};
  if (!id) return res.status(400).json({ error: "Missing id" });
  db.get(
    "SELECT id,user,channel FROM messages WHERE id=?",
    [id],
    (err, row) => {
      if (err) {
        console.error("DB error:", err);
        return res.status(500).json({ error: "Database error" });
      }
      if (!row) return res.status(404).json({ error: "Message not found" });
      if (row.user !== username)
        return res
          .status(403)
          .json({ error: "Can only delete your own messages" });
      db.run("UPDATE messages SET deleted=1 WHERE id=?", [id], (err2) => {
        if (err2) {
          console.error("DB error:", err2);
          return res.status(500).json({ error: "Database error" });
        }
        const payload = JSON.stringify({ type: "delete", id: row.id });
        if (wss) {
          wss.clients.forEach((client) => {
            if (
              client.readyState === WebSocket.OPEN &&
              client.channel === row.channel
            ) {
              client.send(payload);
            }
          });
        }
        res.json({ success: true });
      });
    }
  );
});

// --------------------------------------------------
// REPORTS / MOD LOGS / ADMIN
// --------------------------------------------------
app.post("/api/reportMessage", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const reporter = auth.username;
  const { messageId, offender, text, channel, reason } = req.body || {};
  if (!messageId || !offender || !channel || !reason)
    return res.status(400).json({ error: "Missing fields" });
  const messageText =
    typeof text === "string" && text.trim() ? text.trim() : "[no text]";
  const banReason = safeReason(reason.replace(/^Report reason:\s*/i, ""));
  db.run(
    `INSERT INTO reports (reporter, offender, messageId, messageText, channel, reason, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [reporter, offender, messageId, messageText, channel, banReason, Date.now()],
    function (err) {
      if (err) {
        console.error("DB error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      logModEvent(
        reporter,
        "report",
        offender,
        `Ban reason: ${banReason} | Channel: ${channel} | Msg: ${messageText}`
      );
      const payload = JSON.stringify({
        type: "report",
        id: this.lastID,
        reporter,
        offender,
        messageId,
        text: messageText,
        channel,
        reason: banReason,
        ts: Date.now(),
      });
      if (wss) {
        wss.clients.forEach((c) => {
          if (
            c.readyState === WebSocket.OPEN &&
            MOD_USERS.has(c.username)
          ) {
            c.send(payload);
          }
        });
      }
      res.json({ success: true });
    }
  );
});

app.post("/api/reportAttachment", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const reporter = auth.username;
  const { attachmentId, offender, channel, reason } = req.body || {};
  const attId = parseInt(attachmentId, 10);
  if (!attId || !offender || !channel || !reason) {
    return res.status(400).json({ error: "Missing fields" });
  }
  const cleanReason = safeReason(reason);
  db.get(
    `SELECT attachments.id as id, attachments.originalName, attachments.mime,
            messages.id as messageId, messages.user as owner
     FROM attachments
     JOIN messages ON attachments.messageId = messages.id
     WHERE attachments.id=?`,
    [attId],
    (err, row) => {
      if (err) {
        console.error("Report attachment lookup error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      if (!row) return res.status(404).json({ error: "Attachment not found" });
      db.run(
        `INSERT INTO reports (reporter, offender, attachmentId, attachmentName, messageId, messageText, channel, reason, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          reporter,
          offender,
          attId,
          row.originalName || row.mime || "",
          row.messageId,
          `[attachment] ${row.originalName || row.mime || ""}`,
          channel,
          cleanReason,
          Date.now(),
        ],
        function (insertErr) {
          if (insertErr) {
            console.error("DB error:", insertErr);
            return res.status(500).json({ error: "DB error" });
          }
          logModEvent(
            reporter,
            "report_attachment",
            offender,
            `Reason: ${cleanReason} | Attachment: ${row.originalName || row.mime || ""}`
          );
          res.json({ success: true });
        }
      );
    }
  );
});

app.get("/api/reports", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const admin = auth.username;
  if (!MOD_USERS.has(admin))
    return res.status(403).json({ error: "Not moderator" });
  db.all("SELECT * FROM reports ORDER BY id DESC", (err, rows) => {
    if (err) return res.status(500).json({ error: "Database error" });
    res.json({ reports: rows });
  });
});

app.get("/api/modLogs", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const admin = auth.username;
  if (!MOD_USERS.has(admin))
    return res.status(403).json({ error: "Not moderator" });
  db.all(
    "SELECT id,actor,action,target,details,ts FROM mod_logs ORDER BY id DESC LIMIT 200",
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json({ logs: rows });
    }
  );
});

app.post("/api/adminCommand", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const admin = auth.username;
  if (!MOD_USERS.has(admin))
    return res.status(403).json({ error: "Not moderator" });
  const { command, reason: providedReason } = req.body || {};
  if (!command) return res.status(400).json({ error: "Missing command" });
  const trimmed = command.trim();
  const matchCmd = trimmed.match(/^\/\w+/);
  if (!matchCmd) return res.status(400).json({ error: "Invalid command" });
  const cmd = matchCmd[0].toLowerCase();
  const rest = trimmed.slice(matchCmd[0].length).trim();
  let target = "";
  let inlineReason = "";
  if (rest.startsWith('"')) {
    const endQuote = rest.indexOf('"', 1);
    if (endQuote !== -1) {
      target = rest.slice(1, endQuote);
      inlineReason = rest.slice(endQuote + 1).trim();
    } else {
      target = rest.slice(1);
    }
  } else {
    const parts = rest.split(/\s+/);
    target = parts.shift() || "";
    inlineReason = parts.join(" ").trim();
  }
  const banReason = (providedReason || "").trim() || inlineReason;
  if (!target) return res.status(400).json({ error: "Target required" });
  if (cmd === "/ban") {
    updateModState(target, "isBanned", 1, {
      reason: banReason || `Banned by ${admin}`,
      actor: admin,
    });
    logModEvent(
      admin,
      "ban",
      target,
      banReason ? `Admin /ban - ${banReason}` : "Admin /ban"
    );
  } else if (cmd === "/mute") {
    const minutes = parseInt(parts[2] || "10", 10);
    mutedUntil.set(target, Date.now() + minutes * 60 * 1000);
    logModEvent(admin, "mute", target, `Muted for ${minutes}m`);
  } else if (cmd === "/kick") {
    if (wss) {
      wss.clients.forEach((c) => {
        if (c.username === target) c.close();
      });
    }
    logModEvent(admin, "kick", target, "Admin /kick");
  } else if (cmd === "/shadowban") {
    updateModState(target, "isShadowBanned", 1);
    logModEvent(admin, "shadowban", target, "Admin /shadowban");
  }
  res.json({ success: true });
});

// --------------------------------------------------
// APPEALS
// --------------------------------------------------
app.post("/api/appealBan", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const { username, message } = req.body || {};
  if (!username || !message)
    return res
      .status(400)
      .json({ error: "Missing username or message" });
  db.run(
    `INSERT INTO ban_appeals (username, message, ts) VALUES (?, ?, ?)`,
    [username, message, Date.now()],
    function (err) {
      if (err) return res.status(500).json({ error: "DB error" });
      logModEvent("user", "ban_appeal", username, message);
      const payload = JSON.stringify({
        type: "ban_appeal",
        id: this.lastID,
        username,
        message,
      });
      if (wss) {
        wss.clients.forEach((c) => {
          if (
            c.readyState === WebSocket.OPEN &&
            MOD_USERS.has(c.username)
          ) {
            c.send(payload);
          }
        });
      }
      res.json({ success: true });
    }
  );
});

app.get("/api/appeals", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const admin = auth.username;
  if (!MOD_USERS.has(admin))
    return res.status(403).json({ error: "Not moderator" });
  db.all(
    "SELECT id, username, message, ts, status FROM ban_appeals ORDER BY id DESC",
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      res.json({ appeals: rows });
    }
  );
});

app.post("/api/appeals/update", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const admin = auth.username;
  if (!MOD_USERS.has(admin))
    return res.status(403).json({ error: "Not moderator" });
  const { id, status } = req.body || {};
  if (!id || !status)
    return res.status(400).json({ error: "Missing id or status" });
  db.get("SELECT username FROM ban_appeals WHERE id=?", [id], (err, appRow) => {
    if (err || !appRow)
      return res.status(400).json({ error: "Appeal not found" });
    db.run("UPDATE ban_appeals SET status=? WHERE id=?", [status, id]);
    if (status === "approved") {
      updateModState(appRow.username, "isBanned", 0);
      updateModState(appRow.username, "isShadowBanned", 0);
      updateModState(appRow.username, "warnings", 0);
      mutedUntil.delete(appRow.username);
      logModEvent(
        admin,
        "appeal_approved_unban",
        appRow.username,
        "User unbanned due to approved appeal"
      );
    }
    if (status === "rejected") {
      logModEvent(
        admin,
        "appeal_rejected",
        appRow.username,
        "Appeal rejected"
      );
    }
    const payload = JSON.stringify({
      type: "appeal_update",
      id,
      status,
      username: appRow.username,
    });
    if (wss) {
      wss.clients.forEach((c) => {
        if (c.readyState === WebSocket.OPEN && MOD_USERS.has(c.username)) {
          c.send(payload);
        }
      });
    }
    res.json({ success: true });
  });
});

app.delete("/api/appeals/:id", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const admin = auth.username;
  if (!MOD_USERS.has(admin))
    return res.status(403).json({ error: "Not moderator" });
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "Invalid appeal id" });
  db.get("SELECT username FROM ban_appeals WHERE id=?", [id], (err, row) => {
    if (err) return res.status(500).json({ error: "DB error" });
    if (!row) return res.status(404).json({ error: "Appeal not found" });
    db.run("DELETE FROM ban_appeals WHERE id=?", [id], (delErr) => {
      if (delErr) return res.status(500).json({ error: "DB error" });
      logModEvent(admin, "appeal_delete", row.username, `Appeal #${id} removed`);
      const payload = JSON.stringify({
        type: "appeal_delete",
        id,
        username: row.username,
      });
      if (wss) {
        wss.clients.forEach((c) => {
          if (c.readyState === WebSocket.OPEN && MOD_USERS.has(c.username)) {
            c.send(payload);
          }
        });
      }
      res.json({ success: true });
    });
  });
});

// --------------------------------------------------
// TOXICITY / STATUS / FRIENDS
// --------------------------------------------------
app.post("/api/setToxicity", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  const { level } = req.body || {};
  const lvl = Math.max(1, Math.min(10, parseInt(level || "5", 10)));
  getUserModState(user, () => {
    updateModState(user, "toxicity", lvl);
    res.json({ success: true });
  });
});

app.get("/api/onlineUsers", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  if (!wss) return res.json({ users: [] });
  const set = new Set();
  wss.clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN && c.username) set.add(c.username);
  });
  res.json({ users: Array.from(set) });
});

app.get("/api/friends", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  db.all(
    "SELECT friend FROM friends WHERE username=? ORDER BY friend ASC",
    [user],
    (err, rows) => {
      if (err) return res.status(500).json({ error: "DB error" });
      const friends = rows.map((r) => r.friend);
      res.json({ friends });
    }
  );
});

app.post("/api/friends/add", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  const { friend } = req.body || {};
  if (!friend || friend === user)
    return res.status(400).json({ error: "Invalid friend" });
  db.serialize(() => {
    db.run(
      "INSERT OR IGNORE INTO friends (username, friend) VALUES (?, ?)",
      [user, friend]
    );
    db.run(
      "INSERT OR IGNORE INTO friends (username, friend) VALUES (?, ?)",
      [friend, user]
    );
  });
  logModEvent(user, "friend_add", friend, "Friendship created");
  res.json({ success: true });
});

app.post("/api/friends/remove", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  const { friend } = req.body || {};
  if (!friend) return res.status(400).json({ error: "Missing friend" });
  db.serialize(() => {
    db.run(
      "DELETE FROM friends WHERE username=? AND friend=?",
      [user, friend]
    );
    db.run(
      "DELETE FROM friends WHERE username=? AND friend=?",
      [friend, user]
    );
  });
  logModEvent(user, "friend_remove", friend, "Friendship removed");
  res.json({ success: true });
});

app.post("/api/friends/request", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  const { to } = req.body;
  if (!to || to === user) return res.status(400).json({ error: "bad user" });
  db.run(
    "INSERT OR IGNORE INTO friend_requests (from_user, to_user, created) VALUES (?, ?, ?)",
    [user, to, Date.now()],
    (err) => {
      if (err) return res.status(500).json({ error: "db error" });
      broadcastToUser(to, {
        type: "friend_request_received",
        from: user,
      });
      res.json({ success: true });
    }
  );
});

app.post("/api/friends/accept", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  const { from } = req.body;
  db.run(
    "DELETE FROM friend_requests WHERE from_user=? AND to_user=?",
    [from, user]
  );
  db.run(
    "INSERT OR IGNORE INTO friends (username, friend) VALUES (?, ?)",
    [user, from]
  );
  db.run(
    "INSERT OR IGNORE INTO friends (username, friend) VALUES (?, ?)",
    [from, user]
  );
  broadcastToUser(from, {
    type: "friend_request_accepted",
    by: user,
  });
  res.json({ success: true });
});

app.post("/api/friends/decline", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  const { from } = req.body;
  db.run(
    "DELETE FROM friend_requests WHERE from_user=? AND to_user=?",
    [from, user]
  );
  res.json({ success: true });
});

app.get("/api/friends/requests", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  db.all(
    "SELECT from_user FROM friend_requests WHERE to_user=?",
    [user],
    (err, incoming) => {
      db.all(
        "SELECT to_user FROM friend_requests WHERE from_user=?",
        [user],
        (err2, outgoing) => {
          res.json({
            incoming: incoming.map((r) => r.from_user),
            outgoing: outgoing.map((r) => r.to_user),
          });
        }
      );
    }
  );
});

app.get("/api/status", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const viewer = auth.username;
  const targetUser = req.query.user || viewer;
  db.get(
    "SELECT created FROM users WHERE username=?",
    [targetUser],
    (userErr, userRow) => {
      if (userErr) return res.status(500).json({ error: "DB error" });
      if (!userRow) return res.status(404).json({ error: "User not found" });
      const joined = userRow.created || 0;
      if (bannedUsers.has(targetUser)) {
        const banReason =
          bannedReasons.get(targetUser) || "Account banned";
        return res.json({ banned: true, banReason });
      }
      db.get(
        "SELECT state, message FROM status WHERE username=?",
        [targetUser],
        (err, row) => {
          if (err) return res.status(500).json({ error: "DB error" });
          if (!row)
            return res.json({
              state: "online",
              message: "",
              banned: false,
              joined,
            });
          res.json({ ...row, banned: false, joined });
        }
      );
    }
  );
});

app.post("/api/status", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const u = auth.username;
  const { state, message } = req.body;
  db.run(
    "INSERT INTO status (username, state, message) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET state=?, message=?",
    [u, state, message, state, message]
  );
  broadcastPresenceSnapshot();
  res.json({ success: true });
});

app.post("/api/avatar", (req, res) => {
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  upload.single("avatar")(req, res, (err) => {
    if (err) {
      console.error("Avatar upload failed:", err);
      return res.status(400).json({ error: err.message || "Upload failed" });
    }
    logModEvent(user, "avatar_update", user, "Updated avatar");
    res.json({ success: true, url: `/avatars/${user}.png` });
  });
});

app.get("/api/settings", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  db.get(
    "SELECT theme, uiScale FROM user_settings WHERE username=?",
    [user],
    (err, row) => {
      if (err) {
        console.error("Settings load error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      res.json({
        theme: row?.theme || "classic",
        uiScale:
          typeof row?.uiScale === "number" && Number.isFinite(row.uiScale)
            ? row.uiScale
            : 1,
      });
    }
  );
});

app.post("/api/settings", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  const { theme, uiScale } = req.body || {};
  const allowedThemes = new Set(["classic", "dark"]);
  let safeTheme = null;
  if (typeof theme !== "undefined") {
    if (allowedThemes.has(theme)) {
      safeTheme = theme;
    } else {
      return res.status(400).json({ error: "Invalid theme" });
    }
  }

  let safeScale = null;
  if (typeof uiScale !== "undefined") {
    const parsed = Number(uiScale);
    if (!Number.isFinite(parsed)) {
      return res.status(400).json({ error: "Invalid scale" });
    }
    const clamped = Math.min(1.4, Math.max(0.8, parsed));
    safeScale = clamped;
  }

  if (safeTheme === null && safeScale === null) {
    return res.status(400).json({ error: "No changes provided" });
  }

  db.run(
    "INSERT OR IGNORE INTO user_settings (username, theme, uiScale) VALUES (?, 'classic', 1)",
    [user],
    (insertErr) => {
      if (insertErr) {
        console.error("Settings ensure error:", insertErr);
        return res.status(500).json({ error: "DB error" });
      }
      db.run(
        "UPDATE user_settings SET theme=COALESCE(?, theme), uiScale=COALESCE(?, uiScale) WHERE username=?",
        [safeTheme, safeScale, user],
        (err) => {
          if (err) {
            console.error("Settings save error:", err);
            return res.status(500).json({ error: "DB error" });
          }
          db.get(
            "SELECT theme, uiScale FROM user_settings WHERE username=?",
            [user],
            (selErr, row) => {
              if (selErr || !row) {
                return res.json({
                  success: true,
                  theme: safeTheme ?? "classic",
                  uiScale: safeScale ?? 1,
                });
              }
              res.json({
                success: true,
                theme: row.theme || "classic",
                uiScale:
                  typeof row.uiScale === "number" && Number.isFinite(row.uiScale)
                    ? row.uiScale
                    : 1,
              });
            }
          );
        }
      );
    }
  );
});

app.post("/api/settings/resetToken", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;

  const toDelete = [];
  for (const [tok, name] of sessions.entries()) {
    if (name === user) toDelete.push(tok);
  }
  if (toDelete.length) {
    toDelete.forEach((t) => sessions.delete(t));
    deleteSessionsFromDb(toDelete);
  }

  const newToken = uuidv4();
  sessions.set(newToken, user);
  persistSession(newToken, user);

  res.json({
    success: true,
    token: newToken,
    revoked: toDelete.length,
  });
});

app.get("/api/settings/2fa", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  getUserRecord(user)
    .then((record) => {
      if (!record) return res.status(404).json({ error: "User not found" });
      const contact = {
        email: (record.email || "").trim(),
        phone: (record.phone || "").trim(),
      };
      res.json({
        email: contact.email,
        phone: contact.phone,
        maskedEmail: contact.email ? maskContact({ email: contact.email }) : "",
        maskedPhone: contact.phone ? maskContact({ phone: contact.phone }) : "",
        twoFactorEnabled: Number(record.twoFactorEnabled) === 1,
      });
    })
    .catch((err) => {
      console.error("2FA settings load error:", err);
      res.status(500).json({ error: "Internal server error" });
    });
});

app.post("/api/settings/2fa", (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  const email = (req.body?.email || "").trim();
  const phone = (req.body?.phone || "").trim();
  const twoFactorEnabled = req.body?.twoFactorEnabled ? 1 : 0;
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Valid email is required" });
  }
  db.run(
    "UPDATE users SET email=?, phone=?, twoFactorEnabled=? WHERE username=?",
    [email, phone, twoFactorEnabled, user],
    (err) => {
      if (err) {
        console.error("2FA settings save error:", err);
        return res.status(500).json({ error: "DB error" });
      }
      res.json({
        success: true,
        email,
        phone,
        maskedEmail: email ? maskContact({ email }) : "",
        maskedPhone: phone ? maskContact({ phone }) : "",
        twoFactorEnabled: twoFactorEnabled === 1,
      });
    }
  );
});

app.post("/api/settings/password", async (req, res) => {
  if (!checkHttpRateLimit(req, res)) return;
  const auth = requireAuthedUser(req, res);
  if (!auth) return;
  const user = auth.username;
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword)
    return res.status(400).json({ error: "Missing passwords" });
  if (newPassword.length < 6)
    return res.status(400).json({ error: "Password too short" });
  try {
    const record = await getUserRecord(user);
    if (!record) return res.status(404).json({ error: "User not found" });
    const valid = await bcrypt.compare(oldPassword, record.passwordHash);
    if (!valid)
      return res.status(400).json({ error: "Current password incorrect" });
    const hash = await bcrypt.hash(newPassword, 10);
    db.run(
      "UPDATE users SET passwordHash=? WHERE username=?",
      [hash, user],
      (err) => {
        if (err) {
          console.error("Password reset error:", err);
          return res.status(500).json({ error: "DB error" });
        }
        res.json({ success: true });
      }
    );
  } catch (err) {
    console.error("Password change error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// --------------------------------------------------
// WEBSOCKET SERVER + KEEPALIVE
// --------------------------------------------------
wss = new WebSocket.Server({ server });

function wsHeartbeat() {
  this.isAlive = true;
}

// Heartbeat disabled to avoid unintended disconnects; connections rely on client activity.
wsPingInterval = null;

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, "https://localhost");
    const token = url.searchParams.get("token");
    const channel = url.searchParams.get("channel") || "general";
    const session = resolveSessionUser(token);
    const username = session.username;

    if (!username) {
      if (session.banned) {
        const reason =
          bannedReasons.get(session.user) || "Account banned";
        ws.close(4003, reason);
      } else {
        ws.close(4001, "Invalid session");
      }
      return;
    }
    if (!userAllowedForChannel(username, channel)) {
      ws.close(4002, "Not allowed for channel");
      return;
    }

    ws.username = username;
    ws.channel = channel;
    ws.isAlive = true;
    if (usernameTooLong(ws.username)) {
      ws.close(4001, "Invalid username");
      return;
    }
    ws.on("pong", wsHeartbeat);

    broadcastPresenceSnapshot();

    // Suppress noisy join logs/broadcasts to avoid spam during reconnects

    ws.on("message", async (data) => {
      if (!checkWsRateLimit(ws)) return;
      let packet;
      try {
        packet = JSON.parse(data.toString());
      } catch (e) {
        console.warn("WS JSON parse error:", e);
        return;
      }

      if (packet.type === "typing") {
        const payload = JSON.stringify({
          type: "typing",
          user: ws.username,
        });
        wss.clients.forEach((c) => {
          if (
            c.readyState === WebSocket.OPEN &&
            c.channel === ws.channel &&
            c !== ws
          ) {
            c.send(payload);
          }
        });
        return;
      }

      if (packet.type !== "chat" || typeof packet.text !== "string") return;
      const text = packet.text.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text) return;

      getUserModState(ws.username, async (state) => {
        if (state.isBanned) {
          ws.send(
            JSON.stringify({
              type: "system",
              text: "You are banned and cannot send messages.",
            })
          );
          return;
        }
        if (isMuted(ws.username)) {
          ws.send(
            JSON.stringify({
              type: "system",
              text: "You are muted and cannot send messages.",
            })
          );
          return;
        }
        const sensitivity = state.toxicity || 5;
        let aiDecision = null;
        try {
          aiDecision = await moderateTextWithOpenAI(text);
        } catch (err) {
          console.warn("AI moderation failed:", err?.message || err);
        }
        if (aiDecision?.flagged) {
          const reasonText =
            aiDecision.reason || "AI moderation policy violation";
          mutedUntil.set(
            ws.username,
            Date.now() + 10 * 60 * 1000
          );
          logModEvent("auto-mod", "ai-auto-mute-delete", ws.username, reasonText);
          ws.send(
            JSON.stringify({
              type: "system",
              text: "Message removed and you are temporarily muted.",
            })
          );
          db.run(
            `INSERT INTO reports (reporter, offender, messageId, messageText, channel, reason, ts)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              "auto-mod",
              ws.username,
              null,
              text,
              ws.channel,
              reasonText,
              Date.now(),
            ]
          );
          return;
        }

        const baseScore = applyAutoModeration(
          ws.username,
          ws.channel,
          text
        );

        if (baseScore >= sensitivity + 3) {
          mutedUntil.set(
            ws.username,
            Date.now() + 10 * 60 * 1000
          );
          logModEvent("auto-mod", "auto-mute-delete", ws.username, text);
          ws.send(
            JSON.stringify({
              type: "system",
              text: "Message removed and you are temporarily muted.",
            })
          );
          db.run(
            `INSERT INTO reports (reporter, offender, messageId, messageText, channel, reason, ts)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              "auto-mod",
              ws.username,
              null,
              text,
              ws.channel,
              "Severe auto moderation",
              Date.now(),
            ]
          );
          return;
        } else if (baseScore >= sensitivity) {
          addWarning(ws.username);
          logModEvent("auto-mod", "auto-delete", ws.username, text);
          ws.send(
            JSON.stringify({
              type: "system",
              text: "Message removed due to rule violation.",
            })
          );
          db.run(
            `INSERT INTO reports (reporter, offender, messageId, messageText, channel, reason, ts)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              "auto-mod",
              ws.username,
              null,
              text,
              ws.channel,
              "Auto moderation",
              Date.now(),
            ]
          );
          return;
        }

        if (state.isShadowBanned) {
          const ghostMsg = {
            type: "chat",
            id: -1,
            user: ws.username,
            text,
            ts: Date.now(),
            deleted: 0,
            channel: ws.channel,
            shadow: true,
          };
          ws.send(JSON.stringify(ghostMsg));
          logModEvent(
            "auto-mod",
            "shadowban-message",
            ws.username,
            text
          );
          return;
        }

        const ts = Date.now();
        db.run(
          "INSERT INTO messages (channel, user, text, ts) VALUES (?, ?, ?, ?)",
          [ws.channel, ws.username, text, ts],
          function (err) {
            if (err) {
              console.error("DB error:", err);
              return;
            }
      const msg = {
        type: "chat",
        id: this.lastID,
        user: ws.username,
        text,
              ts,
              deleted: 0,
              channel: ws.channel,
            };
            const msgStr = JSON.stringify(msg);
            ws.send(msgStr);
            wss.clients.forEach((client) => {
              if (
                client !== ws &&
                client.readyState === WebSocket.OPEN &&
                client.channel === ws.channel
              ) {
                client.send(msgStr);
              }
            });
          }
        );
      });
    });

    ws.on("close", () => {
      // Suppress leave broadcast/log to reduce reconnect noise
      broadcastPresenceSnapshot();
    });

    ws.on("error", (err) => {
      console.error("WS socket error for", username, ":", err);
      // do NOT close here; let ping/terminate handle dead sockets
    });
  } catch (err) {
    console.error("WS connection error:", err);
    try {
      ws.close(1011, "Internal error");
    } catch (_) {}
  }
});

// --------------------------------------------------
// START
// --------------------------------------------------
server.listen(PORT, () => {
  console.log(`Chat running at http://localhost:${PORT}`);
});
