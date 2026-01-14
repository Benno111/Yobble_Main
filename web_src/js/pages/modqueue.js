import { api } from "../api-pages/modqueue.js";
import { requireAuth } from "../auth.js";
const me = await requireAuth();
const pending = document.getElementById("pending");
if(!(me.role === "admin" || me.role === "moderator")){
  pending.innerHTML = '<div class="card">Forbidden: moderator/admin only</div>';
  throw new Error("forbidden");
}
function card(html){
  const d=document.createElement("div");
  d.className="card";
  d.innerHTML=html;
  return d;
}
async function load(){
  pending.innerHTML = "";
  const r = await api.get("/api/mod/games/pending");
  if(!(r.pending || []).length){
    pending.appendChild(card("<h3>No pending uploads</h3>"));
    return;
  }
  for(const p of r.pending){
    const d = card(`
      <h3>${p.project} — ${p.version}</h3>
      <div class="muted">${p.title || ""}</div>
      <div class="muted">uploader: ${p.uploader || "?"}</div>
      <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap">
        <button class="primary" data-act="approve" data-project="${p.project}" data-ver="${p.version}">Approve</button>
        <button class="secondary" data-act="approve_publish" data-project="${p.project}" data-ver="${p.version}">Approve + Publish</button>
        <button class="secondary" data-act="reject" data-project="${p.project}" data-ver="${p.version}">Reject</button>
      </div>
    `);
    d.querySelectorAll("button").forEach(btn=>{
      btn.onclick = async ()=>{
        const project = btn.dataset.project;
        const version = btn.dataset.ver;
        const act = btn.dataset.act;
        if(act === "reject"){
          const reason = prompt("Reject reason (optional):") || "";
          await api.post("/api/mod/games/reject", { project, version, reason });
        }else if(act === "approve_publish"){
          await api.post("/api/mod/games/approve", { project, version, publish:true });
        }else{
          await api.post("/api/mod/games/approve", { project, version, publish:false });
        }
        await load();
      };
    });
    pending.appendChild(d);
  }
}
load();
