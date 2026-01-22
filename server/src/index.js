import express from "express";
import cors from "cors";
import compression from "compression";
import path from "path";
import fs from "fs";
import http from "http";
import https from "https";
import sqlite3 from "sqlite3";
import { fileURLToPath } from "url";

import { initDb, get, run, all } from "./db.js";
import { requireAuth, verifyToken } from "./auth.js";

// ⭐ Single import for all routers
import {
  authRouter,
  gamesRouter,
  notificationsRouter,
  reviewsRouter,
  profileRouter,
  reportsRouter,
  gameHostingRouter,
  blogRouter,
  friendsRouter,
  inventoryRouter,
  marketRouter,
  walletRouter,
  moderationRouter,
  itemsRouter,
  statsRouter,
  appealsRouter,
  storageRouter,
  libraryRouter,
  photonRouter,
  sdkRouter,
  customLevelsRouter,
  createChatRouter,
  gameEditorRouter,
  changelogRouter
} from "./routes/_routers.js";
import { attachChatWs } from "./routes/chat.js";

const routerImports = [
  ["authRouter", authRouter],
  ["gamesRouter", gamesRouter],
  ["notificationsRouter", notificationsRouter],
  ["reviewsRouter", reviewsRouter],
  ["profileRouter", profileRouter],
  ["reportsRouter", reportsRouter],
  ["gameHostingRouter", gameHostingRouter],
  ["blogRouter", blogRouter],
  ["friendsRouter", friendsRouter],
  ["inventoryRouter", inventoryRouter],
  ["marketRouter", marketRouter],
  ["walletRouter", walletRouter],
  ["moderationRouter", moderationRouter],
  ["itemsRouter", itemsRouter],
  ["statsRouter", statsRouter],
  ["appealsRouter", appealsRouter],
  ["storageRouter", storageRouter],
  ["libraryRouter", libraryRouter],
  ["photonRouter", photonRouter],
  ["sdkRouter", sdkRouter],
  ["customLevelsRouter", customLevelsRouter],
  ["createChatRouter", createChatRouter],
  ["gameEditorRouter", gameEditorRouter],
  ["changelogRouter", changelogRouter]
];
console.log("[Routers]", routerImports.map(([name, ref]) => `${name}:${ref ? "ok" : "missing"}`).join(" | "));

