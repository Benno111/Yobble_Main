import { requireLogin } from "../auth.js";
    import { mountShell, setContent } from "../nav.js";

    requireLogin();
    await mountShell("modaudit");

    setContent(`
      <div class="grid">
        <div class="card" style="grid-column: span 8">
          <div class="h1">Audit Log</div>
          <div class="muted">This page is ready. It will display real data once the matching API endpoints exist on the server.</div>
          <div class="hr"></div>
          <div class="h2">Server endpoints expected</div>
          <pre>[
  "GET /api/admin/audit"
]</pre>
        </div>
        <div class="card" style="grid-column: span 4">
          <div class="h2">Status</div>
          <div class="item">UI: ✅ loaded</div>
          <div class="item">API: ⚠ depends on server</div>
          <div class="hr"></div>
          <div class="small">You can keep using Reports right now — it works with the current server ZIP.</div>
        </div>
      </div>
    `);
