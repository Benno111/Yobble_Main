import express from "express";
import { all, get, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { nowMs, safeInt } from "../util.js";

export const marketplaceRouter = express.Router();

marketplaceRouter.get("/listings", requireAuth, async (req,res)=>{
  const rows = await all(
    `SELECT l.id,l.qty,l.price_each,l.status,l.created_at,
            i.code,i.name,
            u.username AS seller
     FROM marketplace_listings l
     JOIN items i ON i.id=l.item_id
     JOIN users u ON u.id=l.seller_user_id
     WHERE l.status='active' AND i.approval_status='approved'
     ORDER BY l.created_at DESC
     LIMIT 100`
  );
  res.json({ listings: rows });
});

marketplaceRouter.post("/create", requireAuth, async (req,res)=>{
  const uid = req.user.uid;
  const code = String(req.body?.item_code || "").trim();
  const qty = safeInt(req.body?.qty, 0);
  const price_each = safeInt(req.body?.price_each, 0);
  if(!code || qty<=0 || price_each<=0) return res.status(400).json({ error:"missing_fields" });

  const item = await get(`SELECT id, approval_status FROM items WHERE code=?`, [code]);
  if(!item) return res.status(404).json({ error:"item_not_found" });
  if (item.approval_status !== "approved") {
    return res.status(400).json({ error:"item_not_approved" });
  }

  const have = await get(`SELECT qty FROM inventory WHERE user_id=? AND item_id=?`, [uid, item.id]);
  if((have?.qty ?? 0) < qty) return res.status(400).json({ error:"insufficient_items" });

  const now = nowMs();
  const r = await run(
    `INSERT INTO marketplace_listings(seller_user_id,item_id,qty,price_each,status,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?)`,
    [uid, item.id, qty, price_each, "active", now, now]
  );
  res.json({ ok:true, listing_id: r.lastID });
});

marketplaceRouter.post("/cancel", requireAuth, async (req,res)=>{
  const uid = req.user.uid;
  const listing_id = Number(req.body?.listing_id);
  const l = await get(`SELECT * FROM marketplace_listings WHERE id=?`, [listing_id]);
  if(!l) return res.status(404).json({ error:"not_found" });
  if(l.seller_user_id !== uid) return res.status(403).json({ error:"forbidden" });
  if(l.status !== "active") return res.status(400).json({ error:"not_active" });

  await run(`UPDATE marketplace_listings SET status='canceled', updated_at=? WHERE id=?`, [nowMs(), listing_id]);
  res.json({ ok:true });
});

marketplaceRouter.post("/buy", requireAuth, async (req,res)=>{
  const buyer = req.user.uid;
  const listing_id = Number(req.body?.listing_id);
  const qty = safeInt(req.body?.qty, 0);
  if(!listing_id || qty<=0) return res.status(400).json({ error:"missing_fields" });

  const l = await get(`SELECT * FROM marketplace_listings WHERE id=?`, [listing_id]);
  if(!l) return res.status(404).json({ error:"not_found" });
  if(l.status !== "active") return res.status(400).json({ error:"not_active" });
  if(l.seller_user_id === buyer) return res.status(400).json({ error:"cannot_buy_own" });
  if(l.qty < qty) return res.status(400).json({ error:"not_enough_qty" });

  const cost = qty * l.price_each;

  // check wallet
  const bw = await get(`SELECT balance FROM wallets WHERE user_id=?`, [buyer]);
  if((bw?.balance ?? 0) < cost) return res.status(400).json({ error:"insufficient_funds" });

  // check seller has items (still) in inventory
  const have = await get(`SELECT qty FROM inventory WHERE user_id=? AND item_id=?`, [l.seller_user_id, l.item_id]);
  if((have?.qty ?? 0) < qty) return res.status(400).json({ error:"seller_missing_items" });

  const now = nowMs();

  // money transfer
  await run(`UPDATE wallets SET balance=balance-?, updated_at=? WHERE user_id=?`, [cost, now, buyer]);
  await run(`UPDATE wallets SET balance=balance+?, updated_at=? WHERE user_id=?`, [cost, now, l.seller_user_id]);

  await run(`INSERT INTO currency_transactions(user_id,delta,reason,meta_json,created_at) VALUES(?,?,?,?,?)`,
    [buyer, -cost, "market_buy", JSON.stringify({ listing_id, qty }), now]
  );
  await run(`INSERT INTO currency_transactions(user_id,delta,reason,meta_json,created_at) VALUES(?,?,?,?,?)`,
    [l.seller_user_id, cost, "market_sell", JSON.stringify({ listing_id, qty }), now]
  );

  // item transfer
  await run(`UPDATE inventory SET qty=qty-? WHERE user_id=? AND item_id=?`, [qty, l.seller_user_id, l.item_id]);
  await run(`DELETE FROM inventory WHERE user_id=? AND item_id=? AND qty<=0`, [l.seller_user_id, l.item_id]);

  await run(
    `INSERT INTO inventory(user_id,item_id,qty) VALUES(?,?,?)
     ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`,
    [buyer, l.item_id, qty]
  );

  // listing qty update
  const remaining = l.qty - qty;
  if(remaining <= 0){
    await run(`UPDATE marketplace_listings SET qty=0, status='sold', updated_at=? WHERE id=?`, [now, listing_id]);
  }else{
    await run(`UPDATE marketplace_listings SET qty=?, updated_at=? WHERE id=?`, [remaining, now, listing_id]);
  }

  res.json({ ok:true });
});
