import express from "express";
import cors from "cors";
import compression from "compression";
import path from "path";
import fs from "fs";
import http from "http";
import https from "https";
import { fileURLToPath } from "url";
import { minify as terserMinify } from "terser";
import CleanCSS from "clean-css";
import { minify as htmlMinify } from "html-minifier-terser";
import JavaScriptObfuscator from "javascript-obfuscator";
import { DatabaseSync } from "node:sqlite";

import { initDb, get, run, all } from "./db.js";
import { getUserAuthState, requireAuth, verifyToken } from "./auth.js";
import { ensureTosFile } from "./tos.js";
import { runChatStartupModerationSweep } from "./routes/chat.js";

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
  moderationRouter,
  statsRouter,
  appealsRouter,
  storageRouter,
  libraryRouter,
  photonRouter,
  sdkRouter,
  customLevelsRouter,
  createChatRouter,
  gameEditorRouter,
  changelogRouter,
  roadmapRouter,
  gitInfoRouter
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
  ["moderationRouter", moderationRouter],
  ["statsRouter", statsRouter],
  ["appealsRouter", appealsRouter],
  ["storageRouter", storageRouter],
  ["libraryRouter", libraryRouter],
  ["photonRouter", photonRouter],
  ["sdkRouter", sdkRouter],
  ["customLevelsRouter", customLevelsRouter],
  ["createChatRouter", createChatRouter],
  ["gameEditorRouter", gameEditorRouter],
  ["changelogRouter", changelogRouter],
  ["roadmapRouter", roadmapRouter],
  ["gitInfoRouter", gitInfoRouter]
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
const LEGACY_GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "game_storage");
const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "save", "uploads", "games");
const TOS_PATH = path.join(PROJECT_ROOT, "/save/tos");
const ITEM_ICON_DIR = path.join(PROJECT_ROOT, "save", "item_icons");
const TURBOWARP_EXTENSION_PATH = path.join(PROJECT_ROOT, "web_src", "turbowarp-extension.js");
const CERT_DIR = path.join(PROJECT_ROOT, "Benno111 Chat");
const CERT_PATH = path.join(CERT_DIR, "cert.pem");
const KEY_PATH = path.join(CERT_DIR, "key.pem");
const MINIFY_ID_PATH = path.join(PROJECT_ROOT, "temp-prep.json");
let minifyIdState = null;
const VARENV_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.varenv || "false").toLowerCase()
);

