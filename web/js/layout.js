import { getCurrentUser } from "./auth-client.js";

export async function mountTopbar(page){
  const res = await fetch("/partials/header.html");
  document.body.insertAdjacentHTML("afterbegin", await res.text());

  const user = await getCurrentUser();
  if(user && (user.role==="admin"||user.role==="moderator")){
    const el=document.getElementById("adminLinks"); if(el) el.hidden=false;
  }

  document.querySelectorAll("#mainNav a").forEach(a=>{
    if(a.dataset.page===page) a.classList.add("active");
  });

  const token = localStorage.getItem("token");
  const balanceEl = document.getElementById("walletBalance");
  if (token && balanceEl) {
    try{
      const r = await fetch("/api/wallet", {
        headers: { Authorization: "Bearer " + token }
      });
      if (r.ok) {
        const data = await r.json();
        const balance = Number(data?.balance ?? 0);
        balanceEl.textContent = `Balance ${Number.isFinite(balance) ? balance : 0}`;
      } else {
        balanceEl.textContent = "Balance —";
      }
    }catch{
      balanceEl.textContent = "Balance —";
    }
  } else if (balanceEl) {
    balanceEl.remove();
  }
}
