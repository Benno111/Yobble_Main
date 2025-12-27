import { requireLoginOrRedirect } from "./auth.js";
import { api } from "/js/api-pages/market.js";
import { mountTopbar, htmlEscape } from "./ui.js";
requireLoginOrRedirect();
await mountTopbar("market");
const list = document.querySelector("#list");
const msg = document.querySelector("#msg");
async function refresh(){
  const r = await api("/api/market/listings");
  list.innerHTML = (r.listings || []).map(l => `
    <div class="item" style="align-items:flex-start">
      <div style="flex:1">
        <div style="font-weight:900">${htmlEscape(l.name)} <span class="tag">${htmlEscape(l.code)}</span></div>
        <div class="small">Seller: @${htmlEscape(l.seller)} • Qty: ${l.qty} • Price each: ${l.price_each}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        <input style="width:120px" type="number" min="1" max="${l.qty}" value="1" id="buyqty-${l.id}">
        <button class="primary" data-buy="${l.id}" data-max="${l.qty}">Buy</button>
      </div>
    </div>
  `).join("") || `<div class="small">No active listings.</div>`;
  document.querySelectorAll("[data-buy]").forEach(btn=> btn.onclick = async ()=>{
    msg.textContent = "";
    const id = Number(btn.dataset.buy);
    const qty = Number(document.querySelector(`#buyqty-${id}`).value || 1);
    try{
      await api("/api/market/buy", { method:"POST", body:{ listing_id: id, qty }});
      msg.textContent = "Purchase complete.";
      await refresh();
    }catch(e){
      msg.textContent = "Buy failed: " + e.message;
    }
  });
}
document.querySelector("#create").onclick = async ()=>{
  msg.textContent = "";
  const code = document.querySelector("#code").value.trim();
  const qty = Number(document.querySelector("#qty").value || 1);
  const price_each = Number(document.querySelector("#price_each").value || 1);
  try{
    await api("/api/market/create", { method:"POST", body:{ item_code: code, qty, price_each }});
    msg.textContent = "Listing created.";
    await refresh();
  }catch(e){
    msg.textContent = "Create failed: " + e.message;
  }
};
await refresh();
