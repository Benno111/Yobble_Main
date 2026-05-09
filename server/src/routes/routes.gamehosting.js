import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import unzipper from "unzipper";
import { requireAuth, requireRole } from "../auth.js";
import { get, run, all } from "../db.js";

export const gameHostingRouter = express.Router();

const SERVER_DIR = path.resolve(process.cwd());
const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
const TMP_DIR = path.join(PROJECT_ROOT, "save", "uploads", "game_zips");
fs.mkdirSync(TMP_DIR, { recursive:true });

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }
});

function projectify(s){
  return String(s||"")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"")
    .slice(0,80);
}

function safeVersionPath(baseDir, project, version){
  const full = path.join(baseDir, project, version);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(baseDir))) {
    throw new Error("unsafe_path");
  }
  return resolved;
}

function safeVersionFilePath(baseDir, project, version, fileName) {
  const versionDir = safeVersionPath(baseDir, project, version);
  const full = path.join(versionDir, fileName);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(versionDir + path.sep) && resolved !== versionDir) {
    throw new Error("unsafe_path");
  }
  return resolved;
}

function collectFilesRecursive(rootDir) {
  const files = [];
  const visit = (dir, relBase) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = relBase ? path.posix.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        visit(abs, rel);
      } else if (entry.isFile()) {
        files.push({ abs, rel });
      }
    }
  };
  visit(rootDir, "");
  return files;
}

function getMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".wav":
      return "audio/wav";
    case ".mp3":
      return "audio/mpeg";
    case ".ogg":
      return "audio/ogg";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function escapeInlineScript(text) {
  return String(text).replace(/<\/script/gi, "<\\/script");
}

function normalizePackedPath(value) {
  const raw = String(value || "").trim();
  if (!raw || /^(?:[a-z][a-z0-9+\-.]*:)?\/\//i.test(raw) || raw.startsWith("data:") || raw.startsWith("blob:")) {
    return "";
  }
  return raw.split("#")[0].split("?")[0].replace(/^[./\\]+/, "").replace(/^\/+/, "");
}

function rewriteCssUrls(cssText, assetUrls) {
  return String(cssText).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, quote, rawUrl) => {
    const rel = normalizePackedPath(rawUrl);
    return rel && assetUrls[rel] ? `url("${assetUrls[rel]}")` : match;
  });
}

