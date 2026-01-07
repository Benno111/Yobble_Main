import express from "express";
import cors from "cors";
import compression from "compression";
import path from "path";
import fs from "fs";
import http from "http";
import https from "https";
import { fileURLToPath } from "url";

import { initDb, get, run } from "./db.js";
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
  createChatRouter
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
  ["createChatRouter", createChatRouter]
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
      if (ext === ".html" || ext === ".css" || ext === ".js") {
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
app.get("/games/:slug", (req, res, next) => {
  if (req.path.split("/").length !== 3) return next();
  (async () => {
    try {
      const row = await get("SELECT is_hidden FROM games WHERE slug=?", [req.params.slug]);
      if (!row || row.is_hidden) {
        return res.redirect("/404.html?msg=" + encodeURIComponent("Game not found."));
      }
      return res.sendFile(path.join(WEB_DIR, "game.html"));
    } catch {
      return res.redirect("/404.html?msg=" + encodeURIComponent("Game not found."));
    }
  })();
});

/* -----------------------------
   RAW GAME FILES
----------------------------- */
app.use("/games/:slug", async (req, res, next) => {
  const slug = String(req.params.slug || "").trim();
  if (!slug) return res.sendStatus(404);
  try {
    const row = await get("SELECT is_hidden FROM games WHERE slug=?", [slug]);
    if (!row || row.is_hidden) return res.sendStatus(404);
  } catch {
    return res.sendStatus(500);
  }
  next();
});

app.use("/games/:slug/:version", async (req, res, next) => {
  const slug = String(req.params.slug || "").trim();
  const version = String(req.params.version || "").trim();
  if (!slug || !version) return res.sendStatus(404);

  try {
    const g = await get("SELECT id, owner_user_id FROM games WHERE slug=? AND is_hidden=0", [slug]);
    if (!g) return res.sendStatus(404);

    const v = await get(
      `SELECT approval_status, is_published
       FROM game_versions
       WHERE game_id=? AND version=?`,
      [g.id, version]
    );

    if (v && v.is_published === 1) return next();

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
      if (isOwner || isPrivileged) return next();

      if (v) {
        const wl = await get(
          `SELECT 1 FROM game_version_whitelist
           WHERE game_id=? AND version=? AND user_id=?
           LIMIT 1`,
          [g.id, version, req.user.uid]
        );
        if (wl) return next();
      }
      return res.status(403).send("Not authorized for this version.");
    });
  } catch {
    return res.status(500).send("Server error.");
  }
});

app.get("/games/:slug/:version/assets.json", async (req, res) => {
  const { slug, version } = req.params;
  if (!slug || !version) return res.sendStatus(400);

  try {
    const row = await get("SELECT is_hidden FROM games WHERE slug=?", [slug]);
    if (!row || row.is_hidden) return res.sendStatus(404);
  } catch {
    return res.sendStatus(500);
  }

  const dir = path.join(GAME_STORAGE_DIR, slug, version);
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

/* -----------------------------
   START
----------------------------- */
minifyWebAssets(WEB_SOURCE_DIR, WEB_DIR);
await initDb();

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
