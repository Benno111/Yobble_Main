import { api } from "../api-pages/market.js";
import { requireAuth } from "../auth.js";
await requireAuth();
const c = document.getElementById("listings");
c.innerHTML = "<div class='card'>Loading…</div>";
const r = await api.get("/api/market/listings");
c.innerHTML = "";
for(const l of (r.listings || [])){
  const d = document.createElement("div");
  d.className = "card";
  d.innerHTML = `<h3>${l.name}</h3><div class="muted">${l.qty} available</div><div><strong>${l.price}</strong> coins</div>`;
  c.appendChild(d);
}
