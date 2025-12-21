import { requireAuth, logout } from "../auth.js";
const u = await requireAuth();
document.getElementById("info").textContent = JSON.stringify(u, null, 2);
document.getElementById("logout").onclick = logout;
