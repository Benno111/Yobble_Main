import express from "express";
import { requireAuth, requireRole } from "../auth.js";
import { all, get, run } from "../db.js";

export const marketRouter = express.Router();

async function ensureAutoListings() {
  const now = Date.now();
  let seller = await get("SELECT id FROM users WHERE username=?", ["connent"]);
  if (!seller) {
    await run("INSERT INTO users(username,password_hash,role) VALUES(?,?,?)", [
      "connent",
      "",
      "user"
    ]);
    seller = await get("SELECT id FROM users WHERE username=?", ["connent"]);
    if (!seller) return;
  }

  const legacyListings = await all(
    "SELECT id, seller_id, item_id, qty, price, created_at FROM marketplace"
  );
  for (const l of legacyListings) {
    const exists = await get(
      "SELECT id FROM marketplace_listings WHERE seller_user_id=? AND item_id=? AND status='active'",
      [l.seller_id, l.item_id]
    );
    if (!exists) {
      await run(
        `INSERT INTO marketplace_listings(seller_user_id,item_id,qty,price_each,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?)`,
        [l.seller_id, l.item_id, l.qty, l.price, "active", l.created_at || now, now]
      );
    }
  }

  const allItems = await all(
    `SELECT id FROM items`
  );
  for (const item of allItems) {
    const stock = await get(
      "SELECT qty_remaining FROM marketplace_auto_stock WHERE seller_id=? AND item_id=?",
      [seller.id, item.id]
    );
    if (!stock) {
      await run(
        "INSERT OR IGNORE INTO marketplace_auto_stock(seller_id,item_id,qty_remaining,updated_at) VALUES(?,?,?,?)",
        [seller.id, item.id, 100, now]
      );
    }
    const current = stock?.qty_remaining ?? 100;
    const listing = await get(
      "SELECT id, qty, status FROM marketplace_listings WHERE seller_user_id=? AND item_id=?",
      [seller.id, item.id]
    );
    if (current > 0 && !listing) {
      await run(
        `INSERT INTO marketplace_listings(seller_user_id,item_id,qty,price_each,status,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?)`,
        [seller.id, item.id, current, 50, "active", now, now]
      );
    } else if (current <= 0 && listing) {
      await run(
        "UPDATE marketplace_listings SET qty=0, status='sold', updated_at=? WHERE id=?",
        [now, listing.id]
      );
    } else if (listing && listing.qty !== current) {
      await run(
        "UPDATE marketplace_listings SET qty=?, updated_at=? WHERE id=?",
        [current, now, listing.id]
      );
    }
  }
}

/* GET /api/market */
marketRouter.get("/", async (_req, res) => {
  await ensureAutoListings();

  const rows = await all(
    `SELECT l.id, l.seller_user_id AS seller_id, u.username AS seller_username,
            i.id AS item_id, i.code, i.name,
            l.qty, l.price_each AS price, l.created_at
     FROM marketplace_listings l
     JOIN items i ON i.id = l.item_id
     JOIN users u ON u.id = l.seller_user_id
     WHERE l.status='active'
     ORDER BY l.created_at DESC`
  );
  res.json({ listings: rows });
});

/* POST /api/market/seed */
marketRouter.post("/seed", requireAuth, requireRole("admin"), async (_req, res) => {
  await ensureAutoListings();
  res.json({ ok: true });
});

/* POST /api/market/list { item_code, qty, price } */
marketRouter.post("/list", requireAuth, async (req, res) => {
  const { item_code, qty, price } = req.body || {};
  const q = Number(qty || 0);
  const p = Number(price || 0);
  if (!item_code || !Number.isFinite(q) || q <= 0 || !Number.isFinite(p) || p <= 0) {
    return res.status(400).json({ error: "bad_request" });
  }

  const item = await get("SELECT id FROM items WHERE code=?", [item_code]);
  if (!item) return res.status(404).json({ error: "item_not_found" });

  const have = await get(
    "SELECT qty FROM inventory WHERE user_id=? AND item_id=?",
    [req.user.uid, item.id]
  );
  if ((have?.qty ?? 0) < q) return res.status(400).json({ error: "insufficient_items" });

  const now = Date.now();
  await run(
    `INSERT INTO marketplace_listings(seller_user_id,item_id,qty,price_each,status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?)`,
    [req.user.uid, item.id, q, p, "active", now, now]
  );

  res.json({ ok: true });
});

