import { api } from "../api.js";
import { requireAuth } from "../auth.js";

await requireAuth();

const list = document.getElementById("games-list");

function gameCard(g){
  const d = document.createElement("div");
  d.className = "card";

  const playable = Boolean(g.latest_version && g.entry_html);

  d.innerHTML = `
    <h3>
      <a href="/games/${g.slug}"
         style="color:#7aa2ff;text-decoration:none">
        ${g.title}
      </a>
    </h3>

    <div class="muted">${g.category || ""}</div>
    <p>${g.description || ""}</p>

    ${
      playable
        ? `<button class="primary" data-slug="${g.slug}">Play</button>`
        : `<div class="muted">No published version</div>`
    }
  `;

  if (playable) {
    d.querySelector("button").onclick = async () => {
      const t = await api.post("/api/launcher/token", {
        game_slug: g.slug
      });

      const url =
        `/play.html?slug=${encodeURIComponent(g.slug)}` +
        `&version=${encodeURIComponent(g.latest_version)}` +
        `&entry=${encodeURIComponent(g.entry_html)}` +
        `&launch_token=${encodeURIComponent(t.token)}`;

      if (window.electron?.openGame) {
        window.electron.openGame(url);
      } else {
        location.href = url;
      }
    };
  }

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
