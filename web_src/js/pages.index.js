import { requireLoginOrRedirect } from "./auth.js";
import { mountTopbar } from "./ui.js";
requireLoginOrRedirect();
await mountTopbar("home");
document.querySelector("#btnGames").onclick = ()=> location.href="/games.html";
document.querySelector("#btnMarket").onclick = ()=> location.href="/market.html";
document.querySelector("#btnInv").onclick = ()=> location.href="/inventory.html";
