import { api } from "../api-pages/ui.js";
import { logout } from "./auth.js";
export function htmlEscape(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
export async function mountTopbar(active){
  const el = document.querySelector("#topbar");
  if(!el) return;
  let me = null;
  try{ me = (await api("/api/profile/me")).profile; }catch{}
  const isAdmin = me?.role === "admin";
  const links = [
    ["Home","/index","home"],
    ["Games","/games","games"],
    ["Friends","/friends","friends"],
    ["Stats","/stats","stats"],
    ["Yobble Dollar","/currency","currency"],
    ["Inventory/Trades","/inventory","inv"],
    ["Marketplace","/market","market"],
    ...(isAdmin ? [["Admin","/admin","admin"]] : []),
    ["Profile","/profile","profile"]
  ];
  el.innerHTML = `
    <div class="topbar">
      <div class="brand">benno111<span>engene</span></div>
      <div class="nav">
        ${links.map(([t,href,key])=>`<a class="${key===active?"active":""}" href="${href}">${t}</a>`).join("")}
        <a href="#" id="btnLogout">Logout</a>
      </div>
    </div>
  `;
  document.querySelector("#btnLogout")?.addEventListener("click",(e)=>{ e.preventDefault(); logout(); });
}