/* -----------------------------
   PATH SETUP
----------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const WEB_DIR = path.join(PROJECT_ROOT, "temp", "web-runtime");
const WEB_SOURCE_DIR = fs.existsSync(path.join(PROJECT_ROOT, "web_src"))
  ? path.join(PROJECT_ROOT, "web_src")
  : (fs.existsSync(path.join(PROJECT_ROOT, "web_backup"))
      ? path.join(PROJECT_ROOT, "web_backup")
      : WEB_DIR);
const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "game_storage");
const TOS_PATH = path.join(PROJECT_ROOT, "/save/tos");
const ITEM_ICON_DIR = path.join(PROJECT_ROOT, "save", "item_icons");
const TURBOWARP_EXTENSION_PATH = path.join(PROJECT_ROOT, "web_src", "turbowarp-extension.js");
const CERT_DIR = path.join(PROJECT_ROOT, "Benno111 Chat");
const CERT_PATH = path.join(CERT_DIR, "cert.pem");
const KEY_PATH = path.join(CERT_DIR, "key.pem");

function minifyText(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock.split("\n").map((line) => {
    const idx = line.indexOf("//");
    if (idx === -1) return line;
    // Keep URLs like https://
    if (idx > 0 && line[idx - 1] === ":") return line;
    return line.slice(0, idx);
  }).join(" ");
  return noLine.replace(/\s+/g, " ").trim();
}

function minifyWebAssets(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    console.log(`[Minify] source missing: ${sourceDir}`);
    return;
  }
  console.log(`[Minify] source: ${sourceDir}`);
  console.log(`[Minify] target: ${targetDir}`);
  const stack = [sourceDir];
  let fileCount = 0;
  while (stack.length) {
    const dir = stack.pop();
    const rel = path.relative(sourceDir, dir);
    const outDir = path.join(targetDir, rel);
    fs.mkdirSync(outDir, { recursive: true });
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const srcPath = path.join(dir, entry.name);
      const dstPath = path.join(outDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(srcPath);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const relPath = path.join(rel, entry.name).replace(/\\/g, "/");
      const shouldBypassMinify = relPath.startsWith("js/pentapod/") || relPath.startsWith("ide/ui/");
      if ((ext === ".html" || ext === ".css" || ext === ".js") && !shouldBypassMinify) {
        const raw = fs.readFileSync(srcPath, "utf8");
        const min = minifyText(raw);
        fs.writeFileSync(dstPath, min + "\n");
      } else {
        fs.copyFileSync(srcPath, dstPath);
      }
      fileCount += 1;
      if (fileCount % 50 === 0) {
        console.log(`[Minify] processed ${fileCount} files...`);
      }
    }
  }
  console.log(`[Minify] done. processed ${fileCount} files.`);
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  if (!header) return null;
  const entries = header.split(";").map((part) => part.trim());
  for (const entry of entries) {
    if (!entry) continue;
    const idx = entry.indexOf("=");
    if (idx === -1) continue;
    const key = entry.slice(0, idx);
    if (key !== name) continue;
    return decodeURIComponent(entry.slice(idx + 1));
  }
  return null;
}

function enforceIframeHtml(req, res) {
  const fetchDest = String(req.headers["sec-fetch-dest"] || "");
  const ext = path.extname(req.path || "");
  const isHtmlRequest = !ext || ext === ".html";
  if (isHtmlRequest && fetchDest && fetchDest !== "iframe") {
    res.status(404).sendFile(path.join(WEB_DIR, "404.html"));
    return false;
  }
  return true;
}

function listFilesRecursive(baseDir, sub = "") {
  const abs = path.join(baseDir, sub);
  let out = [];

  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "assets.json") continue;

    const rel = path.join(sub, e.name);
    const full = path.join(baseDir, rel);

    if (e.isDirectory()) {
      out.push(...listFilesRecursive(baseDir, rel));
    } else {
      const stat = fs.statSync(full);
      out.push({
        path: rel.replace(/\\/g, "/"),
        size: stat.size
      });
    }
  }
  return out;
}

const app = express();
app.set("trust proxy", true);
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(compression());
app.use(express.json({ limit: "12mb" }));

app.get("/turbowarp-extension.js", (req, res) => {
  if (!fs.existsSync(TURBOWARP_EXTENSION_PATH)) {
    return res.status(404).send("not_found");
  }
  const host = req.headers.host || "";
  const port = host.includes(":") ? host.split(":").pop() : "";
  let apiBase = "";
  if (port === "5050") apiBase = "http://localhost:5050";
  else if (port === "3000") apiBase = "http://photography-cage.gl.at.ply.gg:52426";
  const raw = fs.readFileSync(TURBOWARP_EXTENSION_PATH, "utf8");
  const out = raw.replace("__API_BASE__", apiBase);
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.send(out);
});

app.use(async (req, res, next) => {
  const pathName = req.path || "";
  if (pathName.startsWith("/api")) return next();
  if (pathName.startsWith("/Permanetly-Banned")) return next();
  if (pathName.startsWith("/temporay-banned")) return next();
  if (pathName.startsWith("/appeal")) return next();

  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return next();

  try {
    const decoded = verifyToken(token);
    const u = await get(
      `SELECT id, is_banned, ban_reason, banned_at, timeout_until, timeout_reason
       FROM users WHERE id=?`,
      [decoded.uid]
    );
    if (!u) return next();

    const now = Date.now();
    const permaBan = await get(
      `SELECT reason, created_at
       FROM bans
       WHERE target_type='user' AND target_id=?
         AND lifted_at IS NULL
         AND expires_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [u.id]
    );
    let activeTempBan = null;
    if (!permaBan) {
      activeTempBan = await get(
        `SELECT id, reason, created_at, expires_at
         FROM bans
         WHERE target_type='user' AND target_id=?
           AND lifted_at IS NULL
           AND expires_at IS NOT NULL
           AND expires_at > ?
         ORDER BY created_at DESC
         LIMIT 1`,
        [u.id, now]
      );
      if (!activeTempBan && u.is_banned) {
        await run(
          `UPDATE users
           SET is_banned=0, ban_reason=NULL, banned_at=NULL
           WHERE id=?`,
          [u.id]
        );
        u.is_banned = 0;
        u.ban_reason = null;
        u.banned_at = null;
      }
    }

    if (permaBan || (u.is_banned && activeTempBan)) {
      return res.redirect("/Permanetly-Banned");
    }
    if (activeTempBan || (u.timeout_until && u.timeout_until > now)) {
      if (activeTempBan) {
        const appeal = await get(
          `SELECT id FROM ban_appeals WHERE ban_id=? AND status='open'`,
          [activeTempBan.id]
        );
        if (appeal) return next();
      }
      const until = activeTempBan?.expires_at || u.timeout_until;
      const qs = until ? `?until=${encodeURIComponent(until)}` : "";
      return res.redirect(`/temporay-banned${qs}`);
    }
  } catch {
    return next();
  }
  return next();
});

/* -----------------------------
   API MOUNTING (ONE PLACE)
----------------------------- */
app.use("/api/auth", authRouter);
app.use("/api/games", gamesRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/profile", profileRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/gamehosting", gameHostingRouter);
app.use("/api/blog", blogRouter);

