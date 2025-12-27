import { requireLoginOrRedirect } from "./auth.js";
import { api } from "/js/api-pages/friends.js";
import { mountTopbar, htmlEscape } from "./ui.js";
requireLoginOrRedirect();
await mountTopbar("friends");
const q = document.querySelector("#q");
const results = document.querySelector("#results");
const msg = document.querySelector("#msg");
const incoming = document.querySelector("#incoming");
const friends = document.querySelector("#friends");
const outgoing = document.querySelector("#outgoing");
async function refreshLists(){
  const r = await api("/api/friends");
  incoming.innerHTML = r.incoming.map(u => `
    <div class="item">
      <div class="avatar">${u.avatar_url ? `<img src="${htmlEscape(u.avatar_url)}">` : ""}</div>
      <div style="flex:1">
        <div style="font-weight:900">${htmlEscape(u.display_name || u.username)}</div>
        <div class="small">@${htmlEscape(u.username)}</div>
      </div>
      <button class="primary" data-accept="${u.id}">Accept</button>
      <button data-decline="${u.id}">Decline</button>
    </div>
  `).join("") || `<div class="small">None</div>`;
  friends.innerHTML = r.friends.map(u => `
    <div class="item">
      <div class="avatar">${u.avatar_url ? `<img src="${htmlEscape(u.avatar_url)}">` : ""}</div>
      <div style="flex:1">
        <div style="font-weight:900">${htmlEscape(u.display_name || u.username)}</div>
        <div class="small">@${htmlEscape(u.username)}</div>
      </div>
      <button class="danger" data-remove="${u.id}">Remove</button>
    </div>
  `).join("") || `<div class="small">No friends yet.</div>`;
  outgoing.innerHTML = r.outgoing.map(u => `
    <div class="item">
      <div class="avatar">${u.avatar_url ? `<img src="${htmlEscape(u.avatar_url)}">` : ""}</div>
      <div style="flex:1">
        <div style="font-weight:900">${htmlEscape(u.display_name || u.username)}</div>
        <div class="small">@${htmlEscape(u.username)}</div>
      </div>
      <span class="tag">pending</span>
    </div>
  `).join("") || `<div class="small">None</div>`;
  document.querySelectorAll("[data-accept]").forEach(btn=>btn.onclick = async ()=>{
    await api("/api/friends/accept", { method:"POST", body:{ from_user_id: Number(btn.dataset.accept) }});
    await refreshLists();
  });
  document.querySelectorAll("[data-decline]").forEach(btn=>btn.onclick = async ()=>{
    await api("/api/friends/decline", { method:"POST", body:{ from_user_id: Number(btn.dataset.decline) }});
    await refreshLists();
  });
  document.querySelectorAll("[data-remove]").forEach(btn=>btn.onclick = async ()=>{
    await api("/api/friends/remove", { method:"POST", body:{ friend_user_id: Number(btn.dataset.remove) }});
    await refreshLists();
  });
}
async function searchUsers(){
  msg.textContent = "";
  results.innerHTML = "";
  const qs = q.value.trim();
  if(!qs){ msg.textContent = "Type something to search."; return; }
  const r = await api(`/api/profile/lookup?q=${encodeURIComponent(qs)}`);
  if(!r.users.length){ msg.textContent = "No users found."; return; }
  results.innerHTML = r.users.map(u => `
    <div class="item">
      <div class="avatar">${u.avatar_url ? `<img src="${htmlEscape(u.avatar_url)}">` : ""}</div>
      <div style="flex:1">
        <div style="font-weight:900">${htmlEscape(u.display_name || u.username)}</div>
        <div class="small">@${htmlEscape(u.username)}</div>
      </div>
      <button class="primary" data-add="${u.id}">Add</button>
    </div>
  `).join("");
  document.querySelectorAll("[data-add]").forEach(btn=>btn.onclick = async ()=>{
    try{
      await api("/api/friends/request", { method:"POST", body:{ to_user_id: Number(btn.dataset.add) }});
      btn.textContent = "Sent";
      btn.disabled = true;
      await refreshLists();
    }catch(e){
      btn.textContent = e.message;
    }
  });
}
document.querySelector("#go").addEventListener("click", searchUsers);
await refreshLists();
