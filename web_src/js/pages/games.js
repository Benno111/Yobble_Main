import { api } from "../api-pages/games.js";
import { requireAuth } from "../auth.js";
await requireAuth();
const list = document.getElementById("games-list");
function gameCard(g){
  const d = document.createElement("div");
  d.className = "card";
  d.innerHTML = `
    ${g.is_featured ? `<div class="ribbon">Featured</div>` : ""}
    <h3><a href="/games/${g.project}">${g.title}</a></h3>
  `;
  return d;
}
async function load(){
  list.innerHTML = "";
  const res = await api.get("/api/games");
  const games = Array.isArray(res) ? res : (res.games || []);
  if (!games.length) {
    list.innerHTML = `<div class="card">No games available</div>`;
    return;
  }
  for (const g of games) {
    list.appendChild(gameCard(g));
  }
}
load();