app.use("/api/friends", friendsRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/market", marketRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/mod", moderationRouter);
app.use("/api/items", itemsRouter);
app.use("/api/stats", statsRouter);
app.use("/api/appeals", appealsRouter);
app.use("/api/storage", storageRouter);
app.use("/api/library", libraryRouter);
app.use("/api/photon", photonRouter);
app.use("/api/chat", createChatRouter({ projectRoot: PROJECT_ROOT }));
app.use("/api/gameeditor", gameEditorRouter);
app.use("/api/changelog", changelogRouter);
app.use("/sdk", cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use("/sdk", sdkRouter);
app.use("/api/games/custom-lvl", customLevelsRouter);

/* -----------------------------
   GAME LANDING PAGE
----------------------------- */
app.get("/games/:project", (req, res, next) => {
  if (req.path.split("/").length !== 3) return next();
  (async () => {
    try {
      const g = await get(
        `SELECT g.id, g.project, g.title, g.description, g.category, g.banner_path, g.screenshots_json, g.is_hidden,
                g.is_featured, g.custom_levels_enabled, g.owner_user_id,
                u.username AS owner_username, pr.display_name AS owner_display_name,
                (SELECT v.version FROM game_versions v
                 WHERE v.game_id=g.id AND v.is_published=1 AND v.approval_status='approved'
                 ORDER BY v.created_at DESC LIMIT 1) AS latest_version,
                (SELECT v.entry_html FROM game_versions v
                 WHERE v.game_id=g.id AND v.is_published=1 AND v.approval_status='approved'
                 ORDER BY v.created_at DESC LIMIT 1) AS entry_html
         FROM games g
         LEFT JOIN users u ON u.id = g.owner_user_id
         LEFT JOIN profiles pr ON pr.user_id = g.owner_user_id
         WHERE g.project=?`,
        [req.params.project]
      );
      if (!g || g.is_hidden) {
        return res.redirect("/404.html?msg=" + encodeURIComponent("Game not found."));
      }
      let user = null;
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (token) {
        try {
          const decoded = verifyToken(token);
          user = await get(
            "SELECT id, username, role FROM users WHERE id=?",
            [decoded.uid]
          );
        } catch {}
      }
      let screenshots = [];
      try{
        const parsed = JSON.parse(g.screenshots_json || "[]");
        screenshots = Array.isArray(parsed) ? parsed : [];
      }catch{}
      let stats = null;
      let reviews = null;
      if (user) {
        stats = await get(
          `SELECT playtime_ms, sessions, last_played
           FROM game_playtime
           WHERE user_id=? AND game_id=?`,
          [user.id, g.id]
        );
        const reviewRows = await all(
          `SELECT r.rating, r.comment, r.created_at, r.updated_at, u.username
           FROM game_reviews r
           JOIN users u ON u.id=r.user_id
           WHERE r.game_id=?
             AND (u.is_banned IS NULL OR u.is_banned=0)
           ORDER BY r.updated_at DESC
           LIMIT 100`,
          [g.id]
        );
        const avg = await get(
          `SELECT AVG(rating) AS avg, COUNT(*) AS count FROM game_reviews WHERE game_id=?`,
          [g.id]
        );
        reviews = { reviews: reviewRows, avg_rating: avg?.avg ?? null, count: avg?.count ?? 0 };
      }
      const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[c]));
      const fmtMs = (ms) => {
        const s = Math.floor((ms || 0) / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        return `${h}h ${m}m`;
      };
      const heroHtml = `
        <span class="badge accent">${escapeHtml(g.category || "Uncategorized")}</span>
        <h1>${escapeHtml(g.title || "Untitled Game")}</h1>
        <p>${escapeHtml(g.description || "No description yet.")}</p>
        <div class="hero-meta">
          <span class="badge">By ${escapeHtml(g.owner_display_name || g.owner_username || "Unknown")}</span>
        </div>
      `.trim();
      let heroArtHtml = "Launch ready";
      let heroArtStyle = "";
      if (g.banner_path) {
        heroArtHtml = "";
        heroArtStyle = ` style="background: linear-gradient(130deg,rgba(255,209,102,.2),rgba(20,26,36,.5)), url('${g.banner_path}') center/cover"`;
      }
      let mediaHtml = `<div class="muted">No media uploaded yet.</div>`;
      if (g.banner_path || screenshots.length) {
        const images = [];
        if (g.banner_path) {
          images.push(`<img src="${g.banner_path}" alt="Banner">`);
        }
        for (const s of screenshots) {
          images.push(`<img src="${s}" alt="Screenshot">`);
        }
        mediaHtml = `
          <h2>Media</h2>
          <div class="gallery" id="gallery">
            ${images.join("")}
          </div>
        `.trim();
      }
      let statsHtml = `<div class="muted">No stats yet.</div>`;
      if (stats) {
        statsHtml = `
          <div class="stats">
            <div class="stat">
              <div class="label">Your playtime</div>
              <div class="value">${escapeHtml(fmtMs(stats.playtime_ms || 0))}</div>
            </div>
            <div class="stat">
              <div class="label">Sessions</div>
              <div class="value">${escapeHtml(stats.sessions || 0)}</div>
            </div>
            <div class="stat">
              <div class="label">Last played</div>
              <div class="value">${escapeHtml(stats.last_played ? new Date(stats.last_played).toLocaleString() : "—")}</div>
            </div>
          </div>
        `.trim();
      }
      const levelsHtml = `<div class="muted">No custom levels yet.</div>`;
      let reviewBoxHtml = `<div class="muted">Reviews are unavailable for this account.</div>`;
      let reviewsHtml = `<div class="review-card muted">Reviews are unavailable.</div>`;
      if (user) {
        reviewBoxHtml = `
          <div class="muted">Leave a rating & comment</div>
          <div id="stars" style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
            <button data-star="1" class="secondary" style="width:auto">☆</button>
            <button data-star="2" class="secondary" style="width:auto">☆</button>
            <button data-star="3" class="secondary" style="width:auto">☆</button>
            <button data-star="4" class="secondary" style="width:auto">☆</button>
            <button data-star="5" class="secondary" style="width:auto">☆</button>
          </div>
          <textarea id="comment" rows="3" placeholder="Write your review (optional)"></textarea>
          <button class="primary" id="submitReview" style="margin-top:10px;width:auto">Submit</button>
          <div id="revStatus" class="muted" style="margin-top:8px"></div>
        `.trim();
        const reviewRows = Array.isArray(reviews?.reviews) ? reviews.reviews : [];
        if (reviewRows.length) {
          reviewsHtml = reviewRows.map((row) => {
            const userLink = `/profile.html?u=${encodeURIComponent(row.username)}`;
            const stars = "★".repeat(row.rating) + "☆".repeat(5 - row.rating);
            const when = new Date(row.updated_at || row.created_at).toLocaleString();
            return `
              <div class="review-card">
                <h3><a href="${userLink}">${escapeHtml(row.username)}</a> — ${stars}</h3>
                <div class="muted">${escapeHtml(when)}</div>
                <p>${row.comment ? escapeHtml(row.comment) : "<span class='muted'>No comment</span>"}</p>
              </div>
            `.trim();
          }).join("");
        } else {
          reviewsHtml = `<div class="review-card">No reviews yet.</div>`;
        }
      }
      const filePath = path.join(WEB_DIR, "game.html");
      const html = await fs.promises.readFile(filePath, "utf8");
      let injected = html;
      injected = injected.replace(
        /<div id="hero-main">[\s\S]*?<\/div>/,
        `<div id="hero-main" data-prefilled="1">${heroHtml}</div>`
      );
      injected = injected.replace(
        /<div id="hero-art" class="hero-art"[^>]*>[\s\S]*?<\/div>/,
        `<div id="hero-art" class="hero-art"${heroArtStyle}>${heroArtHtml}</div>`
      );
      injected = injected.replace(
        /(<section[^>]*id="stats"[^>]*>)[\s\S]*?(<\/section>)/,
        `$1${statsHtml}$2`
      );
      injected = injected.replace(
        /(<section[^>]*id="media"[^>]*>)[\s\S]*?(<\/section>)/,
        `$1${mediaHtml}$2`
      );
      if (g.custom_levels_enabled === 0) {
        injected = injected.replace(
          /<section[^>]*id="levels"[^>]*>[\s\S]*?<\/section>/,
          `<section class="card" id="levels" hidden></section>`
        );
      } else {
        injected = injected.replace(
          /(<section[^>]*id="levels"[^>]*>)[\s\S]*?(<\/section>)/,
          `$1${levelsHtml}$2`
        );
      }
      injected = injected.replace(
        /(<section[^>]*id="reviewBox"[^>]*>)[\s\S]*?(<\/section>)/,
        `$1${reviewBoxHtml}$2`
      );
      injected = injected.replace(
        /<div id="reviews"[^>]*>[\s\S]*?<\/div>/,
        `<div id="reviews" class="grid reviews-grid">${reviewsHtml}</div>`
      );
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.send(injected);
    } catch {
      return res.redirect("/404.html?msg=" + encodeURIComponent("Game not found."));
    }
  })();
});

