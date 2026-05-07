import { api } from "./api.js";
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
  const avatar = me?.avatar_url || "/assets/logo.svg";
  const displayName = me?.display_name || me?.username || "Account";
  const handle = me?.username ? `@${me.username}` : "@account";
  const status = me?.status_text || "Tap profile to manage your account.";
  const links = [
    ["Home","/index","home"],
    ["Games","/games","games"],
    ["Friends","/friends","friends"],
    ["Stats","/stats","stats"],
    ["Inventory/Trades","/inventory","inv"],
    ["Marketplace","/market","market"],
    ...(isAdmin ? [["Admin","/admin","admin"]] : []),
    ["Profile","/profile","profile"]
  ];
  el.innerHTML = `
    <div class="topbar">
      <div class="brand">benno111<span>engene</span></div>
      <div class="nav">
        <div class="accountSummary accountSummary--inline">
          <img class="accountAvatar accountAvatar--large" src="${htmlEscape(avatar)}" alt="${htmlEscape(displayName)}">
          <div class="accountSummaryText">
            <div class="accountSummaryName">${htmlEscape(displayName)}</div>
            <div class="accountSummaryHandle">${htmlEscape(handle)}</div>
            <div class="accountSummaryStatus">${htmlEscape(status)}</div>
          </div>
        </div>
        ${links.map(([t,href,key])=>`<a class="${key===active?"active":""}" href="${href}">${t}</a>`).join("")}
        <a href="#" id="btnLogout">Logout</a>
      </div>
    </div>
  `;
  document.querySelector("#btnLogout")?.addEventListener("click",(e)=>{ e.preventDefault(); logout(); });
}
