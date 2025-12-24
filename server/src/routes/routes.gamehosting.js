import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import unzipper from "unzipper";
import { requireAuth, requireRole } from "../auth.js";
import { get, run, all } from "../db.js";

export const gameHostingRouter = express.Router();

const TMP_DIR = path.join(process.cwd(), "uploads", "game_zips");
fs.mkdirSync(TMP_DIR, { recursive:true });

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }
});

function slugify(s){
  return String(s||"")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"")
    .slice(0,80);
}

function safeVersionPath(baseDir, slug, version){
  const full = path.join(baseDir, slug, version);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(baseDir))) {
    throw new Error("unsafe_path");
  }
  return resolved;
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
  const slugInput = String(req.body?.slug || "").trim();
  const slug = slugify(slugInput || title);
  const version = String(req.body?.version || "").trim();
  const entry_html = String(req.body?.entry_html || "index.html").trim();

  const category = String(req.body?.category || "").trim().slice(0,50) || null;
  const description = String(req.body?.description || "").trim().slice(0,2000) || null;

  if(!slug) return res.status(400).json({ error:"invalid_slug" });
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
  let game = await get("SELECT id, slug, owner_user_id FROM games WHERE slug=?", [slug]);
  if(!game){
    const gTitle = title || slug;
    await run(
      `INSERT INTO games(slug,title,description,category,is_hidden,owner_user_id) VALUES(?,?,?,?,0,?)`,
      [slug, gTitle, description, category, req.user.uid]
    );
    game = await get("SELECT id, slug, owner_user_id FROM games WHERE slug=?", [slug]);
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

  const SERVER_DIR = path.resolve(process.cwd()); // run from /server
  const PROJECT_ROOT = path.resolve(SERVER_DIR, "..");
  const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "game_storage");
  const destDir = path.join(GAME_STORAGE_DIR, slug, version);

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

  // Insert version if not exists
  await run(
    `INSERT OR IGNORE INTO game_versions(game_id,version,entry_html,created_at,is_published,approval_status,approved_by,approved_at)
     VALUES(?,?,?,?,0,?,?,?)`,
    [game.id, version, entry_html, now, approval_status, isPrivileged ? req.user.uid : null, isPrivileged ? now : null]
  );

  // If privileged, publish it immediately
  if(isPrivileged){
    await run("UPDATE game_versions SET is_published=0 WHERE game_id=?", [game.id]);
    await run("UPDATE game_versions SET is_published=1 WHERE game_id=? AND version=?", [game.id, version]);
  }

  // Upload history
  await run(
    `INSERT INTO game_uploads(uploader_user_id,game_id,version,storage_path,created_at)
     VALUES(?,?,?,?,?)`,
    [req.user.uid, game.id, version, path.relative(PROJECT_ROOT, destDir), now]
  );

  res.json({
    ok:true,
    slug,
    version,
    approval_status,
    published: isPrivileged ? 1 : 0,
    url: `/games/${slug}/${version}/${entry_html}`
  });
});

// List versions + upload history for a game
gameHostingRouter.get("/versions", requireAuth, async (req,res)=>{
  const slug = String(req.query?.slug || "").trim();
  if(!slug) return res.status(400).json({ error:"missing_slug" });

  const g = await get("SELECT id, slug, title, description, category, owner_user_id FROM games WHERE slug=?", [slug]);
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

  res.json({ game: g, versions: filteredVersions, uploads });
});