/* -----------------------------
   RAW GAME FILES
----------------------------- */
app.use("/games/:project", async (req, res, next) => {
  const project = String(req.params.project || "").trim();
  if (!project) return res.sendStatus(404);
  try {
    const row = await get("SELECT is_hidden FROM games WHERE project=?", [project]);
    if (!row || row.is_hidden) return res.sendStatus(404);
  } catch {
    return res.sendStatus(500);
  }
  next();
});

app.use("/games/:project/:version", async (req, res, next) => {
  const project = String(req.params.project || "").trim();
  const version = String(req.params.version || "").trim();
  if (!project || !version) return res.sendStatus(404);

  try {
    const g = await get("SELECT id, owner_user_id FROM games WHERE project=? AND is_hidden=0", [project]);
    if (!g) return res.sendStatus(404);

    const v = await get(
      `SELECT approval_status, is_published
       FROM game_versions
       WHERE game_id=? AND version=?`,
      [g.id, version]
    );

    if (v && v.is_published === 1) {
      if (!enforceIframeHtml(req, res)) return;
      return next();
    }

    let h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) {
      const cookieToken = readCookie(req, "auth_token");
      if (cookieToken) {
        req.headers.authorization = `Bearer ${cookieToken}`;
        h = req.headers.authorization;
      }
    }
    if (!h.startsWith("Bearer ")) {
      return res.status(401).json({ error: "not_authenticated" });
    }
    return requireAuth(req, res, async () => {
      const isOwner = g.owner_user_id === req.user.uid;
      const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
      if (isOwner || isPrivileged) {
        if (!enforceIframeHtml(req, res)) return;
        return next();
      }

      if (v) {
        const wl = await get(
          `SELECT 1 FROM game_version_whitelist
           WHERE game_id=? AND version=? AND user_id=?
           LIMIT 1`,
          [g.id, version, req.user.uid]
        );
        if (wl) {
          if (!enforceIframeHtml(req, res)) return;
          return next();
        }
      }
      return res.status(403).send("Not authorized for this version.");
    });
  } catch {
    return res.status(500).send("Server error.");
  }
});

