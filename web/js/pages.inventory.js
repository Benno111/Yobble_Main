import { requireLoginOrRedirect } from "./auth.js";
import { api } from "./api.js";
import { mountTopbar, htmlEscape } from "./ui.js";

requireLoginOrRedirect();
await mountTopbar("inv");

const inv = document.querySelector("#inv");
const invMsg = document.querySelector("#invMsg");

const incoming = document.querySelector("#incoming");
const outgoing = document.querySelector("#outgoing");
const tradeMsg = document.querySelector("#tradeMsg");

async function refreshInv(){
  const r = await api("/api/inventory/me");
  inv.innerHTML = (r.inventory || []).map(it => `
    <div class="item">
      <div style="flex:1">
        <div style="font-weight:900">${htmlEscape(it.name)} <span class="tag">${htmlEscape(it.code)}</span></div>
        <div class="small">Qty: ${it.qty}</div>
        <div class="muted small">${htmlEscape(it.description || "")}</div>
      </div>
    </div>
  `).join("") || `<div class="small">Inventory empty. Use “Give test item”.</div>`;
}

async function refreshTrades(){
  const r = await api("/api/inventory/trades");
  incoming.innerHTML = (r.incoming || []).map(t => `
    <div class="item">
      <div style="flex:1">
        <div style="font-weight:900">From @${htmlEscape(t.from_username)} <span class="tag">${htmlEscape(t.status)}</span></div>
        <div class="small">Trade #${t.id} • ${new Date(t.created_at).toLocaleString()}</div>
        <div class="muted small">${htmlEscape(t.note || "")}</div>
      </div>
      ${t.status === "pending" ? `
        <button class="primary" data-accept="${t.id}">Accept</button>
      ` : ""}
    </div>
  `).join("") || `<div class="small">No incoming trades.</div>`;

  outgoing.innerHTML = (r.outgoing || []).map(t => `
    <div class="item">
      <div style="flex:1">
        <div style="font-weight:900">To @${htmlEscape(t.to_username)} <span class="tag">${htmlEscape(t.status)}</span></div>
        <div class="small">Trade #${t.id} • ${new Date(t.created_at).toLocaleString()}</div>
        <div class="muted small">${htmlEscape(t.note || "")}</div>
      </div>
      ${t.status === "pending" ? `<button data-cancel="${t.id}">Cancel</button>` : ""}
    </div>
  `).join("") || `<div class="small">No outgoing trades.</div>`;

  document.querySelectorAll("[data-accept]").forEach(b=> b.onclick = async ()=>{
    await api("/api/inventory/trades/accept", { method:"POST", body:{ trade_id: Number(b.dataset.accept) }});
    await refreshInv(); await refreshTrades();
  });
  document.querySelectorAll("[data-cancel]").forEach(b=> b.onclick = async ()=>{
    await api("/api/inventory/trades/cancel", { method:"POST", body:{ trade_id: Number(b.dataset.cancel) }});
    await refreshTrades();
  });
}

document.querySelector("#give").onclick = async ()=>{
  invMsg.textContent = "";
  try{
    await api("/api/inventory/give", { method:"POST", body:{ item_code: document.querySelector("#give_code").value, qty: Number(document.querySelector("#give_qty").value || 1) }});
    invMsg.textContent = "Added.";
  }catch(e){ invMsg.textContent = "Error: " + e.message; }
  await refreshInv();
};

document.querySelector("#createTrade").onclick = async ()=>{
  tradeMsg.textContent = "";
  const to_user_id = Number(document.querySelector("#to_user_id").value || 0);
  const note = document.querySelector("#note").value || "";
  const give_item = document.querySelector("#give_item").value.trim();
  const give_item_qty = Number(document.querySelector("#give_item_qty").value || 1);
  const want_item = document.querySelector("#want_item").value.trim();
  const want_item_qty = Number(document.querySelector("#want_item_qty").value || 1);

  const give = give_item ? [{ code: give_item, qty: give_item_qty }] : [];
  const want = want_item ? [{ code: want_item, qty: want_item_qty }] : [];

  try{
    const r = await api("/api/inventory/trades/create", { method:"POST", body:{ to_user_id, note, give, want }});
    tradeMsg.textContent = `Created trade #${r.trade_id}`;
    await refreshTrades();
  }catch(e){
    tradeMsg.textContent = "Error: " + e.message;
  }
};

await refreshInv();
await refreshTrades();
