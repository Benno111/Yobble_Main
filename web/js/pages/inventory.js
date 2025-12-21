import { api } from "../api.js";
import { requireAuth } from "../auth.js";
await requireAuth();

const c = document.getElementById("items");
c.innerHTML = "<div class='card'>Loading…</div>";

const r = await api.get("/api/inventory/me");
c.innerHTML = "";
for(const i of (r.items || [])){
  const d = document.createElement("div");
  d.className = "card";
  d.innerHTML = `<h3>${i.name}</h3><div class="muted">x${i.qty}</div>`;
  c.appendChild(d);
}
