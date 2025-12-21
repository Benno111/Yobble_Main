import { requireLoginOrRedirect } from "./auth.js";
import { api } from "./api.js";
import { mountTopbar, htmlEscape } from "./ui.js";

requireLoginOrRedirect();
await mountTopbar("profile");

const avWrap = document.querySelector("#avWrap");
const avatar_url = document.querySelector("#avatar_url");
const display_name = document.querySelector("#display_name");
const bio = document.querySelector("#bio");
const status_text = document.querySelector("#status_text");
const msg = document.querySelector("#msg");

async function refresh(){
  const r = await api("/api/profile/me");
  const p = r.profile;
  avatar_url.value = p.avatar_url || "";
  display_name.value = p.display_name || "";
  bio.value = p.bio || "";
  status_text.value = p.status_text || "";
  avWrap.innerHTML = p.avatar_url ? `<img src="${htmlEscape(p.avatar_url)}">` : "";
}
document.querySelector("#save").addEventListener("click", async ()=>{
  msg.textContent = "";
  try{
    await api("/api/profile/me", { method:"PATCH", body:{
      avatar_url: avatar_url.value.trim() || null,
      display_name: display_name.value.trim() || null,
      bio: bio.value,
      status_text: status_text.value.trim() || null
    }});
    msg.textContent = "Saved.";
    await refresh();
  }catch(e){
    msg.textContent = "Save failed: " + e.message;
  }
});

await refresh();