app.get("/games/:project/:version/assets.json", async (req, res) => {
  const { project, version } = req.params;
  if (!project || !version) return res.sendStatus(400);

  try {
    const row = await get("SELECT is_hidden FROM games WHERE project=?", [project]);
    if (!row || row.is_hidden) return res.sendStatus(404);
  } catch {
    return res.sendStatus(500);
  }

  const dir = path.join(GAME_STORAGE_DIR, project, version);
  if (!fs.existsSync(dir)) return res.sendStatus(404);

  res.setHeader("Cache-Control", "public, max-age=60");
  const assets = listFilesRecursive(dir);
  const fileMap = {};
  for (const entry of assets) {
    fileMap[entry.path] = { size: entry.size };
  }
  res.json({ [version]: fileMap });
});

app.use("/games", express.static(GAME_STORAGE_DIR, {
  extensions: ["html"]
}));

app.use("/save/item_icons", express.static(ITEM_ICON_DIR));

app.get("/tos.json", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(TOS_PATH, err => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

/* -----------------------------
   WEB UI
----------------------------- */
app.use("/web_src/ide/ui", express.static(path.join(WEB_SOURCE_DIR, "ide", "ui")));
app.use("/", express.static(WEB_DIR, { extensions: ["html"] }));

app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(WEB_DIR, "assets", "favicon.ico"));
});

