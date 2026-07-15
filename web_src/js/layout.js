import { clearAuthState } from "./auth-storage.js";
import { applyTheme, bindThemeSelect } from "./theme.js";

applyTheme();

const HEADER_HTML = `
<header>
  <img src="/assets/logo.svg" alt="Yobble" style="width:28px;height:28px">
  <nav id="Nav">
    <a href="/index" data-page="ugames">Yobble</a>
  </nav>
  <button id="navToggle" class="iconBtn navToggle" aria-expanded="false" aria-controls="mainNav" aria-label="Toggle navigation">
    <span class="navToggleBar"></span>
    <span class="navToggleBar"></span>
    <span class="navToggleBar"></span>
  </button>
  <nav id="mainNav">
    <div class="navDropdown">
      <button class="navDropdownToggle" type="button" aria-expanded="false">
        <span class="navIcon" aria-hidden="true">🎮</span>
        <span class="navLabel navLabel-full">Play</span>
        <span class="navLabel navLabel-abbr">Play</span>
        <span class="navLabel navLabel-emoji">🎮</span>
        <span class="navDropdownArrow" aria-hidden="true">▾</span>
      </button>
      <div class="navDropdownMenu" role="menu">
        <a href="/games" data-page="ugames" role="menuitem">Games</a>
        <a href="/library" data-page="ulibrary" role="menuitem">Library</a>
      </div>
    </div>
    <div class="navDropdown">
      <button class="navDropdownToggle" type="button" aria-expanded="false">
        <span class="navIcon" aria-hidden="true">💬</span>
        <span class="navLabel navLabel-full">Social</span>
        <span class="navLabel navLabel-abbr">Social</span>
        <span class="navLabel navLabel-emoji">💬</span>
        <span class="navDropdownArrow" aria-hidden="true">▾</span>
      </button>
      <div class="navDropdownMenu" role="menu">
        <a href="/friends" data-page="ufriends" role="menuitem">Friends</a>
        <a href="/chat/" data-page="uchat" role="menuitem">Chat</a>
        <a href="/profile" data-page="uprofile" role="menuitem">Profile</a>
      </div>
    </div>
    <div class="navDropdown">
      <button class="navDropdownToggle" type="button" aria-expanded="false">
        <span class="navIcon" aria-hidden="true">⤴️</span>
        <span class="navLabel navLabel-full">Create</span>
        <span class="navLabel navLabel-abbr">Create</span>
        <span class="navLabel navLabel-emoji">⤴️</span>
        <span class="navDropdownArrow" aria-hidden="true">▾</span>
      </button>
      <div class="navDropdownMenu" role="menu">
        <a href="/upload" id="navUpload" data-page="upload" role="menuitem">Upload</a>
      </div>
    </div>
    <span id="adminLinks" hidden>
      <a href="/modqueue"><span class="navIcon" aria-hidden="true">🛡️</span><span class="navLabel navLabel-full">Moderation</span><span class="navLabel navLabel-abbr">M</span><span class="navLabel navLabel-emoji">🛡️</span></a>
    </span>
  </nav>
  <div class="header-right" id="headerRight">
    <div class="navDropdown userDropdown">
      <button class="navDropdownToggle" type="button" aria-expanded="false">
        <img class="accountAvatar accountAvatar--small" id="headerAvatar" alt="" hidden>
        <span id="headerUsername">Account</span>
        <span class="navDropdownArrow" aria-hidden="true">▾</span>
      </button>
      <div class="navDropdownMenu" role="menu">
        <div class="accountSummary" id="accountSummary" hidden>
          <img class="accountAvatar accountAvatar--large" id="accountAvatarLarge" alt="">
          <div class="accountSummaryText">
            <div class="accountSummaryName" id="accountName">Account</div>
            <div class="accountSummaryHandle" id="accountHandle">@username</div>
            <div class="accountSummaryStatus" id="accountStatus">Manage your profile from anywhere.</div>
          </div>
        </div>
        <a href="/profile" role="menuitem">Profile</a>
        <a href="/User-Settings" role="menuitem">User settings</a>
        <a href="#" id="logoutBtn" role="menuitem">Logout</a>
      </div>
    </div>
  </div>
  <div class="window-controls" id="windowControls" hidden aria-label="Window controls">
    <button type="button" class="windowControl" data-window-action="minimize" aria-label="Minimize window">−</button>
    <button type="button" class="windowControl" data-window-action="maximize" aria-label="Maximize window">▢</button>
    <button type="button" class="windowControl windowControl-close" data-window-action="close" aria-label="Close window">×</button>
  </div>
</header>
`;
export async function mountTopbar(page){
  const token = localStorage.getItem("token");
  const username = localStorage.getItem("username");
  const role = localStorage.getItem("role");
  document.body.insertAdjacentHTML("afterbegin", HEADER_HTML);
  const themeSelect = document.getElementById("theme");
  if (themeSelect) {
    bindThemeSelect(themeSelect);
  }
  if (window.electron) {
    document.body.classList.add("desktop-app");
    const windowControls = document.getElementById("windowControls");
    if (windowControls) {
      windowControls.hidden = false;
      windowControls.querySelectorAll("[data-window-action]").forEach((button) => {
        button.addEventListener("click", async () => {
          const action = button.dataset.windowAction;
          if (action === "minimize") {
            await window.electron.windowMinimize();
          } else if (action === "maximize") {
            await window.electron.windowToggleMaximize();
          } else if (action === "close") {
            await window.electron.windowClose();
          }
        });
      });
    }
  }
  const navToggle = document.getElementById("navToggle");
  if (navToggle) {
    navToggle.addEventListener("click", () => {
      const isOpen = document.body.classList.toggle("nav-open");
      navToggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
  }
  if(role === "admin" || role === "moderator"){
    const el=document.getElementById("adminLinks"); if(el) el.hidden=false;
  }
  const headerRight = document.getElementById("headerRight");
  const headerUsername = document.getElementById("headerUsername");
  const headerAvatar = document.getElementById("headerAvatar");
  const accountSummary = document.getElementById("accountSummary");
  const accountAvatarLarge = document.getElementById("accountAvatarLarge");
  const accountName = document.getElementById("accountName");
  const accountHandle = document.getElementById("accountHandle");
  const accountStatus = document.getElementById("accountStatus");
  if (token && headerUsername) {
    headerUsername.textContent = username || "Account";
    try {
      const profileRes = await fetch("/api/profile/me", {
        headers: { Authorization: "Bearer " + token }
      });
      if (profileRes.ok) {
        const data = await profileRes.json();
        const profile = data?.profile || data || {};
        const displayName = profile.display_name || profile.username || username || "Account";
        const handle = profile.username ? `@${profile.username}` : `@${username || "account"}`;
        const status = profile.status_text || "Manage your profile from anywhere.";
        const avatar = profile.avatar_url || "/assets/logo.svg";
        headerUsername.textContent = displayName;
        if (headerAvatar) {
          headerAvatar.src = avatar;
          headerAvatar.alt = displayName;
          headerAvatar.hidden = false;
        }
        if (accountSummary) accountSummary.hidden = false;
        if (accountAvatarLarge) {
          accountAvatarLarge.src = avatar;
          accountAvatarLarge.alt = displayName;
        }
        if (accountName) accountName.textContent = displayName;
        if (accountHandle) accountHandle.textContent = handle;
        if (accountStatus) accountStatus.textContent = status;
      }
    } catch {
      if (accountSummary) accountSummary.hidden = false;
    }
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
      clearAuthState();
      location.href = "/login";
    });
  }
  if (window.electron) {
    const uploadLink = document.getElementById("navUpload");
    if (uploadLink) uploadLink.style.display = "none";
  }
  const balanceEl = document.getElementById("walletBalance");
  if (balanceEl) {
    balanceEl.remove();
  }
}

export async function loadLayout(page = "") {
  return mountTopbar(page);
}