function loadMinifyIdState() {
  const fallback = { name: 123456 };
  try {
    if (!fs.existsSync(MINIFY_ID_PATH)) {
      fs.writeFileSync(MINIFY_ID_PATH, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    const raw = fs.readFileSync(MINIFY_ID_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.name !== "number") {
      const merged = { ...(parsed && typeof parsed === "object" ? parsed : {}), ...fallback };
      fs.writeFileSync(MINIFY_ID_PATH, JSON.stringify(merged, null, 2));
      return fallback;
    }
    return { name: parsed.name };
  } catch {
    return fallback;
  }
}

function saveMinifyIdState(state) {
  try {
    let existing = {};
    try {
      if (fs.existsSync(MINIFY_ID_PATH)) {
        existing = JSON.parse(fs.readFileSync(MINIFY_ID_PATH, "utf8")) || {};
      }
    } catch {
      existing = {};
    }
    const merged = { ...(existing && typeof existing === "object" ? existing : {}), name: state.name };
    fs.writeFileSync(MINIFY_ID_PATH, JSON.stringify(merged, null, 2));
  } catch {
    // Best-effort only.
  }
}

function stripLineCommentsPreserveUrls(text) {
  return text.split("\n").map((line) => {
    const idx = line.indexOf("//");
    if (idx === -1) return line;
    if (idx > 0 && line[idx - 1] === ":") return line;
    return line.slice(0, idx);
  }).join("\n");
}

function stripJsComments(text) {
  let out = "";
  let i = 0;
  let state = "normal";
  let quote = "";
  let prevNonSpace = "";
  let regexCharClass = false;
  const regexStarters = new Set("([{=:+-!*,?;|&~<>^%".split(""));

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (state === "normal") {
      if (ch === "/" && next === "/" && !(i > 0 && text[i - 1] === ":")) {
        state = "line";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (ch === "'" || ch === "\"" || ch === "`") {
        state = "string";
        quote = ch;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === "/" && (prevNonSpace === "" || regexStarters.has(prevNonSpace))) {
        state = "regex";
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      if (!/\s/.test(ch)) prevNonSpace = ch;
      i += 1;
      continue;
    }

    if (state === "line") {
      if (ch === "\n") {
        out += "\n";
        state = "normal";
        prevNonSpace = "";
      }
      i += 1;
      continue;
    }

    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "normal";
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (state === "string") {
      out += ch;
      if (ch === "\\") {
        out += next || "";
        i += 2;
        continue;
      }
      if (ch === quote) {
        state = "normal";
      }
      i += 1;
      continue;
    }

    if (state === "regex") {
      out += ch;
      if (ch === "\\") {
        out += next || "";
        i += 2;
        continue;
      }
      if (ch === "[") regexCharClass = true;
      if (ch === "]") regexCharClass = false;
      if (ch === "/" && !regexCharClass) {
        state = "normal";
      }
      i += 1;
    }
  }
  return out;
}

function minifyJsFallback(text) {
  const noComments = stripJsComments(text);
  return noComments.replace(/\s+/g, " ").trim();
}

function collectJsDeclaredIdentifiers(text) {
  const identifiers = new Set();
  let i = 0;
  let state = "normal";
  let quote = "";
  let prevNonSpace = "";
  const isIdentStart = (ch) => /[A-Za-z_$]/.test(ch);
  const isIdent = (ch) => /[A-Za-z0-9_$]/.test(ch);
  const regexStarters = new Set("([{=:+-!*,?;|&~<>^%".split(""));

  const readIdent = () => {
    let start = i;
    i += 1;
    while (i < text.length && isIdent(text[i])) i += 1;
    return text.slice(start, i);
  };

  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1;
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (state === "normal") {
      if (ch === "/" && next === "/" && !(i > 0 && text[i - 1] === ":")) {
        state = "line";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (ch === "'" || ch === "\"" || ch === "`") {
        state = "string";
        quote = ch;
        i += 1;
        continue;
      }
      if (ch === "/" && (prevNonSpace === "" || regexStarters.has(prevNonSpace))) {
        state = "regex";
        i += 1;
        continue;
      }

      if (isIdentStart(ch)) {
        const word = readIdent();
        if (word === "var" || word === "let" || word === "const") {
          skipSpace();
          while (i < text.length) {
            if (text[i] === ";" || text[i] === "\n") break;
            if (isIdentStart(text[i])) {
              const name = readIdent();
              identifiers.add(name);
              skipSpace();
              if (text[i] === "=") {
                i += 1;
                continue;
              }
              if (text[i] === ",") {
                i += 1;
                skipSpace();
                continue;
              }
            } else {
              i += 1;
            }
          }
        }
        if (word.length) prevNonSpace = word[word.length - 1];
        continue;
      }

      if (!/\s/.test(ch)) prevNonSpace = ch;
      i += 1;
      continue;
    }

    if (state === "line") {
      if (ch === "\n") {
        state = "normal";
        prevNonSpace = "";
      }
      i += 1;
      continue;
    }

    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "normal";
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (state === "string") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) {
        state = "normal";
      }
      i += 1;
      continue;
    }

    if (state === "regex") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "/") state = "normal";
      i += 1;
    }
  }

  return identifiers;
}

function renameJsIdentifiers(text, renameMap) {
  let out = "";
  let i = 0;
  let state = "normal";
  let quote = "";
  let prevNonSpace = "";
  let regexCharClass = false;
  const isIdentStart = (ch) => /[A-Za-z_$]/.test(ch);
  const isIdent = (ch) => /[A-Za-z0-9_$]/.test(ch);
  const regexStarters = new Set("([{=:+-!*,?;|&~<>^%".split(""));

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (state === "normal") {
      if (ch === "/" && next === "/" && !(i > 0 && text[i - 1] === ":")) {
        state = "line";
        out += ch + next;
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        out += ch + next;
        i += 2;
        continue;
      }
      if (ch === "'" || ch === "\"" || ch === "`") {
        state = "string";
        quote = ch;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === "/" && (prevNonSpace === "" || regexStarters.has(prevNonSpace))) {
        state = "regex";
        out += ch;
        i += 1;
        continue;
      }

      if (isIdentStart(ch)) {
        let start = i;
        i += 1;
        while (i < text.length && isIdent(text[i])) i += 1;
        const word = text.slice(start, i);
        out += renameMap[word] || word;
        prevNonSpace = word[word.length - 1];
        continue;
      }

      out += ch;
      if (!/\s/.test(ch)) prevNonSpace = ch;
      i += 1;
      continue;
    }

    if (state === "line") {
      out += ch;
      if (ch === "\n") {
        state = "normal";
        prevNonSpace = "";
      }
      i += 1;
      continue;
    }

    if (state === "block") {
      out += ch;
      if (ch === "*" && next === "/") {
        out += next;
        state = "normal";
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (state === "string") {
      out += ch;
      if (ch === "\\") {
        out += next || "";
        i += 2;
        continue;
      }
      if (ch === quote) {
        state = "normal";
      }
      i += 1;
      continue;
    }

    if (state === "regex") {
      out += ch;
      if (ch === "\\") {
        out += next || "";
        i += 2;
        continue;
      }
      if (ch === "[") regexCharClass = true;
      if (ch === "]") regexCharClass = false;
      if (ch === "/" && !regexCharClass) {
        state = "normal";
      }
      i += 1;
    }
  }

  return out;
}

function obfuscateInlineJs(text, idState) {
  const declared = collectJsDeclaredIdentifiers(text);
  const renameMap = {};
  for (const name of declared) {
    if (!renameMap[name]) {
      renameMap[name] = `var${idState.name}`;
      idState.name += 1;
    }
  }
  if (!Object.keys(renameMap).length) return text;
  return renameJsIdentifiers(text, renameMap);
}

function minifyCssFallback(text) {
  const noComments = stripLineCommentsPreserveUrls(
    text.replace(/\/\*[\s\S]*?\*\//g, "")
  );
  return noComments
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>+~])\s*/g, "$1")
    .replace(/;}/g, "}")
    .trim();
}

