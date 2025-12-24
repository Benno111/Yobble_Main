import { api } from "../api.js";
import { requireAuth } from "../auth.js";
import { mountTopbar } from "../layout.js";

await mountTopbar("games");
let me = null;
try{
  me = await requireAuth();
}catch{
  me = null;
}

const slug = location.pathname.split("/").filter(Boolean).pop();
const heroMain = document.getElementById("hero-main");
const heroArt = document.getElementById("hero-art");
const heroActions = document.getElementById("hero-actions");
const statsEl = document.getElementById("stats");
const media = document.getElementById("media");
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
  heroMain.textContent = "Loading…";

  const gRes = await safeGet("/api/games/" + encodeURIComponent(slug), null);
  if(!gRes){
    heroMain.innerHTML = `
      <h1>Game deleted</h1>
      <p class="muted">This game is no longer available.</p>
    `;
    const unhideBtn = document.getElementById("unhideBtn");
    if (unhideBtn && ["admin","moderator"].includes(me?.role)) {
      unhideBtn.style.display = "inline-flex";
      unhideBtn.onclick = async () => {
        try{
          await api.post("/api/mod/games/unhide", { slug });
          location.reload();
        }catch{
          unhideBtn.textContent = "Failed to unhide";
        }
      };
    }
    return;
  }
  const g = gRes.game || gRes;

  const vRes = await safeGet("/api/gamehosting/playable-versions?slug=" + encodeURIComponent(slug), null);
  let versions = Array.isArray(vRes?.versions) ? vRes.versions : [];
  if (!versions.length) {
    const fallback = await safeGet("/api/games/" + encodeURIComponent(slug) + "/versions", []);
    const rawVersions = Array.isArray(fallback) ? fallback : (fallback.versions || []);
    versions = [...new Set(rawVersions.map(v => {
      if (typeof v === "string") return v;
      return v?.version || v?.name || "";
    }).filter(Boolean))];
  }
  const published = g.latest_version || versions[0] || "";

  if (me && !(me.username === g.owner_username || ["admin","moderator"].includes(me?.role))) {
    versions = versions.filter(Boolean);
  }

  const inLibRes = await safeGet("/api/library/has?slug=" + encodeURIComponent(slug), null);
  let inLib = !!inLibRes?.in_library;
  const libAvailable = inLibRes !== null;

  let st = null;
  const statsRes = await safeGet("/api/stats/" + encodeURIComponent(slug) + "/me", null);
  if(statsRes?.stats){
    st = statsRes.stats;
  }else{
    const statsAll = await safeGet("/api/stats/me", []);
    if(Array.isArray(statsAll)){
      st = statsAll.find(x => x.slug === g.slug) || null;
    }
  }

  heroMain.innerHTML = `
    <span class="badge accent">${escapeHtml(g.category || "Uncategorized")}</span>
    <h1>${escapeHtml(g.title || "Untitled")}</h1>
    <p>${escapeHtml(g.description || "No description yet.")}</p>
    <div class="hero-meta">
      <span class="badge">By ${escapeHtml(g.owner_display_name || g.owner_username || "Unknown")}</span>
      <span class="badge">Rating ${escapeHtml(g.avg_rating ?? "—")}</span>
      <span class="badge">${escapeHtml(g.rating_count ?? 0)} reviews</span>
      <span class="badge">Slug ${escapeHtml(g.slug)}</span>
      <a class="badge" href="/report.html?target_type=game&target_ref=${encodeURIComponent(g.slug)}">Report</a>
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
    ${(me && g.owner_username && me.username === g.owner_username)
      ? `<a class="secondary" id="dashBtn" href="/game-dashboard.html?slug=${encodeURIComponent(g.slug)}">Open dashboard</a>`
      : ""}
    ${libAvailable ? `<button class="secondary" id="libBtn">${inLib ? "In Library" : "Add to Library"}</button>` : ""}
    ${["admin","moderator"].includes(me?.role) ? `<button class="secondary" id="featureBtn">${g.is_featured ? "Unfeature" : "Feature"}</button>` : ""}
    <div class="muted" id="playNotice"></div>
  `;

  const sel = document.getElementById("versionSelect");
  if(versions.length){
    for(const v of versions){
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    }
    if(published && versions.includes(published)) sel.value = published;
  }else if(published){
    const opt = document.createElement("option");
    opt.value = published;
    opt.textContent = published;
    sel.appendChild(opt);
    sel.value = published;
  }else{
    sel.innerHTML = `<option value="">No versions available</option>`;
    document.getElementById("playBtn").disabled = true;
  }

  const playBtn = document.getElementById("playBtn");
  const playNotice = document.getElementById("playNotice");

  async function updatePlayAccess(){
    const version = sel.value;
    if(!version) return;
    try{
      await api.get(`/api/gamehosting/can-play?slug=${encodeURIComponent(slug)}&version=${encodeURIComponent(version)}`);
      playBtn.disabled = false;
      if(playNotice) playNotice.textContent = "";
    }catch{
      playBtn.disabled = true;
      if(playNotice) playNotice.textContent = "Unpublished: whitelist required.";
    }
  }

  playBtn.onclick = async ()=>{
    const version = sel.value;
    if(!version) return;
    const entry = g.entry_html || "index.html";
    let token = "";
    try{
      const t = await api.post("/api/launcher/token", { game_slug: slug });
      token = t.token || "";
    }catch{}
    const url =
      `/play.html?slug=${encodeURIComponent(slug)}` +
      `&version=${encodeURIComponent(version)}` +
      `&entry=${encodeURIComponent(entry)}` +
      (token ? `&launch_token=${encodeURIComponent(token)}` : "");
    if(window.electron?.openGame) window.electron.openGame(url);
    else location.href = url;
  };

  sel.addEventListener("change", updatePlayAccess);
  await updatePlayAccess();

  if(libAvailable){
    document.getElementById("libBtn").onclick = async ()=>{
      if(inLib){
        await api.post("/api/library/remove", { slug });
        inLib = false;
        document.getElementById("libBtn").textContent = "Add to Library";
      }else{
        await api.post("/api/library/add", { slug });
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
        await api.post("/api/mod/games/feature", { slug, featured: next });
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
        await api.post("/api/reviews/" + encodeURIComponent(slug) + "/review", {
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
  const r = await safeGet("/api/reviews/" + encodeURIComponent(slug) + "/reviews", null);
  reviewsEl.innerHTML = "";
  if(!r){
    reviewsEl.innerHTML = `<div class="review-card muted">Reviews are unavailable.</div>`;
    return;
  }
  for(const row of (r.reviews || [])){
    const d = document.createElement("div");
    d.className = "review-card";
    const userLink = `/profile.html?u=${encodeURIComponent(row.username)}`;
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
