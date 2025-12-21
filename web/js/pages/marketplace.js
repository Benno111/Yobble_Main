import { requireLogin } from "../auth.js";
import { mountShell, setContent } from "../nav.js";

requireLogin();
await mountShell("market");

setContent(`
  <div class="market-shell">
    <section class="market-hero card">
      <div>
        <div class="pill">Open market</div>
        <div class="h1">Marketplace</div>
        <div class="muted">Trade, collect, and list items. We will surface real listings as soon as the API is enabled.</div>
        <div class="row" style="margin-top:14px;flex-wrap:wrap">
          <span class="pill">0 live listings</span>
          <span class="pill">Fast checkout</span>
          <span class="pill">Secure escrow</span>
        </div>
      </div>
      <div class="market-art">Trade floor</div>
    </section>

    <section class="market-controls card">
      <div>
        <label>Search</label>
        <input placeholder="Search listings, sellers, tags" disabled>
      </div>
      <div>
        <label>Category</label>
        <select disabled>
          <option>All categories</option>
        </select>
      </div>
      <div>
        <label>Sort</label>
        <select disabled>
          <option>Newest</option>
        </select>
      </div>
    </section>

    <section class="market-grid">
      <div class="card market-card">
        <div class="market-card-head">
          <div class="h2">Listing flow</div>
          <span class="pill">API pending</span>
        </div>
        <div class="muted">Expected endpoints</div>
        <pre>[
  "GET /api/market/listings",
  "POST /api/market/create",
  "POST /api/market/buy"
]</pre>
      </div>

      <div class="card market-card">
        <div class="market-card-head">
          <div class="h2">Status</div>
          <span class="pill">UI ready</span>
        </div>
        <div class="item">UI: ✅ loaded</div>
        <div class="item">API: ⚠ depends on server</div>
        <div class="hr"></div>
        <div class="small">Tip: wire the market routes and this page comes alive.</div>
      </div>

      <div class="card market-card empty-card">
        <div class="h2">No listings yet</div>
        <div class="muted">Once enabled, listings will show here with price, rarity, and seller info.</div>
      </div>
    </section>
  </div>
`);
