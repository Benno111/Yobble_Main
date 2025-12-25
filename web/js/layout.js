import { getCurrentUser } from "./auth-client.js";

export async function mountTopbar(page){
  const token = localStorage.getItem("token");
  const headerPromise = fetch("/partials/header.html").then(r => r.text());
  const userPromise = getCurrentUser();
  const walletPromise = token
    ? fetch("/api/wallet", {
        headers: { Authorization: "Bearer " + token }
      })
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null)
    : Promise.resolve(null);

  const [headerHtml, user, walletData] = await Promise.all([
    headerPromise,
    userPromise,
    walletPromise
  ]);

  document.body.insertAdjacentHTML("afterbegin", headerHtml);

  const navToggle = document.getElementById("navToggle");
  if (navToggle) {
    navToggle.addEventListener("click", () => {
      const isOpen = document.body.classList.toggle("nav-open");
      navToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
  }

  if(user && (user.role==="admin"||user.role==="moderator")){
    const el=document.getElementById("adminLinks"); if(el) el.hidden=false;
  }

  document.querySelectorAll("#mainNav a").forEach(a=>{
    if(a.dataset.page===page) a.classList.add("active");
  });

  const balanceEl = document.getElementById("walletBalance");
  if (token && balanceEl) {
    if (walletData) {
      const balance = Number(walletData?.balance ?? 0);
      balanceEl.textContent = `Balance ${Number.isFinite(balance) ? balance : 0}`;
    } else {
      balanceEl.textContent = "Balance —";
    }
  } else if (balanceEl) {
    balanceEl.remove();
  }
}
