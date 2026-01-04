import { api } from "../api-pages/play.js";
import { requireAuth } from "../auth.js";
await requireAuth();
const q = new URLSearchParams(location.search);
const slug = q.get("slug") || "";
const version = q.get("version") || "";
const entry = q.get("entry") || "index.html";
const token = q.get("launch_token") || "";
const authToken = localStorage.getItem("token");
const returnTo = q.get("return") || "";
const frame = document.getElementById("frame");
const info = document.getElementById("info");
const titleEl = document.getElementById("title");
const refreshBtn = document.getElementById("refreshBtn");
const fullscreenFrame = document.getElementById("fullscreenFrame");
const backBtn = document.getElementById("backBtn");
const playWrap = document.querySelector(".play-wrap");
const playShell = document.querySelector(".play-shell");
const collapseBtn = document.getElementById("collapseBtn");
const expandBtn = document.getElementById("expandBtn");
if(!slug || !version){
  info.textContent = "Missing slug/version";
  throw new Error("missing params");
}
let photonConfig = null;
try{
  photonConfig = await api.get("/api/photon/config");
}catch(e){
  photonConfig = null;
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
if (authToken) {
  document.cookie = `auth_token=${encodeURIComponent(authToken)}; path=/games; max-age=300; SameSite=Lax`;
}
// Load game iframe (keep token for in-game verification if needed)
const params = new URLSearchParams();
if (token) params.set("launch_token", token);
const qs = params.toString();
const gameUrl = `/games/${slug}/${version}/${entry}${qs ? `?${qs}` : ""}`;
frame.src = gameUrl;
refreshBtn.onclick = () => {
  frame.src = gameUrl;
};
const canFullscreen = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
const isFullscreen = () =>
  !!(document.fullscreenElement || document.webkitFullscreenElement);
const isBrowserFullscreen = () =>
  Math.abs(window.innerHeight - screen.height) < 2 &&
  Math.abs(window.innerWidth - screen.width) < 2;
const postFullscreenState = () => {
  if(!fullscreenFrame?.contentWindow) return;
  fullscreenFrame.contentWindow.postMessage({
    type: "fullscreen:state",
    payload: { isFullscreen: isFullscreen() },
  }, "*");
};
if(fullscreenFrame){
  fullscreenFrame.src = "/partials/fullscreen-button.html";
  fullscreenFrame.addEventListener("load", () => {
    fullscreenFrame.contentWindow?.postMessage({
      type: "fullscreen:enabled",
      payload: { enabled: canFullscreen },
    }, "*");
    postFullscreenState();
  });
  window.addEventListener("message", async (event) => {
    if(event.source !== fullscreenFrame.contentWindow) return;
    const { type } = event.data || {};
    if(type !== "fullscreen:toggle") return;
    if(!canFullscreen) return;
    if(isFullscreen()){
      if(document.exitFullscreen){
        await document.exitFullscreen();
      }else if(document.webkitExitFullscreen){
        await document.webkitExitFullscreen();
      }
      return;
    }
    if(playWrap.requestFullscreen){
      await playWrap.requestFullscreen();
    }else if(playWrap.webkitRequestFullscreen){
      await playWrap.webkitRequestFullscreen();
    }
  });
  document.addEventListener("fullscreenchange", postFullscreenState);
  document.addEventListener("webkitfullscreenchange", postFullscreenState);
}
window.addEventListener("resize", async () => {
  if(isFullscreen() && !isBrowserFullscreen()){
    if(document.exitFullscreen){
      await document.exitFullscreen();
    }else if(document.webkitExitFullscreen){
      await document.webkitExitFullscreen();
    }
  }
});
window.addEventListener("keydown", async (event) => {
  if(!canFullscreen) return;
  const target = event.target;
  const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
  if(tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable){
    return;
  }
  if(event.key.toLowerCase() !== "f") return;
  event.preventDefault();
  if(isFullscreen()){
    if(document.exitFullscreen){
      await document.exitFullscreen();
    }else if(document.webkitExitFullscreen){
      await document.webkitExitFullscreen();
    }
    return;
  }
  if(playWrap.requestFullscreen){
    await playWrap.requestFullscreen();
  }else if(playWrap.webkitRequestFullscreen){
    await playWrap.webkitRequestFullscreen();
  }
});
backBtn.onclick = () => {
  if(returnTo){
    location.href = returnTo;
    return;
  }
  location.href = `/games/${slug}`;
};
function setCollapsed(nextCollapsed){
  if(!playShell) return;
  playShell.classList.toggle("is-collapsed", nextCollapsed);
}
if(collapseBtn){
  collapseBtn.addEventListener("click", () => setCollapsed(true));
}
if(expandBtn){
  expandBtn.addEventListener("click", () => setCollapsed(false));
}
if(returnTo){
  backBtn.textContent = "Back to queue";
}
async function end(){
  if(!session_id) return;
  try{
    await api.post("/api/stats/" + encodeURIComponent(slug) + "/session/end", { session_id, started_at });
    session_id = null;
  }catch(e){}
}
window.addEventListener("beforeunload", end);
function buildStorageSyncScript(storageSlug, storageVersion){
  return `
    (function(){
      if (window.__yobbleStorageSync) return;
      window.__yobbleStorageSync = true;
      const slug = ${JSON.stringify(storageSlug)};
      const version = ${JSON.stringify(storageVersion)};
      const base = \`/api/storage/\${encodeURIComponent(slug)}/\${encodeURIComponent(version)}\`;
      const token = localStorage.getItem("token");
      const authHeader = token ? { Authorization: \`Bearer \${token}\` } : {};
      const ls = window.localStorage;
      const origSet = ls.setItem.bind(ls);
      const origRemove = ls.removeItem.bind(ls);
      const origClear = ls.clear.bind(ls);
      const origGet = ls.getItem.bind(ls);
      const pending = new Map();
      let flushTimer = null;
      function queueSet(key, value){
        pending.set(key, value);
        if (flushTimer) return;
        flushTimer = setTimeout(async () => {
          const items = Array.from(pending.entries());
          pending.clear();
          flushTimer = null;
          for (const [k, v] of items){
            try{
              await fetch(base, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeader },
                body: JSON.stringify({ key: k, value: v }),
                credentials: "include"
              });
            }catch(e){}
          }
        }, 150);
      }
      async function loadRemote(){
        try{
          const res = await fetch(base, { headers: authHeader, credentials: "include" });
          if (!res.ok) return;
          const data = await res.json();
          if (!data || !data.data) return;
          for (const [k, v] of Object.entries(data.data)){
            origSet(k, v == null ? "" : String(v));
          }
        }catch(e){}
      }
      ls.setItem = function(key, value){
        origSet(String(key), String(value));
        queueSet(String(key), String(value));
      };
      ls.removeItem = function(key){
        origRemove(String(key));
        fetch(\`\${base}/\${encodeURIComponent(String(key))}\`, {
          method: "DELETE",
          headers: authHeader,
          credentials: "include"
        }).catch(() => {});
      };
      ls.clear = function(){
        origClear();
        fetch(base, { method: "DELETE", headers: authHeader, credentials: "include" }).catch(() => {});
      };
      ls.getItem = function(key){
        return origGet(String(key));
      };
      loadRemote();
    })();
  `;
}
function buildPhotonBootstrapScript(config){
  return `
    (function(){
      if (window.__photonBootstrap) return;
      window.__photonBootstrap = true;
      window.__PHOTON_CONFIG = ${JSON.stringify(config || {})};
      var s = document.createElement("script");
      s.src = "/js/sdk/photon.js";
      s.async = true;
      s.onload = function(){
        window.dispatchEvent(new CustomEvent("photon:bootstrap"));
      };
      s.onerror = function(){
        window.__PHOTON_SDK_ERROR = "photon_bootstrap_failed";
        window.dispatchEvent(new CustomEvent("photon:sdk-error"));
      };
      document.head.appendChild(s);
    })();
  `;
}
frame.addEventListener("load", () => {
  try{
    const doc = frame.contentDocument;
    if (!doc) return;
    const script = doc.createElement("script");
    script.textContent = buildStorageSyncScript(slug, version);
    doc.documentElement.appendChild(script);
    if (photonConfig?.enabled) {
      const photonScript = doc.createElement("script");
      photonScript.textContent = buildPhotonBootstrapScript(photonConfig);
      doc.documentElement.appendChild(photonScript);
    }
  }catch(e){}
});
