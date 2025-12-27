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
        <div class="small">${htmlEscape(g.slug)}</div>
        <div class="muted">${htmlEscape(g.description || "")}</div>
        <div class="hr"></div>
        <div class="row">
          <button class="primary" data-launch="${htmlEscape(g.slug)}">Launch</button>
          <button data-token="${htmlEscape(g.slug)}">Get token</button>
          <span class="small" data-out="${htmlEscape(g.slug)}"></span>
        </div>
      </div>
    </div>
  `).join("");
  document.querySelectorAll("[data-token]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const slug = btn.dataset.token;
      const out = document.querySelector(`[data-out="${CSS.escape(slug)}"]`);
      out.textContent = "…";
      try{
        const t = await api("/api/launcher/token", { method:"POST", body:{ game_slug: slug }});
        out.textContent = `token=${t.token} (expires ${new Date(t.expires_at).toLocaleTimeString()})`;
      }catch(e){ out.textContent = "error: " + e.message; }
    });
  });
  document.querySelectorAll("[data-launch]").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const slug = btn.dataset.launch;
      const out = document.querySelector(`[data-out="${CSS.escape(slug)}"]`);
      out.textContent = "…";
      try{
        const t = await api("/api/launcher/token", { method:"POST", body:{ game_slug: slug }});
        // This is where a native launcher would take over.
        out.textContent = `Launcher token: ${t.token}`;
        alert(`Launch stub\n\nGame: ${slug}\nToken: ${t.token}\n\nIn a real launcher: pass token to game and call /api/launcher/verify from the game.`);
      }catch(e){ out.textContent = "error: " + e.message; }
    });
  });
}
document.querySelector("#go").addEventListener("click", load);
await load();