function minifyHtmlFallback(text, idState) {
  let html = text.replace(/<!--[\s\S]*?-->/g, "");

  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, body) => {
    const obfuscated = idState && VARENV_ENABLED ? obfuscateInlineJs(body, idState) : body;
    const min = minifyJsFallback(obfuscated);
    return `<script${attrs}>${min}</script>`;
  });

  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (match, attrs, body) => {
    const min = minifyCssFallback(body);
    return `<style${attrs}>${min}</style>`;
  });

  const noComments = stripLineCommentsPreserveUrls(html);
  return noComments
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .replace(/\s*=\s*/g, "=")
    .trim();
}

function looksLikeModuleJs(text) {
  return /^\s*(import|export)\s/m.test(String(text || ""));
}

function obfuscateJsWithLibrary(text) {
  return JavaScriptObfuscator.obfuscate(text, {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: "hexadecimal",
    renameGlobals: false,
    simplify: true,
    splitStrings: false,
    stringArray: true,
    stringArrayRotate: true,
    transformObjectKeys: false
  }).getObfuscatedCode();
}

async function minifyJs(text, options = {}) {
  const source = String(text || "");
  const shouldObfuscate = Boolean(options.obfuscate) && !looksLikeModuleJs(source);
  const prepared = shouldObfuscate ? obfuscateJsWithLibrary(source) : source;
  try {
    const result = await terserMinify(prepared, {
      compress: {
        passes: 2,
        drop_debugger: true
      },
      format: {
        comments: false
      },
      mangle: shouldObfuscate ? false : {
        toplevel: !options.inline
      },
      module: Boolean(options.module)
    });
    return String(result?.code || "").trim() || minifyJsFallback(prepared);
  } catch {
    return minifyJsFallback(prepared);
  }
}

async function minifyCss(text) {
  try {
    const result = new CleanCSS({
      level: 2
    }).minify(String(text || ""));
    if (!result.errors?.length && result.styles) {
      return result.styles.trim();
    }
  } catch {
    // Fallback below.
  }
  return minifyCssFallback(text);
}

async function minifyHtml(text, idState) {
  const source = String(text || "");
  const processed = source.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, body) => {
    const isModule = /\btype\s*=\s*["']module["']/i.test(attrs);
    if (!idState || !VARENV_ENABLED || isModule) return match;
    return `<script${attrs}>${obfuscateJsWithLibrary(body)}</script>`;
  });
  try {
    return await htmlMinify(processed, {
      collapseBooleanAttributes: true,
      collapseWhitespace: true,
      minifyCSS: (css) => minifyCssFallback(css),
      minifyJS: (js) => minifyJsFallback(js),
      removeAttributeQuotes: true,
      removeComments: true,
      removeEmptyAttributes: false,
      sortAttributes: true,
      sortClassName: true
    });
  } catch {
    return minifyHtmlFallback(processed, idState);
  }
}

async function minifyText(text, ext) {
  if (ext === ".js") return minifyJs(text, { obfuscate: VARENV_ENABLED, module: looksLikeModuleJs(text) });
  if (ext === ".css") return minifyCss(text);
  if (ext === ".html") return minifyHtml(text, minifyIdState);
  return text;
}

async function minifyWebAssets(sourceDir, targetDir) {
  minifyIdState = loadMinifyIdState();
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
        const min = await minifyText(raw, ext);
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
  saveMinifyIdState(minifyIdState);
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

function escapeXml(value) {
  return String(value ?? "").replace(/[<>&'"]/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;"
  }[char]));
}

