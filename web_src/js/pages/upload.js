import { requireAuth } from "../auth.js";
await requireAuth();
const $ = (id)=>document.getElementById(id);
const uploadBtn = $("uploadBtn");
const resetBtn = $("resetBtn");
const status = $("status");
const progress = document.querySelector(".progress");
const bar = progress.firstElementChild;
function projectify(s){
  return String(s||"")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"")
    .slice(0,80);
}
$("title").addEventListener("input", ()=>{
  if(!$("project").value.trim()){
    $("project").value = projectify($("title").value);
  }
});
uploadBtn.onclick = async ()=>{
  status.textContent = "";
  const file = $("file").files[0];
  if(!file){ status.textContent = "No ZIP selected"; return; }
  const title = $("title").value.trim();
  const project = $("project").value.trim();
  const version = $("version").value.trim();
  const entry_html = ($("entry_html").value.trim() || "index");
  if(!title || !project || !version){
    status.textContent = "Title, project, version required.";
    return;
  }
  progress.style.display = "block";
  bar.style.width = "0%";
  const form = new FormData();
  form.append("zip", file);
  form.append("title", title);
  form.append("project", project);
  form.append("version", version);
  form.append("entry_html", entry_html);
  form.append("category", $("category").value);
  form.append("description", $("description").value.trim());
  const token = localStorage.getItem("token");
  await new Promise((resolve)=>{
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/gamehosting/upload");
    xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.upload.onprogress = (e)=>{
      if(e.lengthComputable){
        bar.style.width = Math.round((e.loaded / e.total) * 100) + "%";
      }
    };
    xhr.onload = ()=>{
      try{
        const json = JSON.parse(xhr.responseText || "{}");
        if(xhr.status === 200 && json.ok){
          status.textContent = `Upload OK (${json.approval_status}). URL: ${json.url}`;
          bar.style.width = "100%";
        }else{
          status.textContent = "Upload failed: " + (json.error || xhr.responseText);
        }
      }catch{
        status.textContent = "Upload failed: " + xhr.responseText;
      }
      resolve();
    };
    xhr.onerror = ()=>{ status.textContent = "Network error"; resolve(); };
    xhr.send(form);
  });
};
resetBtn.onclick = ()=>{
  ["title","project","version","entry_html","description"].forEach(id=>$(id).value="");
  $("category").value="platformer";
  $("file").value="";
  progress.style.display="none";
  status.textContent="";
};
