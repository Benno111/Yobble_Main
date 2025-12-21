import { requireLoginOrRedirect } from "./auth.js";
import { api } from "./api.js";
import { mountTopbar, htmlEscape } from "./ui.js";

requireLoginOrRedirect();
await mountTopbar("currency");

const bal = document.querySelector("#bal");
const when = document.querySelector("#when");
const tx = document.querySelector("#tx");
const msg = document.querySelector("#msg");

async function refresh(){
  const r = await api("/api/currency/me");
  bal.textContent = String(r.wallet?.balance ?? 0);
  when.textContent = r.wallet?.updated_at ? new Date(r.wallet.updated_at).toLocaleString() : "—";
  tx.innerHTML = (r.transactions || []).map(t => `
    <div class="item">
      <div style="flex:1">
        <div style="font-weight:900">${t.delta>0?"+":""}${t.delta} — ${htmlEscape(t.reason)}</div>
        <div class="small">${new Date(t.created_at).toLocaleString()}</div>
      </div>
      <span class="tag">tx#${t.id}</span>
    </div>
  `).join("") || `<div class="small">No transactions</div>`;
}

document.querySelector("#earn").onclick = async ()=>{
  msg.textContent = "";
  try{ await api("/api/currency/adjust", { method:"POST", body:{ delta: 100, reason:"ui_test_earn" }}); }
  catch(e){ msg.textContent = e.message; }
  await refresh();
};
document.querySelector("#spend").onclick = async ()=>{
  msg.textContent = "";
  try{ await api("/api/currency/adjust", { method:"POST", body:{ delta: -60, reason:"ui_test_spend" }}); }
  catch(e){ msg.textContent = e.message; }
  await refresh();
};

await refresh();
