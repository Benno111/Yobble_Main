export function toast(msg){
  const d=document.createElement("div");
  d.className="toast";
  d.textContent=msg;
  document.body.appendChild(d);
  setTimeout(()=>d.remove(),4000);
}
