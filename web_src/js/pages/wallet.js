import { api } from "../api-pages/wallet.js";
import { requireAuth } from "../auth.js";
await requireAuth();
const bal = document.getElementById("balance");
const tx = document.getElementById("tx");
const b = await api.get("/api/wallet/me");
bal.textContent = String(b.balance);
const t = await api.get("/api/wallet/transactions");
tx.innerHTML = "";
for(const row of (t.transactions || [])){
  const d = document.createElement("div");
  d.className = "card";
  d.innerHTML = `<div><strong>${row.amount}</strong> — ${row.reason}</div><div class="muted">${new Date(row.created_at).toLocaleString()}</div>`;
  tx.appendChild(d);
}
