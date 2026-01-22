import { requireLoginOrRedirect } from "./auth.js";
import { mountTopbar } from "./ui.js";
requireLoginOrRedirect();
await mountTopbar("home");
document.querySelector("#btnGames").onclick = ()=> location.href="/games";
document.querySelector("#btnMarket").onclick = ()=> location.href="/market";
document.querySelector("#btnInv").onclick = ()=> location.href="/inventory";