/* POST /api/market/buy { listing_id, qty } */
marketRouter.post("/buy", requireAuth, async (req, res) => {
  const listing_id = Number(req.body?.listing_id);
  const qty = Number(req.body?.qty || 0);
  if (!listing_id || !Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: "bad_request" });
  }

  const listing = await get(
    `SELECT l.id, l.seller_user_id AS seller_id, l.item_id, l.qty, l.price_each AS price, l.status
     FROM marketplace_listings l
     WHERE l.id=?`,
    [listing_id]
  );
  if (!listing) return res.status(404).json({ error: "listing_not_found" });
  if (listing.status !== "active") return res.status(400).json({ error: "not_active" });
  if (listing.seller_id === req.user.uid) {
    return res.status(400).json({ error: "cannot_buy_own" });
  }
  if (listing.qty < qty) {
    return res.status(400).json({ error: "not_enough_qty" });
  }

  const cost = qty * listing.price;
  const now = Date.now();
  await run("INSERT OR IGNORE INTO wallets(user_id,balance,updated_at) VALUES(?,?,?)", [req.user.uid, 0, now]);
  await run("INSERT OR IGNORE INTO wallets(user_id,balance,updated_at) VALUES(?,?,?)", [listing.seller_id, 0, now]);

  const buyerWallet = await get("SELECT balance FROM wallets WHERE user_id=?", [req.user.uid]);
  if ((buyerWallet?.balance ?? 0) < cost) {
    return res.status(400).json({ error: "insufficient_funds" });
  }

  const remaining = listing.qty - qty;
  if (remaining <= 0) {
    await run(
      "UPDATE marketplace_listings SET qty=0, status='sold', updated_at=? WHERE id=?",
      [now, listing.id]
    );
  } else {
    await run(
      "UPDATE marketplace_listings SET qty=?, updated_at=? WHERE id=?",
      [remaining, now, listing.id]
    );
  }

  const seller = await get("SELECT username FROM users WHERE id=?", [listing.seller_id]);
  if (seller?.username === "connent") {
    await run(
      `UPDATE marketplace_auto_stock SET qty_remaining=?, updated_at=?
       WHERE seller_id=? AND item_id=?`,
      [Math.max(remaining, 0), now, listing.seller_id, listing.item_id]
    );
  }

  await run(
    "UPDATE wallets SET balance=balance-?, updated_at=? WHERE user_id=?",
    [cost, now, req.user.uid]
  );
  await run(
    "UPDATE wallets SET balance=balance+?, updated_at=? WHERE user_id=?",
    [cost, now, listing.seller_id]
  );
  await run(
    "INSERT INTO wallet_transactions(user_id,amount,reason,ref_type,ref_id,created_at) VALUES(?,?,?,?,?,?)",
    [req.user.uid, -cost, "market_buy", "listing", listing.id, now]
  );
  await run(
    "INSERT INTO wallet_transactions(user_id,amount,reason,ref_type,ref_id,created_at) VALUES(?,?,?,?,?,?)",
    [listing.seller_id, cost, "market_sell", "listing", listing.id, now]
  );

  await run(
    `INSERT INTO inventory(user_id,item_id,qty)
     VALUES(?,?,?)
     ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`,
    [req.user.uid, listing.item_id, qty]
  );

  res.json({ ok: true });
});

/* POST /api/market/cancel { listing_id } */
marketRouter.post("/cancel", requireAuth, async (req, res) => {
  const listing_id = Number(req.body?.listing_id);
  if (!listing_id) return res.status(400).json({ error: "missing_fields" });

  const listing = await get(
    "SELECT id, seller_user_id, status FROM marketplace_listings WHERE id=?",
    [listing_id]
  );
  if (!listing) return res.status(404).json({ error: "not_found" });
  if (listing.seller_user_id !== req.user.uid) return res.status(403).json({ error: "forbidden" });
  if (listing.status !== "active") return res.status(400).json({ error: "not_active" });

  await run(
    "UPDATE marketplace_listings SET status='canceled', updated_at=? WHERE id=?",
    [Date.now(), listing_id]
  );
  res.json({ ok: true });
});
