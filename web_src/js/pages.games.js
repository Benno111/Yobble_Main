import { requireLoginOrRedirect } from "./auth.js";
import { api } from "/js/api-pages/games.js";
import { mountTopbar, htmlEscape } from "./ui.js";
requireLoginOrRedirect();
await mountTopbar("games");
const q = document.querySelector("#q");
const list = document.querySelector("#list");
const msg = document.querySelector("#msg");
async function load(){
  msg.textContent = "";
  list.innerHTML = "";
  const qs = q.value.trim();
  const r = await api(`/api/games${qs ? `?q=${encodeURIComponent(qs)}` : ""}`);
  if(!r.games.length){ msg.textContent = "No games found."; return; }
  list.innerHTML = r.games.map(g => `
    <div class="item" style="align-items:flex-start">
      <div style="flex:1">
        <div style="font-weight:900">${htmlEscape(g.title)}</div>
        <div class="small">${htmlEscape(g.project)}</div>
        <div class="muted">${htmlEscape(g.description || "")}</div>
        <div class="hr"></div>
        <div class="row">
          <button class="primary" data-launch="${htmlEscape(g.project)}">Launch</button>
          <button data-token="${htmlEscape(g.project)}">Get token</button>
          <span class="small" data-out="${htmlEscape(g.project)}"></span>
        </div>
      </div>
    </div>
  `).join("");
  document.querySelectorAll("[data-token]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const project = btn.dataset.token;
      const out = document.querySelector(`[data-out="${CSS.escape(project)}"]`);
      out.textContent = "…";
      try{
        const t = await api("/api/launcher/token", { method:"POST", body:{ game_project: project }});
        out.textContent = `token=${t.token} (expires ${new Date(t.expires_at).toLocaleTimeString()})`;
      }catch(e){ out.textContent = "error: " + e.message; }
    });
  });
  document.querySelectorAll("[data-launch]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const project = btn.dataset.launch;
      const out = document.querySelector(`[data-out="${CSS.escape(project)}"]`);
      out.textContent = "…";
      try{
        const t = await api("/api/launcher/token", { method:"POST", body:{ game_project: project }});
        // This is where a native launcher would take over.
        out.textContent = `Launcher token: ${t.token}`;
        alert(`Launch stub\n\nGame: ${project}\nToken: ${t.token}\n\nIn a real launcher: pass token to game and call /api/launcher/verify from the game.`);
      }catch(e){ out.textContent = "error: " + e.message; }
    });
  });
}
document.querySelector("#go").addEventListener("click", load);
await load();
