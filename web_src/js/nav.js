import { getMe } from "./state.js";
import { logout } from "./auth.js";
function navLink(href, label, id, activeId){
  const a = document.createElement("a");
  a.href = href;
  a.textContent = label;
  if(id === activeId) a.classList.add("active");
  return a;
}
export async function mountShell(activeId){
  const me = await getMe();
  const role = me?.role || "user";
  const isStaff = role === "admin" || role === "moderator";
  document.body.innerHTML = `
    <div class="app">
      <aside class="sidebar">
        <div class="brand">
          <img src="/assets/logo.svg" alt="logo">
          <div>
            <div class="title">benno111engene</div>
            <div class="sub">game platform</div>
          </div>
        </div>
        <nav class="nav" id="nav"></nav>
        <div class="hr"></div>
        <div class="small muted" style="padding:0 10px 10px">
          Signed in as <b>${(me?.username||"player")}</b>
          <div style="margin-top:6px">
            <span class="badge ${role==='admin'?'good':role==='moderator'?'warn':''}">${role.toUpperCase()}</span>
          </div>
        </div>
      </aside>
      <main class="main">
        <div class="topbar">
          <div class="left">
            <span class="pill">beta UI</span>
            <span class="pill">Yobble Dollar</span>
          </div>
          <div class="row">
            <a class="pill" href="/report">Report</a>
            ${isStaff ? `<a class="pill" href="/mod/dashboard">Moderation</a>` : ``}
            <button class="secondary" id="logoutBtn">Logout</button>
          </div>
        </div>
        <div class="content" id="content"></div>
      </main>
    </div>
  `;
  const nav = document.querySelector("#nav");
  nav.appendChild(navLink("/index","Home","home",activeId));
  nav.appendChild(navLink("/games","Games","games",activeId));
  nav.appendChild(navLink("/friends","Friends","friends",activeId));
  nav.appendChild(navLink("/inventory","Inventory","inv",activeId));
  nav.appendChild(navLink("/marketplace","Marketplace","market",activeId));
  nav.appendChild(navLink("/profile","Profile","profile",activeId));
  if(isStaff){
    nav.appendChild(document.createElement("div")).className="hr";
    nav.appendChild(navLink("/mod/dashboard","Mod Dashboard","moddash",activeId));
    nav.appendChild(navLink("/mod/reports","Reports","modreports",activeId));
    nav.appendChild(navLink("/mod/accounts","Accounts","modaccounts",activeId));
    nav.appendChild(navLink("/mod/appeals","Appeals","modappeals",activeId));
    nav.appendChild(navLink("/mod/audit","Audit Log","modaudit",activeId));
  }
  document.querySelector("#logoutBtn").onclick = logout;
}
export function setContent(html){
  document.querySelector("#content").innerHTML = html;
}
