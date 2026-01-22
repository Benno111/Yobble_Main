import { getCurrentUser } from "./auth-client.js";
export async function mountTopbar(page){
  const token = localStorage.getItem("token");
  const headerPromise = fetch("/partials/header").then(r => r.text());
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
  const headerRight = document.getElementById("headerRight");
  const headerUsername = document.getElementById("headerUsername");
  if (user && headerUsername) {
    headerUsername.textContent = user.username || "Account";
  } else if (headerRight) {
    headerRight.remove();
  }
  document.querySelectorAll("#mainNav a").forEach(a=>{
    if(a.dataset.page===page) a.classList.add("active");
  });
  document.querySelectorAll(".navDropdownToggle").forEach((toggle) => {
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      const wrap = toggle.closest(".navDropdown");
      const isOpen = wrap.classList.toggle("open");
      toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
      document.querySelectorAll(".navDropdown").forEach((other) => {
        if (other !== wrap) {
          other.classList.remove("open");
          const btn = other.querySelector(".navDropdownToggle");
          if (btn) btn.setAttribute("aria-expanded", "false");
        }
      });
    });
  });
  document.addEventListener("click", () => {
    document.querySelectorAll(".navDropdown").forEach((wrap) => {
      if (wrap.classList.contains("open")) {
        wrap.classList.remove("open");
        const btn = wrap.querySelector(".navDropdownToggle");
        if (btn) btn.setAttribute("aria-expanded", "false");
      }
    });
  });
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", (event) => {
      event.preventDefault();
      localStorage.removeItem("token");
      localStorage.removeItem("username");
      location.href = "/login";
    });
  }
  if (window.electron) {
    const uploadLink = document.getElementById("navUpload");
    if (uploadLink) uploadLink.style.display = "none";
  }
  const balanceEl = document.getElementById("walletBalance");
  if (token && balanceEl) {
    if (walletData) {
      const balance = Number(walletData?.balance ?? 0);
      balanceEl.textContent = `Yobble Dollar ${Number.isFinite(balance) ? balance : 0}`;
    } else {
      balanceEl.textContent = "Yobble Dollar —";
    }
  } else if (balanceEl) {
    balanceEl.remove();
  }
}
