import { api } from "../api-pages/game.js";
import { requireAuth } from "../auth.js";
import { mountTopbar } from "../layout.js";
await mountTopbar("games");
let me = null;
try{
  me = await requireAuth();
}catch{
  me = null;
}
const project = location.pathname.split("/").filter(Boolean).pop();
const heroMain = document.getElementById("hero-main");
const heroArt = document.getElementById("hero-art");
const heroActions = document.getElementById("hero-actions");
const statsEl = document.getElementById("stats");
const media = document.getElementById("media");
const levelsEl = document.getElementById("levels");
const reviewBox = document.getElementById("reviewBox");
const reviewsEl = document.getElementById("reviews");
function escapeHtml(v){
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}
function starRow(value){
  let s = "";
  for(let i=1;i<=5;i++){
    s += `<button data-star="${i}" class="secondary" style="width:auto">${i<=value?"★":"☆"}</button>`;
  }
  return s;
}
function fmtMs(ms){
  const s = Math.floor(ms/1000);
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  return `${h}h ${m}m`;
}
async function safeGet(url, fallback){
  try{
    return await api.get(url);
  }catch{
    return fallback;
  }
}
async function load(){
  if (heroMain?.dataset?.prefilled !== "1") {
    heroMain.textContent = "Loading…";
  }
  const gRes = await safeGet("/api/games/" + encodeURIComponent(project), null);
  if(!gRes){
    const offline = navigator.onLine === false;
    heroMain.innerHTML = `
      <h1>${offline ? "You're offline" : "Game deleted"}</h1>
      <p class="muted">${offline ? "The server could not be reached. If you have already launched this game in the desktop or mobile app, it can still open from the local offline cache." : "This game is no longer available."}</p>
    `;
    const unhideBtn = document.getElementById("unhideBtn");
    if (unhideBtn && ["admin","moderator"].includes(me?.role)) {
      unhideBtn.style.display = "inline-flex";
      unhideBtn.onclick = async () => {
        try{
          await api.post("/api/mod/games/unhide", { project });
          location.reload();
        }catch{
          unhideBtn.textContent = "Failed to unhide";
        }
      };
    }
    return;
  }
  const g = gRes.game || gRes;
  function normalizeVersions(raw) {
    return raw.map(v => {
      if (typeof v === "string") return { version: v, entry_html: null };
      return { version: v.version || v.name || "", entry_html: v.entry_html || null };
    }).filter(v => v.version);
  }
  const vRes = await safeGet("/api/gamehosting/playable-versions?project=" + encodeURIComponent(project), null);
  let versions = normalizeVersions(Array.isArray(vRes?.versions) ? vRes.versions : []);
  if (!versions.length) {
    const fallback = await safeGet("/api/games/" + encodeURIComponent(project) + "/versions", []);
    const rawVersions = Array.isArray(fallback) ? fallback : (fallback.versions || []);
    const seen = new Set();
    versions = normalizeVersions(rawVersions).filter(v => {
      if (seen.has(v.version)) return false;
      seen.add(v.version);
      return true;
    });
  }
  const entryHtmlMap = new Map(versions.map(v => [v.version, v.entry_html]));
  const published = g.latest_version || versions[0]?.version || "";
  if (me && !(me.username === g.owner_username || ["admin","moderator"].includes(me?.role))) {
    versions = versions.filter(v => v.version);
  }
  const inLibRes = await safeGet("/api/library/has?project=" + encodeURIComponent(project), null);
  let inLib = !!inLibRes?.in_library;
  const libAvailable = inLibRes !== null;
  let st = null;
  const statsRes = await safeGet("/api/stats/" + encodeURIComponent(project) + "/me", null);
  if(statsRes?.stats){
    st = statsRes.stats;
  }else{
    const statsAll = await safeGet("/api/stats/me", []);
    if(Array.isArray(statsAll)){
      st = statsAll.find(x => x.project === g.project) || null;
    }
  }
  heroMain.innerHTML = `
    <span class="badge accent">${escapeHtml(g.category || "Uncategorized")}</span>
    <h1>${escapeHtml(g.title || "Untitled")}</h1>
    <p>${escapeHtml(g.description || "No description yet.")}</p>
    <div class="hero-meta">
      <span class="badge">By ${escapeHtml(g.owner_display_name || g.owner_username || "Unknown")}</span>
      <a class="secondary" href="/report?target_type=game&target_ref=${encodeURIComponent(g.project)}">Report</a>
    </div>
  `;
  heroArt.textContent = g.banner_path ? "" : "Launch ready";
  if(g.banner_path){
    heroArt.style.background = `linear-gradient(130deg,rgba(255,209,102,.2),rgba(20,26,36,.5)), url('${g.banner_path}') center/cover`;
  }
  heroActions.innerHTML = `
    <div>
      <label for="versionSelect">Version</label>
      <select id="versionSelect"></select>
    </div>
    <button class="primary" id="playBtn">Play</button>
    <button class="secondary" id="downloadBtn" type="button">Download HTML</button>
    ${(me && g.owner_username && me.username === g.owner_username)
      ? `<a class="secondary" id="dashBtn" href="/game-dashboard?project=${encodeURIComponent(g.project)}">Open dashboard</a>`
      : ""}
    ${libAvailable ? `<button class="secondary" id="libBtn">${inLib ? "In Library" : "Add to Library"}</button>` : ""}
    ${["admin","moderator"].includes(me?.role) ? `<button class="secondary" id="featureBtn">${g.is_featured ? "Unfeature" : "Feature"}</button>` : ""}
    <div class="muted" id="playNotice"></div>
  `;
  const sel = document.getElementById("versionSelect");
  const playBtn = document.getElementById("playBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  if(versions.length){
    for(const v of versions){
      const opt = document.createElement("option");
      opt.value = v.version;
      opt.textContent = v.version;
      sel.appendChild(opt);
    }
    if(published && versions.some(v => v.version === published)) sel.value = published;
  }else if(published){
    const opt = document.createElement("option");
    opt.value = published;
    opt.textContent = published;
    sel.appendChild(opt);
    sel.value = published;
  }else{
    sel.innerHTML = `<option value="">No versions available</option>`;
    playBtn.disabled = true;
    if (downloadBtn) downloadBtn.disabled = true;
  }
  const playNotice = document.getElementById("playNotice");
  async function downloadSelectedVersion(){
    const version = sel.value;
    if(!version) return;
    const entry = entryHtmlMap.get(version) ?? g.entry_html ?? "index.html";
    const url = `/api/gamehosting/version/html?project=${encodeURIComponent(project)}&version=${encodeURIComponent(version)}`;
    const token = localStorage.getItem("token");
    if (!downloadBtn) return;
    downloadBtn.disabled = true;
    const prevText = downloadBtn.textContent;
    downloadBtn.textContent = "Saving...";
    try{
      const response = await fetch(url, {
        headers: token ? { Authorization: "Bearer " + token } : {}
      });
      if (!response.ok) {
        throw new Error(await response.text());
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") || "";
      const match = disposition.match(/filename="?([^"]+)"?/i);
      const filename = match?.[1] || `${project}-${version}-${String(entry).replace(/\\/g, "/").split("/").pop() || "game"}`;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      downloadBtn.textContent = "Saved";
      setTimeout(() => {
        if (downloadBtn) {
          downloadBtn.textContent = prevText;
          downloadBtn.disabled = false;
        }
      }, 1000);
    }catch{
      if (downloadBtn) {
        downloadBtn.textContent = "Failed";
        downloadBtn.disabled = false;
        setTimeout(() => {
          if (downloadBtn) downloadBtn.textContent = prevText;
        }, 1000);
      }
    }
  }
  async function updatePlayAccess(){
    const version = sel.value;
    if(!version) return;
    try{
      await api.get(`/api/gamehosting/can-play?project=${encodeURIComponent(project)}&version=${encodeURIComponent(version)}`);
      playBtn.disabled = false;
      if (downloadBtn) downloadBtn.disabled = false;
      if(playNotice) playNotice.textContent = "";
    }catch{
      playBtn.disabled = true;
      if (downloadBtn) downloadBtn.disabled = true;
      if(playNotice) playNotice.textContent = "Unpublished: whitelist required.";
    }
  }
  playBtn.onclick = async ()=>{
    const version = sel.value;
    if(!version) return;
    const entry = entryHtmlMap.get(version) ?? g.entry_html ?? "index";
    let token = "";
    try{
      const t = await api.post("/api/launcher/token", { game_project: project });
      token = t.token || "";
    }catch{}
    const url =
      `/play?project=${encodeURIComponent(project)}` +
      `&version=${encodeURIComponent(version)}` +
      `&entry=${encodeURIComponent(entry)}` +
      (token ? `&launch_token=${encodeURIComponent(token)}` : "");
    if(window.electron?.openGame) window.electron.openGame(url);
    else location.href = url;
  };
  if (downloadBtn) {
    downloadBtn.onclick = downloadSelectedVersion;
  }
  sel.addEventListener("change", updatePlayAccess);
  await updatePlayAccess();
  if(libAvailable){
    document.getElementById("libBtn").onclick = async ()=>{
      if(inLib){
        await api.post("/api/library/remove", { project });
        inLib = false;
        document.getElementById("libBtn").textContent = "Add to Library";
      }else{
        await api.post("/api/library/add", { project });
        inLib = true;
        document.getElementById("libBtn").textContent = "In Library";
      }
    };
  }
  const featureBtn = document.getElementById("featureBtn");
  if(featureBtn){
    featureBtn.onclick = async ()=>{
      try{
        const next = g.is_featured ? 0 : 1;
        await api.post("/api/mod/games/feature", { project, featured: next });
        g.is_featured = next;
        featureBtn.textContent = g.is_featured ? "Unfeature" : "Feature";
      }catch{
        featureBtn.textContent = "Failed";
      }
    };
  }
  if(st){
    statsEl.innerHTML = `
      <div class="stats">
        <div class="stat">
          <div class="label">Your playtime</div>
          <div class="value">${escapeHtml(fmtMs(st.playtime_ms || 0))}</div>
        </div>
        <div class="stat">
          <div class="label">Sessions</div>
          <div class="value">${escapeHtml(st.sessions || 0)}</div>
        </div>
        <div class="stat">
          <div class="label">Last played</div>
          <div class="value">${escapeHtml(st.last_played ? new Date(st.last_played).toLocaleString() : "—")}</div>
        </div>
      </div>
    `;
  }else{
    statsEl.hidden = true;
  }
  const shots = Array.isArray(g.screenshots) ? g.screenshots : [];
  if(g.banner_path || shots.length){
    media.innerHTML = `
      <h2>Media</h2>
      <div class="gallery" id="gallery"></div>
    `;
    const gallery = document.getElementById("gallery");
    if(g.banner_path){
      const img = document.createElement("img");
      img.src = g.banner_path;
      img.alt = "Banner";
      gallery.appendChild(img);
    }
    for(const s of shots){
      const img = document.createElement("img");
      img.src = s;
      img.alt = "Screenshot";
      gallery.appendChild(img);
    }
  }else{
    media.innerHTML = `<div class="muted">No media uploaded yet.</div>`;
  }
  if (levelsEl) {
    if (g.custom_levels_enabled === 0) {
      levelsEl.hidden = true;
    } else {
    try{
      const levelsRes = await api.get("/api/games/custom-lvl/" + encodeURIComponent(project) + "/list");
      const levels = Array.isArray(levelsRes?.levels) ? levelsRes.levels : [];
      const rows = levels.slice(0, 6).map((lvl) => `
        <div class="list-item">
          <div>
            <div>${escapeHtml(lvl.title || "Untitled level")}</div>
            <div class="meta">v${escapeHtml(lvl.version || "—")} · ${escapeHtml(lvl.uploader_username || "unknown")}</div>
          </div>
        </div>
      `).join("");
      levelsEl.innerHTML = `
        <div class="section-title">
          <h2>Custom Levels</h2>
          <a class="secondary" href="/levels?project=${encodeURIComponent(project)}">Browse</a>
        </div>
        <div class="list" style="margin-top:12px">
          ${rows || `<div class="muted">No custom levels yet.</div>`}
        </div>
      `;
    }catch{
      levelsEl.innerHTML = `
        <div class="section-title">
          <h2>Custom Levels</h2>
        </div>
        <div class="muted" style="margin-top:12px">Custom levels unavailable.</div>
      `;
    }
    }
  }
  if(me){
    reviewBox.innerHTML = `
      <div class="muted">Leave a rating & comment</div>
      <div id="stars" style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">${starRow(0)}</div>
      <textarea id="comment" rows="3" placeholder="Write your review (optional)"></textarea>
      <button class="primary" id="submitReview" style="margin-top:10px;width:auto">Submit</button>
      <div id="revStatus" class="muted" style="margin-top:8px"></div>
    `;
  }else{
    reviewBox.innerHTML = `<div class="muted">Reviews are unavailable for this account.</div>`;
  }
  if(me){
    let chosen = 0;
    const stars = document.getElementById("stars");
    function repaint(){
      stars.innerHTML = starRow(chosen);
      stars.querySelectorAll("button").forEach(b=>{
        b.onclick = ()=>{ chosen = Number(b.dataset.star); repaint(); };
      });
    }
    repaint();
    document.getElementById("submitReview").onclick = async ()=>{
      if(!chosen){ document.getElementById("revStatus").textContent="Pick 1-5 stars first."; return; }
      try{
        await api.post("/api/reviews/" + encodeURIComponent(project) + "/review", {
          rating: chosen,
          comment: document.getElementById("comment").value
        });
        document.getElementById("revStatus").textContent = "Saved ✔";
        await loadReviews();
      }catch{
        document.getElementById("revStatus").textContent = "Reviews are unavailable.";
      }
    };
  }
  await loadReviews();
}
async function loadReviews(){
  const r = await safeGet("/api/reviews/" + encodeURIComponent(project) + "/reviews", null);
  reviewsEl.innerHTML = "";
  if(!r){
    reviewsEl.innerHTML = `<div class="review-card muted">Reviews are unavailable.</div>`;
    return;
  }
  for(const row of (r.reviews || [])){
    const d = document.createElement("div");
    d.className = "review-card";
    const userLink = `/profile?u=${encodeURIComponent(row.username)}`;
    d.innerHTML = `
      <h3><a href="${userLink}">${escapeHtml(row.username)}</a> — ${"★".repeat(row.rating)}${"☆".repeat(5-row.rating)}</h3>
      <div class="muted">${escapeHtml(new Date(row.updated_at || row.created_at).toLocaleString())}</div>
      <p>${row.comment ? escapeHtml(row.comment) : "<span class='muted'>No comment</span>"}</p>
    `;
    reviewsEl.appendChild(d);
  }
  if(!(r.reviews||[]).length){
    const d = document.createElement("div");
    d.className="review-card";
    d.textContent="No reviews yet.";
    reviewsEl.appendChild(d);
  }
}
load();