// Whitelist management (owner/mod/admin)
gameHostingRouter.get("/whitelist", requireAuth, async (req, res) => {
  const slug = String(req.query?.slug || "").trim();
  const version = String(req.query?.version || "").trim();
  if(!slug || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE slug=?", [slug]);
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
  const slug = String(req.body?.slug || "").trim();
  const version = String(req.body?.version || "").trim();
  const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
  if(!slug || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE slug=?", [slug]);
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
  const slug = String(req.query?.slug || "").trim();
  if(!slug) return res.status(400).json({ error:"missing_slug" });

  const g = await get("SELECT id, slug, owner_user_id FROM games WHERE slug=?", [slug]);
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
  const slug = String(req.query?.slug || "").trim();
  const version = String(req.query?.version || "").trim();
  if(!slug || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE slug=? AND is_hidden=0", [slug]);
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
  const slug = String(req.query?.slug || "").trim();
  if(!slug) return res.status(400).json({ error:"missing_slug" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE slug=? AND is_hidden=0", [slug]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const isOwner = g.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  if (isOwner || isPrivileged) {
    const rows = await all(
      `SELECT version FROM game_versions WHERE game_id=? ORDER BY created_at DESC`,
      [g.id]
    );
    return res.json({ versions: rows.map(r => r.version) });
  }

  const rows = await all(
    `SELECT version FROM game_versions
     WHERE game_id=? AND is_published=1
     ORDER BY created_at DESC`,
    [g.id]
  );
  const published = new Set(rows.map(r => r.version));
  const wlRows = await all(
    `SELECT version FROM game_version_whitelist WHERE game_id=? AND user_id=?`,
    [g.id, req.user.uid]
  );
  for (const r of wlRows) published.add(r.version);
  res.json({ versions: Array.from(published) });
});

// Publish/Rollback (moderator/admin)
gameHostingRouter.post("/publish", requireAuth, requireRole("moderator"), async (req,res)=>{
  const slug = String(req.body?.slug || "").trim();
  const version = String(req.body?.version || "").trim();
  if(!slug || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id FROM games WHERE slug=?", [slug]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const v = await get(
    `SELECT approval_status FROM game_versions WHERE game_id=? AND version=?`,
    [g.id, version]
  );
  if(!v) return res.status(404).json({ error:"version_not_found" });
  if(v.approval_status !== "approved") return res.status(400).json({ error:"version_not_approved" });

  await run("UPDATE game_versions SET is_published=0 WHERE game_id=?", [g.id]);
  await run("UPDATE game_versions SET is_published=1 WHERE game_id=? AND version=?", [g.id, version]);

  res.json({ ok:true });
});

// Publish (owner only, requires approved version)
gameHostingRouter.post("/publish-owner", requireAuth, async (req,res)=>{
  const slug = String(req.body?.slug || "").trim();
  const version = String(req.body?.version || "").trim();
  const published = req.body?.published !== false;
  if(!slug) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE slug=?", [slug]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const isOwner = g.owner_user_id === req.user.uid;
  const isPrivileged = req.user.role === "admin" || req.user.role === "moderator";
  if(!isOwner && !isPrivileged) return res.status(403).json({ error:"forbidden_owner" });

  if(!published){
    await run("UPDATE game_versions SET is_published=0 WHERE game_id=?", [g.id]);
    return res.json({ ok:true, published: false });
  }

  if(!version) return res.status(400).json({ error:"missing_fields" });

  const v = await get(
    `SELECT approval_status FROM game_versions WHERE game_id=? AND version=?`,
    [g.id, version]
  );
  if(!v) return res.status(404).json({ error:"version_not_found" });
  if(v.approval_status !== "approved") return res.status(400).json({ error:"version_not_approved" });

  await run("UPDATE game_versions SET is_published=0 WHERE game_id=?", [g.id]);
  await run("UPDATE game_versions SET is_published=1 WHERE game_id=? AND version=?", [g.id, version]);

  res.json({ ok:true, published: true });
});

// Resubmit a rejected version (owner/mod/admin)
gameHostingRouter.post("/version/resubmit", requireAuth, async (req, res) => {
  const slug = String(req.body?.slug || "").trim();
  const version = String(req.body?.version || "").trim();
  if(!slug || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE slug=?", [slug]);
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
  const slug = String(req.body?.slug || "").trim();
  const version = String(req.body?.version || "").trim();
  if(!slug || !version) return res.status(400).json({ error:"missing_fields" });

  const g = await get("SELECT id, owner_user_id FROM games WHERE slug=?", [slug]);
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
  const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "game_storage");

  try{
    const target = safeVersionPath(GAME_STORAGE_DIR, slug, version);
    fs.rmSync(target, { recursive: true, force: true });
  }catch{}

  await run("DELETE FROM game_versions WHERE game_id=? AND version=?", [g.id, version]);
  await run("DELETE FROM game_version_whitelist WHERE game_id=? AND version=?", [g.id, version]);
  await run("DELETE FROM game_uploads WHERE game_id=? AND version=?", [g.id, version]);

  res.json({ ok:true });
});
