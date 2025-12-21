import { api } from "../api.js";
import { requireAuth } from "../auth.js";

await requireAuth();

const q = new URLSearchParams(location.search);
const slug = q.get("slug") || "";
const version = q.get("version") || "";
const entry = q.get("entry") || "index.html";
const token = q.get("launch_token") || "";

const frame = document.getElementById("frame");
const info = document.getElementById("info");
const titleEl = document.getElementById("title");
const refreshBtn = document.getElementById("refreshBtn");
const backBtn = document.getElementById("backBtn");

if(!slug || !version){
  info.textContent = "Missing slug/version";
  throw new Error("missing params");
}

// Start session
let session_id = null;
let started_at = null;
try{
  const s = await api.post("/api/stats/" + encodeURIComponent(slug) + "/session/start", {});
  session_id = s.session_id;
  started_at = s.started_at;
}catch(e){
  // ignore
}

titleEl.textContent = slug;
info.textContent = `Version ${version}`;

// Load game iframe (keep token for in-game verification if needed)
const gameUrl = `/games/${slug}/${version}/${entry}${token ? `?launch_token=${encodeURIComponent(token)}` : ""}`;
frame.src = gameUrl;

refreshBtn.onclick = () => {
  frame.src = gameUrl;
};

backBtn.onclick = () => {
  location.href = `/games/${slug}`;
};

async function end(){
  if(!session_id) return;
  try{
    await api.post("/api/stats/" + encodeURIComponent(slug) + "/session/end", { session_id, started_at });
    session_id = null;
  }catch(e){}
}

window.addEventListener("beforeunload", end);
