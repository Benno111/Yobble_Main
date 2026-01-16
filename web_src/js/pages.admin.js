import { requireLoginOrRedirect } from "./auth.js";
import { api } from "/js/api-pages/admin.js";
import { mountTopbar } from "./ui.js";
requireLoginOrRedirect();
await mountTopbar("admin");
const users = document.querySelector("#users");
const listings = document.querySelector("#listings");
const trades = document.querySelector("#trades");
const grantMsg = document.querySelector("#grantMsg");
const gameMsg = document.querySelector("#gameMsg");
async function refresh(){
  try{
    const r = await api("/api/admin/overview");
    users.textContent = r.users;
    listings.textContent = r.active_listings;
    trades.textContent = r.pending_trades;
  }catch(e){
    // If forbidden, kick user out of admin page
    alert("Admin access denied (role is not admin).");
    location.href = "/index.html";
  }
}
document.querySelector("#grant").onclick = async ()=>{
  grantMsg.textContent = "";
  try{
    const user_id = Number(document.querySelector("#user_id").value || 0);
    const delta = Number(document.querySelector("#delta").value || 0);
    const r = await api("/api/admin/grant_currency", { method:"POST", body:{ user_id, delta }});
    grantMsg.textContent = "OK. New Yobble Dollar balance: " + r.balance;
  }catch(e){ grantMsg.textContent = "Error: " + e.message; }
};
document.querySelector("#createGame").onclick = async ()=>{
  gameMsg.textContent = "";
  try{
    const project = document.querySelector("#project").value.trim();
    const title = document.querySelector("#title").value.trim();
    const description = document.querySelector("#description").value.trim();
    const r = await api("/api/admin/create_game", { method:"POST", body:{ project, title, description }});
    gameMsg.textContent = "Created game id: " + r.game_id;
  }catch(e){ gameMsg.textContent = "Error: " + e.message; }
};
await refresh();
