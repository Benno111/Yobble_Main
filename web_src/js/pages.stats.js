import { requireLoginOrRedirect } from "./auth.js";
import { api } from "/js/api-pages/stats.js";
import { mountTopbar, htmlEscape } from "./ui.js";
requireLoginOrRedirect();
await mountTopbar("stats");
const list = document.querySelector("#list");
const r = await api("/api/stats/my");
list.innerHTML = (r.stats || []).map(s => `
  <div class="item">
    <div style="flex:1">
      <div style="font-weight:900">${htmlEscape(s.title)}</div>
      <div class="small">${htmlEscape(s.project)}</div>
      <div class="muted small">Playtime: ${s.playtime_seconds}s • Matches: ${s.matches_played} • Wins: ${s.wins}</div>
    </div>
  </div>
`).join("") || `<div class="small">No stats yet (games/launcher can post /api/stats/bump).</div>`;