function buildSitemapXml(baseUrl) {
  const now = new Date().toISOString();
  const pages = [
    { path: "/", changefreq: "daily", priority: "1.0" },
    { path: "/games", changefreq: "daily", priority: "0.9" },
    { path: "/game", changefreq: "daily", priority: "0.8" },
    { path: "/blog", changefreq: "weekly", priority: "0.8" },
    { path: "/blog-post", changefreq: "weekly", priority: "0.6" },
    { path: "/changelog", changefreq: "weekly", priority: "0.8" },
    { path: "/marketplace", changefreq: "daily", priority: "0.8" },
    { path: "/market", changefreq: "daily", priority: "0.8" },
    { path: "/download", changefreq: "monthly", priority: "0.7" },
    { path: "/stats", changefreq: "weekly", priority: "0.6" },
    { path: "/tos", changefreq: "yearly", priority: "0.4" },
    { path: "/support", changefreq: "monthly", priority: "0.5" },
    { path: "/sitemap", changefreq: "weekly", priority: "0.5" },
    { path: "/version-info", changefreq: "daily", priority: "0.6" }
  ];

  const urls = pages.map((page) => `  <url>
    <loc>${escapeXml(baseUrl + page.path)}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

function moveDirectoryContents(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      moveDirectoryContents(sourcePath, targetPath);
      const remaining = fs.readdirSync(sourcePath);
      if (!remaining.length) {
        fs.rmdirSync(sourcePath);
      }
      continue;
    }

    if (fs.existsSync(targetPath)) {
      fs.rmSync(targetPath, { force: true });
    }
    fs.renameSync(sourcePath, targetPath);
  }
}

function migrateLegacyGameStorage() {
  if (!fs.existsSync(LEGACY_GAME_STORAGE_DIR)) {
    fs.mkdirSync(GAME_STORAGE_DIR, { recursive: true });
    return;
  }

  moveDirectoryContents(LEGACY_GAME_STORAGE_DIR, GAME_STORAGE_DIR);

  try {
    const remaining = fs.readdirSync(LEGACY_GAME_STORAGE_DIR);
    if (!remaining.length) {
      fs.rmdirSync(LEGACY_GAME_STORAGE_DIR);
    }
  } catch {
    // Best-effort cleanup only.
  }
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
      `SELECT id, username, role, is_banned, ban_reason, banned_at, timeout_until, timeout_reason,
              delete_at, deleted_at
       FROM users WHERE id=?`,
      [decoded.uid]
    );
    if (!u) return next();

    const banState = await getUserAuthState(u);
    if (banState.permaBan || (u.is_banned && banState.activeTempBan)) {
      return res.redirect("/Permanetly-Banned");
    }
    if ((banState.activeTempBan && !banState.hasOpenAppeal) || (u.timeout_until && u.timeout_until > banState.now)) {
      const until = banState.activeTempBan?.expires_at || u.timeout_until;
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
app.use("/api/mod", moderationRouter);
app.use("/api/stats", statsRouter);
app.use("/api/appeals", appealsRouter);
app.use("/api/storage", storageRouter);
app.use("/api/library", libraryRouter);
app.use("/api/photon", photonRouter);
app.use("/api/chat", createChatRouter({ projectRoot: PROJECT_ROOT }));
app.use("/api/gameeditor", gameEditorRouter);
app.use("/api/changelog", changelogRouter);
app.use("/api/roadmap", roadmapRouter);
app.use("/api/git-info", gitInfoRouter);
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

app.get("/tos.json", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const tos = await ensureTosFile(TOS_PATH);
    res.json(tos);
  } catch (err) {
    console.error("tos generate error", err);
    res.status(500).json({ error: "server_error" });
  }
});

/* -----------------------------
   WEB UI
----------------------------- */
app.use("/web_src/ide/ui", express.static(path.join(WEB_SOURCE_DIR, "ide", "ui")));
app.use("/", express.static(WEB_DIR, { extensions: ["html"] }));

app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(WEB_DIR, "assets", "favicon.ico"));
});

app.get("/sitemap.xml", (req, res) => {
  const host = req.get("host") || "localhost";
  const protocol = req.protocol || "http";
  const baseUrl = `${protocol}://${host}`;
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.send(buildSitemapXml(baseUrl));
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

function deleteCustomLevelsForUser(userId) {
  const levelsDir = path.join(PROJECT_ROOT, "save", "custom_levels");
  if (!fs.existsSync(levelsDir)) return;
  const files = fs.readdirSync(levelsDir).filter((name) => name.endsWith(".sqlite"));
  for (const file of files) {
    const dbPath = path.join(levelsDir, file);
    const db = new DatabaseSync(dbPath);
    db.prepare("DELETE FROM levels WHERE uploader_user_id=?").run(userId);
    db.close();
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
await Promise.resolve(migrateLegacyGameStorage());
await minifyWebAssets(WEB_SOURCE_DIR, WEB_DIR);
await initDb();
await runChatStartupModerationSweep();
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
