import { requireLogin } from "../auth.js";
import { mountShell, setContent } from "../nav.js";

requireLogin();
await mountShell("home");

setContent(`
  <div class="grid">
    <div class="card" style="grid-column: span 8">
      <div class="h1">Welcome</div>
      <div class="muted">Use the sidebar to navigate. This UI is fully modular and ready for the full platform API.</div>
      <div class="hr"></div>
      <div class="list">
        <div class="item">✅ Auth (login/register) wired</div>
        <div class="item">✅ Reports + evidence upload wired</div>
        <div class="item">🧩 Friends / inventory / marketplace show placeholders until their APIs are enabled on the server</div>
      </div>
    </div>
    <div class="card" style="grid-column: span 4">
      <div class="h2">Quick links</div>
      <div class="row">
        <a class="pill" href="/games">Games</a>
        <a class="pill" href="/inventory">Inventory</a>
        <a class="pill" href="/marketplace">Marketplace</a>
        <a class="pill" href="/report">Report</a>
      </div>
      <div class="hr"></div>
      <div class="small">Tip: if a page says “API not enabled”, add the matching route on the server and it will instantly come alive.</div>
    </div>
  </div>
`);