function buildSingleFileGameHtml({ htmlPath, versionDir, project, version }) {
  const htmlText = fs.readFileSync(htmlPath, "utf8");
  const files = collectFilesRecursive(versionDir);
  const assetUrls = {};
  const textFiles = new Map();
  let projectJsonBase64 = null;

  for (const file of files) {
    const mime = getMimeType(file.rel);
    const buffer = fs.readFileSync(file.abs);
    if (file.rel === "assets/project.json") {
      projectJsonBase64 = buffer.toString("base64");
    }
    if (mime.startsWith("text/") || mime.includes("javascript") || mime.includes("json") || mime.includes("xml")) {
      textFiles.set(file.rel, buffer.toString("utf8"));
    }
    assetUrls[file.rel] = `data:${mime};base64,${buffer.toString("base64")}`;
  }

  let packed = htmlText;

  packed = packed.replace(
    /<script\b([^>]*?)src=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
    (match, pre, src, post) => {
      const rel = normalizePackedPath(src);
      const text = rel ? textFiles.get(rel) : null;
      if (!text || !rel.match(/\.(?:js|mjs)$/i)) return match;
      return `<script${pre}${post}>${escapeInlineScript(text)}</script>`;
    }
  );

  packed = packed.replace(
    /<link\b([^>]*?)href=["']([^"']+)["']([^>]*?)>/gi,
    (match, pre, href, post) => {
      const rel = normalizePackedPath(href);
      const text = rel ? textFiles.get(rel) : null;
      const isStylesheet = /rel=["'][^"']*stylesheet[^"']*["']/i.test(match);
      if (!text || !rel.match(/\.(?:css)$/i) || !isStylesheet) return match;
      return `<style${pre}${post}>${escapeInlineScript(rewriteCssUrls(text, assetUrls))}</style>`;
    }
  );

  packed = packed.replace(
    /<script>\s*const getProjectData = \(function\(\) \{[\s\S]*?xhr\.open\('GET', "\.\/assets\/project\.json"\);\s*xhr\.send\(\);\s*\}\);\s*\}\)\(\);\s*<\/script>/,
    () => {
      if (!projectJsonBase64) return "";
      return `
<script>
  window.__YOBBLE_PROJECT_JSON_B64__ = ${JSON.stringify(projectJsonBase64)};
  window.__YOBBLE_ASSET_URLS__ = ${JSON.stringify(assetUrls)};
  window.__YOBBLE_ASSET_URL = (assetPath) => window.__YOBBLE_ASSET_URLS__[assetPath] || assetPath;
  window.__YOBBLE_PROJECT_JSON_BUFFER__ = (() => {
    const bin = atob(window.__YOBBLE_PROJECT_JSON_B64__);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  })();
</script>
<script>
    const getProjectData = (function() {
      const storage = scaffolding.storage;
      storage.onprogress = (total, loaded) => {
        setProgress(interpolate(0.2, 0.98, loaded / total));
      };
      storage.addWebStore(
        [
          storage.AssetType.ImageVector,
          storage.AssetType.ImageBitmap,
          storage.AssetType.Sound,
          storage.AssetType.Font
        ].filter(i => i),
        (asset) => window.__YOBBLE_ASSET_URL('assets/' + asset.assetId + '.' + asset.dataFormat)
      );
      return () => Promise.resolve(window.__YOBBLE_PROJECT_JSON_BUFFER__.slice(0));
    })();
  </script>`;
    }
  );

  return packed;
}