app.get("/:page", (req, res, next) => {
  const p = String(req.params.page || "");
  if (p.includes(".") || p.includes("/")) return next();
  res.sendFile(path.join(WEB_DIR, p + ".html"), err => {
    if (err) next();
  });
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(WEB_DIR, "404.html"));
});

async function deleteCustomLevelsForUser(userId) {
  const levelsDir = path.join(PROJECT_ROOT, "save", "custom_levels");
  if (!fs.existsSync(levelsDir)) return;
  const files = fs.readdirSync(levelsDir).filter((name) => name.endsWith(".sqlite"));
  for (const file of files) {
    const dbPath = path.join(levelsDir, file);
    const db = new sqlite3.Database(dbPath);
    await new Promise((resolve) => {
      db.run("DELETE FROM levels WHERE uploader_user_id=?", [userId], () => {
        db.close(() => resolve());
      });
    });
  }
}

async function tableExists(name) {
  const row = await get(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    [name]
  );
  return !!row;
}

async function processAccountDeletions() {
  const now = Date.now();
  const rows = await all(
    "SELECT id, username FROM users WHERE delete_at IS NOT NULL AND delete_at <= ? AND deleted_at IS NULL",
    [now]
  );
  if (!rows.length) return;
  const hasInventory = await tableExists("inventory");
  const hasProfiles = await tableExists("profiles");
  const hasFriends = await tableExists("friends");
  const hasWallets = await tableExists("wallets");
  const hasWalletTransactions = await tableExists("wallet_transactions");
  const hasMarketplace = await tableExists("marketplace");
  const hasLauncherTokens = await tableExists("launcher_tokens");
  const hasReviews = await tableExists("game_reviews");
  const hasPlaytime = await tableExists("game_playtime");
  const hasUploads = await tableExists("game_uploads");
  const hasLibrary = await tableExists("user_library");
  const hasGames = await tableExists("games");

  for (const row of rows) {
    const userId = row.id;
    const deletedUsername = `deleted_${userId}`;
    if (hasInventory) {
      const invRows = await all(
        "SELECT item_id, qty FROM inventory WHERE user_id=?",
        [userId]
      );
      for (const item of invRows) {
        await run(
          `INSERT INTO inventory (user_id, item_id, qty)
           VALUES (0, ?, ?)
           ON CONFLICT(user_id, item_id) DO UPDATE SET qty=qty+excluded.qty`,
          [item.item_id, item.qty]
        );
      }
      await run("DELETE FROM inventory WHERE user_id=?", [userId]);
    }
    if (hasGames) {
      await run("UPDATE games SET owner_user_id=NULL WHERE owner_user_id=?", [userId]);
    }
    if (hasProfiles) await run("DELETE FROM profiles WHERE user_id=?", [userId]);
    if (hasFriends) await run("DELETE FROM friends WHERE user_id=? OR friend_id=?", [userId, userId]);
    if (hasWallets) await run("DELETE FROM wallets WHERE user_id=?", [userId]);
    if (hasWalletTransactions) await run("DELETE FROM wallet_transactions WHERE user_id=?", [userId]);
    if (hasMarketplace) await run("DELETE FROM marketplace WHERE seller_id=?", [userId]);
    if (hasLauncherTokens) await run("DELETE FROM launcher_tokens WHERE user_id=?", [userId]);
    if (hasReviews) await run("DELETE FROM game_reviews WHERE user_id=?", [userId]);
    if (hasPlaytime) await run("DELETE FROM game_playtime WHERE user_id=?", [userId]);
    if (hasUploads) await run("DELETE FROM game_uploads WHERE uploader_user_id=?", [userId]);
    if (hasLibrary) await run("DELETE FROM user_library WHERE user_id=?", [userId]);
    await deleteCustomLevelsForUser(userId);
    await run(
      `UPDATE users SET
        username=?,
        password_hash=NULL,
        role='user',
        is_banned=1,
        ban_reason='account_deleted',
        banned_at=?,
        timeout_until=NULL,
        timeout_reason=NULL,
        wallet_address=NULL,
        wallet_connected_at=NULL,
        wallet_label=NULL,
        delete_requested_at=NULL,
        delete_at=NULL,
        deleted_at=?,
        deleted_reason='account_deleted'
       WHERE id=?`,
      [deletedUsername, now, now, userId]
    );
  }
}

/* -----------------------------
   START
----------------------------- */
minifyWebAssets(WEB_SOURCE_DIR, WEB_DIR);
await initDb();
await processAccountDeletions();
setInterval(processAccountDeletions, 6 * 60 * 60 * 1000);

const PORT = Number(process.env.PORT || 5050);
const PORT2 = Number(process.env.PORT2 || 3000);
const server = http.createServer(app);
attachChatWs(server, { projectRoot: PROJECT_ROOT });
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

if (PORT2 && PORT2 !== PORT) {
  const server2 = http.createServer(app);
  attachChatWs(server2, { projectRoot: PROJECT_ROOT });
  server2.listen(PORT2, () => {
    console.log(`Server running at http://localhost:${PORT2}`);
  });
}

const HTTPS_PORT = Number(process.env.HTTPS_PORT || 5443);
if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
  const httpsServer = https.createServer({
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH)
  }, app);
  attachChatWs(httpsServer, { projectRoot: PROJECT_ROOT });
  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`Server running at https://localhost:${HTTPS_PORT}`);
  });
} else {
  console.log("HTTPS disabled: cert.pem/key.pem not found in Benno111 Chat/");
}
