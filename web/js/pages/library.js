import { api } from "../api.js";
import { requireAuth } from "../auth.js";
await requireAuth();

const list = document.getElementById("list");
list.innerHTML = "<div class='card'>Loading…</div>";

const r = await api.get("/api/library");
list.innerHTML = "";

for(const g of (r.games || [])){
  const d = document.createElement("div");
  d.className = "card";
  d.innerHTML = `
    <h3><a href="/games/${g.slug}" style="color:#7aa2ff;text-decoration:none">${g.title}</a></h3>
    <div class="muted">${g.category || ""}</div>
    <p>${g.description || ""}</p>
    <button class="secondary" style="width:auto" data-slug="${g.slug}">Remove</button>
  `;
  d.querySelector("button").onclick = async ()=>{
    await api.post("/api/library/remove", { slug: g.slug });
    location.reload();
  };
  list.appendChild(d);
}

if(!(r.games||[]).length){
  const d = document.createElement("div");
  d.className="card";
  d.textContent="Your library is empty.";
  list.appendChild(d);
}