function shellQuote(value){
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runProcess(command, args, options = {}){
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: "ignore",
      ...options
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function ensureVersionBackupZip(sourceDir, backupZipPath){
  if (fs.existsSync(backupZipPath)) {
    return backupZipPath;
  }

  fs.mkdirSync(path.dirname(backupZipPath), { recursive: true });
  const tempZipPath = path.join(TMP_DIR, `backup-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);

  try{
    if (process.platform === "win32") {
      const sourcePattern = path.join(sourceDir, "*");
      const psCommand = [
        "$ErrorActionPreference = 'Stop';",
        `Compress-Archive -Path ${shellQuote(sourcePattern)} -DestinationPath ${shellQuote(tempZipPath)} -Force`
      ].join(" ");
      await runProcess("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psCommand]);
    } else {
      await runProcess("zip", ["-qr", tempZipPath, "."], { cwd: sourceDir });
    }

    fs.copyFileSync(tempZipPath, backupZipPath);
    return backupZipPath;
  } finally {
    try {
      if (fs.existsSync(tempZipPath)) {
        fs.unlinkSync(tempZipPath);
      }
    } catch {}
  }
}

async function zipHasEntry(zipPath, entryHtml){
  const dir = await unzipper.Open.file(zipPath);
  const want = entryHtml.replace(/^[./]+/,"");
  return dir.files.some(f => f.path.replace(/\\/g,"/") === want);
}

async function safeExtract(zipPath, destDir){
  const dir = await unzipper.Open.file(zipPath);
  const root = path.resolve(destDir);

  for(const entry of dir.files){
    const rel = entry.path.replace(/\\/g,"/");
    if(!rel || rel.endsWith("/")) continue;

    const outPath = path.join(destDir, rel);
    const resolved = path.resolve(outPath);

    if(!resolved.startsWith(root + path.sep) && resolved !== root){
      // zip slip attempt
      continue;
    }

    fs.mkdirSync(path.dirname(resolved), { recursive:true });
    await new Promise((ok,err)=>{
      entry.stream()
        .pipe(fs.createWriteStream(resolved))
        .on("finish", ok)
        .on("error", err);
    });
  }
}

// Upload a webgame ZIP
// - Auto-creates the game entry if missing
// - Validates that entry_html exists (default index.html)
// - Stores upload history
// - Creates a pending version unless user is moderator/admin (auto-approved + published)
gameHostingRouter.post("/upload", requireAuth, upload.single("zip"), async (req,res)=>{
  const title = String(req.body?.title || "").trim();
  const projectInput = String(req.body?.project || "").trim();
  const project = projectify(projectInput || title);
  const version = String(req.body?.version || "").trim();
  const entry_html = String(req.body?.entry_html || "index.html").trim();

  const category = String(req.body?.category || "").trim().slice(0,50) || null;
  const description = String(req.body?.description || "").trim().slice(0,2000) || null;

  if(!project) return res.status(400).json({ error:"invalid_project" });
  if(!version || !req.file) return res.status(400).json({ error:"missing_fields" });

  // Upload validation: require entry_html (defaults to index.html)
  let okEntry = false;
  try{
    okEntry = await zipHasEntry(req.file.path, entry_html);
  }catch{
    return res.status(400).json({ error:"invalid_zip" });
  }
  if(!okEntry){
    return res.status(400).json({ error:"entry_not_found_in_zip", entry_html });
  }

  // Auto-create game if missing
  let game = await get("SELECT id, project, owner_user_id FROM games WHERE project=?", [project]);
  if(!game){
    const gTitle = title || project;
    await run(
      `INSERT INTO games(project,title,description,category,is_hidden,owner_user_id) VALUES(?,?,?,?,0,?)`,
      [project, gTitle, description, category, req.user.uid]
    );
    game = await get("SELECT id, project, owner_user_id FROM games WHERE project=?", [project]);
  }else{
    const isPrivileged = (req.user.role === "admin" || req.user.role === "moderator");
    if(!isPrivileged && game.owner_user_id && game.owner_user_id !== req.user.uid){
      return res.status(403).json({ error:"forbidden_owner" });
    }
    if(!game.owner_user_id){
      await run("UPDATE games SET owner_user_id=? WHERE id=?", [req.user.uid, game.id]);
      game.owner_user_id = req.user.uid;
    }
    // Update metadata if present (optional)
    if(title || description || category){
      await run(
        `UPDATE games SET
           title=COALESCE(NULLIF(?,''),title),
           description=COALESCE(?,description),
           category=COALESCE(?,category)
         WHERE id=?`,
        [title || "", description, category, game.id]
      );
    }
  }

  const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "save", "uploads", "games");
  const destDir = path.join(GAME_STORAGE_DIR, project, version);

  fs.mkdirSync(destDir, { recursive:true });

  try{
    await safeExtract(req.file.path, destDir);
  }catch{
    return res.status(400).json({ error:"invalid_zip" });
  }

  // Verify extracted file exists
  const entryPath = path.join(destDir, entry_html);
  if(!fs.existsSync(entryPath)){
    return res.status(400).json({ error:"entry_not_found_after_extract", entry_html });
  }

  const now = Date.now();
  const isPrivileged = (req.user.role === "admin" || req.user.role === "moderator");
  const approval_status = isPrivileged ? "approved" : "pending";

  // Insert or update version (upsert: re-uploading the same version string resets the record)
  await run(
    `INSERT INTO game_versions(game_id,version,entry_html,created_at,is_published,approval_status,approved_by,approved_at)
     VALUES(?,?,?,?,0,?,?,?)
     ON CONFLICT(game_id,version) DO UPDATE SET
       entry_html=excluded.entry_html,
       created_at=excluded.created_at,
       approval_status=excluded.approval_status,
       approved_by=excluded.approved_by,
       approved_at=excluded.approved_at,
       is_published=0,
       rejected_reason=NULL`,
    [game.id, version, entry_html, now, approval_status, isPrivileged ? req.user.uid : null, isPrivileged ? now : null]
  );

  // If privileged, publish this version immediately (without unpublishing others)
  if(isPrivileged){
    await run("UPDATE game_versions SET is_published=1 WHERE game_id=? AND version=?", [game.id, version]);
  }

  // Upload history
  await run(
    `INSERT INTO game_uploads(uploader_user_id,game_id,version,storage_path,created_at)
     VALUES(?,?,?,?,?)`,
    [req.user.uid, game.id, version, path.relative(PROJECT_ROOT, destDir), now]
  );

  try{
    const backupZipPath = path.join(destDir, "backup.zip");
    fs.copyFileSync(req.file.path, backupZipPath);
  }catch{
    // Best-effort only. The extracted version is still usable if this fails.
  }

  res.json({
    ok:true,
    project,
    version,
    approval_status,
    published: isPrivileged ? 1 : 0,
    url: `/games/${project}/${version}/${entry_html}`
  });
});

// List versions + upload history for a game
gameHostingRouter.get("/versions", requireAuth, async (req,res)=>{
  const project = String(req.query?.project || "").trim();
  if(!project) return res.status(400).json({ error:"missing_project" });

  const g = await get(
    "SELECT id, project, title, description, category, owner_user_id, custom_levels_enabled FROM games WHERE project=?",
    [project]
  );
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const isPrivileged = (req.user.role === "admin" || req.user.role === "moderator");
  const isOwner = g.owner_user_id === req.user.uid;

  const versions = await all(
    `SELECT v.version, v.entry_html, v.created_at, v.is_published, v.approval_status, v.rejected_reason,
            u.username AS approved_by_username
     FROM game_versions v
     LEFT JOIN users u ON u.id=v.approved_by
     WHERE v.game_id=?
     ORDER BY v.created_at DESC`,
    [g.id]
  );

  const uploads = await all(
    isPrivileged
      ? `SELECT gu.version, gu.created_at, u.username AS uploader
         FROM game_uploads gu
         LEFT JOIN users u ON u.id=gu.uploader_user_id
         WHERE gu.game_id=?
         ORDER BY gu.created_at DESC
         LIMIT 200`
      : `SELECT gu.version, gu.created_at, u.username AS uploader
         FROM game_uploads gu
         LEFT JOIN users u ON u.id=gu.uploader_user_id
         WHERE gu.game_id=? AND gu.uploader_user_id=?
         ORDER BY gu.created_at DESC
         LIMIT 200`,
    isPrivileged ? [g.id] : [g.id, req.user.uid]
  );

  const filteredVersions = (isPrivileged || isOwner)
    ? versions
    : versions.filter(v => v.approval_status === "approved");

  res.json({ game: g, versions: filteredVersions, uploads, can_manage: isPrivileged || isOwner });
});

// Whitelist management (owner/mod/admin)
gameHostingRouter.get("/whitelist", requireAuth, async (req, res) => {
  const project = String(req.query?.project || "").trim();
  const version = String(req.query?.version || "").trim();
  if(!project || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE project=?", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const isOwner = g.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  if(!isOwner && !isPrivileged) return res.status(403).json({ error:"forbidden_owner" });

  const rows = await all(
    `SELECT u.username
     FROM game_version_whitelist w
     JOIN users u ON u.id = w.user_id
     WHERE w.game_id=? AND w.version=?
     ORDER BY u.username COLLATE NOCASE ASC`,
    [g.id, version]
  );
  res.json({ usernames: rows.map(r => r.username) });
});

gameHostingRouter.post("/whitelist", requireAuth, async (req, res) => {
  const project = String(req.body?.project || "").trim();
  const version = String(req.body?.version || "").trim();
  const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
  if(!project || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE project=?", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const isOwner = g.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  if(!isOwner && !isPrivileged) return res.status(403).json({ error:"forbidden_owner" });

  const cleaned = Array.from(new Set(usernames.map(u => String(u || "").trim()).filter(Boolean)));
  const existing = cleaned.length
    ? await all(
        `SELECT id, username
         FROM users
         WHERE username IN (${cleaned.map(() => "?").join(",")})`,
        cleaned
      )
    : [];

  await run(
    `DELETE FROM game_version_whitelist WHERE game_id=? AND version=?`,
    [g.id, version]
  );

  const now = Date.now();
  for (const u of existing) {
    await run(
      `INSERT OR IGNORE INTO game_version_whitelist(game_id, version, user_id, added_at)
       VALUES(?,?,?,?)`,
      [g.id, version, u.id, now]
    );
  }

  res.json({ ok:true, added: existing.map(u => u.username) });
});

// Analytics summary for a game (owner/mod/admin)
gameHostingRouter.get("/analytics", requireAuth, async (req, res) => {
  const project = String(req.query?.project || "").trim();
  if(!project) return res.status(400).json({ error:"missing_project" });

  const g = await get("SELECT id, project, owner_user_id FROM games WHERE project=?", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const isOwner = g.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  if(!isOwner && !isPrivileged) return res.status(403).json({ error:"forbidden_owner" });

  const row = await get(
    `SELECT
       SUM(playtime_ms) AS total_playtime_ms,
       SUM(sessions) AS total_sessions,
       COUNT(*) AS players,
       MAX(last_played) AS last_played
     FROM game_playtime
     WHERE game_id=?`,
    [g.id]
  );

  res.json({ stats: {
    total_playtime_ms: row?.total_playtime_ms || 0,
    total_sessions: row?.total_sessions || 0,
    players: row?.players || 0,
    last_played: row?.last_played || null
  }});
});

// Can play a version (published or whitelisted)
gameHostingRouter.get("/can-play", requireAuth, async (req, res) => {
  const project = String(req.query?.project || "").trim();
  const version = String(req.query?.version || "").trim();
  if(!project || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE project=? AND is_hidden=0", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const v = await get(
    `SELECT is_published FROM game_versions WHERE game_id=? AND version=?`,
    [g.id, version]
  );
  if(!v) return res.status(404).json({ error:"version_not_found" });

  const isOwner = g.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  if (v.is_published === 1 || isOwner || isPrivileged) {
    return res.json({ can_play: true });
  }

  const wl = await get(
    `SELECT 1 FROM game_version_whitelist
     WHERE game_id=? AND version=? AND user_id=?
     LIMIT 1`,
    [g.id, version, req.user.uid]
  );
  if (wl) return res.json({ can_play: true });
  return res.status(403).json({ error:"not_whitelisted" });
});

// Playable versions for a user
gameHostingRouter.get("/playable-versions", requireAuth, async (req, res) => {
  const project = String(req.query?.project || "").trim();
  if(!project) return res.status(400).json({ error:"missing_project" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE project=? AND is_hidden=0", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const isOwner = g.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  if (isOwner || isPrivileged) {
    const rows = await all(
      `SELECT version, entry_html FROM game_versions WHERE game_id=? ORDER BY created_at DESC`,
      [g.id]
    );
    return res.json({ versions: rows });
  }

  const rows = await all(
    `SELECT version, entry_html FROM game_versions
     WHERE game_id=? AND is_published=1
     ORDER BY created_at DESC`,
    [g.id]
  );
  const publishedMap = new Map(rows.map(r => [r.version, r.entry_html]));
  const wlRows = await all(
    `SELECT gv.version, gv.entry_html
     FROM game_version_whitelist w
     JOIN game_versions gv ON gv.game_id=w.game_id AND gv.version=w.version
     WHERE w.game_id=? AND w.user_id=?`,
    [g.id, req.user.uid]
  );
  for (const r of wlRows) {
    if (!publishedMap.has(r.version)) publishedMap.set(r.version, r.entry_html);
  }
  res.json({ versions: Array.from(publishedMap, ([version, entry_html]) => ({ version, entry_html })) });
});

// Toggle custom level browser (owner/mod/admin)
gameHostingRouter.post("/custom-levels-toggle", requireAuth, async (req, res) => {
  const project = String(req.body?.project || "").trim();
  const enabled = req.body?.enabled !== false;
  if (!project) return res.status(400).json({ error: "missing_project" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE project=?", [project]);
  if (!g) return res.status(404).json({ error: "game_not_found" });

  const isOwner = g.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  if (!isOwner && !isPrivileged) return res.status(403).json({ error: "forbidden_owner" });

  await run("UPDATE games SET custom_levels_enabled=? WHERE id=?", [enabled ? 1 : 0, g.id]);
  res.json({ ok: true, custom_levels_enabled: enabled ? 1 : 0 });
});

// Publish/Unpublish (moderator/admin)
gameHostingRouter.post("/publish", requireAuth, requireRole("moderator"), async (req,res)=>{
  const project = String(req.body?.project || "").trim();
  const version = String(req.body?.version || "").trim();
  const published = req.body?.published !== false;
  if(!project || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id FROM games WHERE project=?", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const v = await get(
    `SELECT approval_status FROM game_versions WHERE game_id=? AND version=?`,
    [g.id, version]
  );
  if(!v) return res.status(404).json({ error:"version_not_found" });

  if(!published){
    await run("UPDATE game_versions SET is_published=0 WHERE game_id=? AND version=?", [g.id, version]);
    return res.json({ ok:true, published: false });
  }

  if(v.approval_status !== "approved") return res.status(400).json({ error:"version_not_approved" });

  await run("UPDATE game_versions SET is_published=1 WHERE game_id=? AND version=?", [g.id, version]);

  res.json({ ok:true });
});

// Publish (owner only, requires approved version)
gameHostingRouter.post("/publish-owner", requireAuth, async (req,res)=>{
  const project = String(req.body?.project || "").trim();
  const version = String(req.body?.version || "").trim();
  const published = req.body?.published !== false;
  if(!project) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE project=?", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const isOwner = g.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  if(!isOwner && !isPrivileged) return res.status(403).json({ error:"forbidden_owner" });

  if(!version) return res.status(400).json({ error:"missing_fields" });

  if(!published){
    await run("UPDATE game_versions SET is_published=0 WHERE game_id=? AND version=?", [g.id, version]);
    return res.json({ ok:true, published: false });
  }

  const v = await get(
    `SELECT approval_status FROM game_versions WHERE game_id=? AND version=?`,
    [g.id, version]
  );
  if(!v) return res.status(404).json({ error:"version_not_found" });
  if(v.approval_status !== "approved") return res.status(400).json({ error:"version_not_approved" });

  await run("UPDATE game_versions SET is_published=1 WHERE game_id=? AND version=?", [g.id, version]);

  res.json({ ok:true, published: true });
});

// Resubmit a rejected version (owner/mod/admin)
gameHostingRouter.post("/version/resubmit", requireAuth, async (req, res) => {
  const project = String(req.body?.project || "").trim();
  const version = String(req.body?.version || "").trim();
  if(!project || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE project=?", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const isOwner = g.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  if(!isOwner && !isPrivileged) return res.status(403).json({ error:"forbidden_owner" });

  const v = await get(
    `SELECT approval_status FROM game_versions WHERE game_id=? AND version=?`,
    [g.id, version]
  );
  if(!v) return res.status(404).json({ error:"version_not_found" });
  if(v.approval_status !== "rejected") return res.status(400).json({ error:"version_not_rejected" });

  await run(
    `UPDATE game_versions
     SET approval_status='pending', rejected_reason=NULL, approved_by=NULL, approved_at=NULL, is_published=0
     WHERE game_id=? AND version=?`,
    [g.id, version]
  );
  res.json({ ok:true });
});

// Delete a version (owner/mod/admin)
gameHostingRouter.post("/version/delete", requireAuth, async (req, res) => {
  const project = String(req.body?.project || "").trim();
  const version = String(req.body?.version || "").trim();
  if(!project || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE project=?", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const isOwner = g.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  if(!isOwner && !isPrivileged) return res.status(403).json({ error:"forbidden_owner" });

  const v = await get(
    `SELECT version FROM game_versions WHERE game_id=? AND version=?`,
    [g.id, version]
  );
  if(!v) return res.status(404).json({ error:"version_not_found" });

  const SERVER_DIR = path.resolve(process.cwd());
  const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
  const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "save", "uploads", "games");

  try{
    const target = safeVersionPath(GAME_STORAGE_DIR, project, version);
    fs.rmSync(target, { recursive: true, force: true });
  }catch{}

  await run("DELETE FROM game_versions WHERE game_id=? AND version=?", [g.id, version]);
  await run("DELETE FROM game_version_whitelist WHERE game_id=? AND version=?", [g.id, version]);
  await run("DELETE FROM game_uploads WHERE game_id=? AND version=?", [g.id, version]);

  res.json({ ok:true });
});

// Backup a version locally (owner/mod/admin)
gameHostingRouter.get("/version/backup", requireAuth, async (req, res) => {
  const project = String(req.query?.project || "").trim();
  const version = String(req.query?.version || "").trim();
  if(!project || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE project=?", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const isOwner = g.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  if(!isOwner && !isPrivileged) return res.status(403).json({ error:"forbidden_owner" });

  const v = await get(
    `SELECT version FROM game_versions WHERE game_id=? AND version=?`,
    [g.id, version]
  );
  if(!v) return res.status(404).json({ error:"version_not_found" });

  const SERVER_DIR = path.resolve(process.cwd());
  const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
  const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "save", "uploads", "games");

  try{
    const versionDir = safeVersionPath(GAME_STORAGE_DIR, project, version);
    const backupZipPath = path.join(versionDir, "backup.zip");
    await ensureVersionBackupZip(versionDir, backupZipPath);
    res.download(backupZipPath, `${project}-${version}.zip`);
  }catch{
    return res.status(404).json({ error:"backup_unavailable" });
  }
});

// Download the selected version entry HTML file (owner/mod/admin or whitelisted/public)
gameHostingRouter.get("/version/html", requireAuth, async (req, res) => {
  const project = String(req.query?.project || "").trim();
  const version = String(req.query?.version || "").trim();
  if(!project || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE project=?", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const v = await get(
    `SELECT entry_html, is_published FROM game_versions WHERE game_id=? AND version=?`,
    [g.id, version]
  );
  if(!v) return res.status(404).json({ error:"version_not_found" });

  const isOwner = g.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  if (!(v.is_published === 1 || isOwner || isPrivileged)) {
    const wl = await get(
      `SELECT 1 FROM game_version_whitelist
       WHERE game_id=? AND version=? AND user_id=?
       LIMIT 1`,
      [g.id, version, req.user.uid]
    );
    if (!wl) return res.status(403).json({ error:"not_whitelisted" });
  }

  const entryHtml = String(v.entry_html || "index.html").trim() || "index.html";
  const SERVER_DIR = path.resolve(process.cwd());
  const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
  const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "save", "uploads", "games");

  try{
    const filePath = safeVersionFilePath(GAME_STORAGE_DIR, project, version, entryHtml);
    const versionDir = path.dirname(filePath);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error:"entry_not_found" });
    }

    const lowerName = path.basename(filePath).toLowerCase();
    const looksPackaged = lowerName.endsWith(".html") && fs.existsSync(path.join(versionDir, "script.js")) && fs.existsSync(path.join(versionDir, "assets", "project.json"));
    if (looksPackaged) {
      const packedHtml = buildSingleFileGameHtml({
        htmlPath: filePath,
        versionDir,
        project,
        version
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${project}-${version}.html"`);
      return res.send(packedHtml);
    }

    const downloadName = `${project}-${version}${path.extname(filePath) || ".html"}`;
    res.download(filePath, downloadName);
  }catch{
    return res.status(404).json({ error:"entry_not_found" });
  }
});
