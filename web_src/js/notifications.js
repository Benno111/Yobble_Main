import { api } from "./api.js";
let cache = [];
function escapeHtml(v){
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}
function formatTime(v){
  const t = v ? new Date(v) : null;
  if (!t || Number.isNaN(t.getTime())) return "";
  const mins = Math.floor((Date.now() - t.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
export async function loadNotifications(){
  const res = await api.get("/api/notifications");
  cache = Array.isArray(res) ? res : (res.notifications || []);
  const b = document.getElementById("notifBadge");
  if(!b) return;
  const u = cache.filter(n => !n.is_read).length;
  b.hidden = u === 0;
  b.textContent = u;
}
function renderMenu(menu){
  if (!cache.length) {
    menu.innerHTML = `<div class="notifItem small">No notifications yet.</div>`;
    return;
  }
  menu.innerHTML = `
    <div class="notifItem small">
      <button class="secondary" data-mark-all>Mark all read</button>
    </div>
    ${cache.slice(0, 10).map(n => `
      <a class="notifItem ${n.is_read ? "" : "unread"}" href="${escapeHtml(n.link || "#")}" data-id="${n.id}">
        <strong>${escapeHtml(n.title)}</strong>
        <div class="small">${escapeHtml(n.body || "")}</div>
        <div class="small">${escapeHtml(formatTime(n.created_at))}</div>
      </a>`).join("")}
  `;
}
export function mountNotifMenu(){
  const btn = document.getElementById("notifBtn");
  const menu = document.getElementById("notifMenu");
  if(!btn || !menu) return;
  btn.onclick = async () => {
    menu.classList.toggle("hidden");
    if (!menu.classList.contains("hidden")) {
      menu.innerHTML = `<div class="notifItem small">Loading…</div>`;
      await loadNotifications();
      renderMenu(menu);
    }
  };
  menu.addEventListener("click", async (e) => {
    const markAll = e.target.closest("[data-mark-all]");
    if (markAll) {
      await api.post("/api/notifications/read-all");
      await loadNotifications();
      renderMenu(menu);
      return;
    }
    const item = e.target.closest("[data-id]");
    if (item) {
      const id = Number(item.dataset.id);
      if (!Number.isNaN(id)) {
        await api.post("/api/notifications/read", { id });
        await loadNotifications();
        renderMenu(menu);
      }
    }
  });
}
