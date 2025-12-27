import express from "express";
import { all, get, run } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { nowMs, safeInt } from "../util.js";

export const adminRouter = express.Router();

adminRouter.use(requireAuth, requireRole("admin"));

adminRouter.get("/overview", async (req,res)=>{
  const users = await get(`SELECT COUNT(*) AS c FROM users`);
  const listings = await get(`SELECT COUNT(*) AS c FROM marketplace_listings WHERE status='active'`);
  const trades = await get(`SELECT COUNT(*) AS c FROM trade_offers WHERE status='pending'`);
  res.json({
    users: users?.c ?? 0,
    active_listings: listings?.c ?? 0,
    pending_trades: trades?.c ?? 0
  });
});

adminRouter.post("/grant_currency", async (req,res)=>{
  const user_id = Number(req.body?.user_id);
  const delta = safeInt(req.body?.delta, 0);
  if(!user_id || !delta) return res.status(400).json({ error:"missing_fields" });

  const now = nowMs();
  await run(
    `INSERT INTO wallets(user_id,balance,updated_at) VALUES(?,?,?)
     ON CONFLICT(user_id) DO NOTHING`,
    [user_id, 0, now]
  );

  const w = await get(`SELECT balance FROM wallets WHERE user_id=?`, [user_id]);
  const next = (w?.balance ?? 0) + delta;
  if(next < 0) return res.status(400).json({ error:"would_go_negative" });

  await run(`UPDATE wallets SET balance=?, updated_at=? WHERE user_id=?`, [next, now, user_id]);
  await run(`INSERT INTO currency_transactions(user_id,delta,reason,meta_json,created_at) VALUES(?,?,?,?,?)`,
    [user_id, delta, "admin_grant", JSON.stringify({ by: req.user.uid }), now]
  );

  res.json({ ok:true, balance: next });
});

adminRouter.post("/give_item", async (req,res)=>{
  const user_id = Number(req.body?.user_id);
  const item_code = String(req.body?.item_code || "").trim();
  const qty = safeInt(req.body?.qty, 1);
  if(!user_id || !item_code || qty<=0) return res.status(400).json({ error:"missing_fields" });

  const item = await get(`SELECT id FROM items WHERE code=?`, [item_code]);
  if(!item) return res.status(404).json({ error:"item_not_found" });

  await run(
    `INSERT INTO inventory(user_id,item_id,qty) VALUES(?,?,?)
     ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`,
    [user_id, item.id, qty]
  );

  res.json({ ok:true });
});

adminRouter.post("/create_game", async (req,res)=>{
  const slug = String(req.body?.slug || "").trim();
  const title = String(req.body?.title || "").trim();
  const description = String(req.body?.description || "").trim();
  const owner_user_id = Number(req.body?.owner_user_id) || req.user.uid;
  if(!slug || !title) return res.status(400).json({ error:"missing_fields" });

  try{
    const r = await run(
      `INSERT INTO games(slug,title,description,created_at,owner_user_id) VALUES(?,?,?,?,?)`,
      [slug, title, description || null, nowMs(), owner_user_id]
    );
    res.json({ ok:true, game_id: r.lastID });
  }catch(e){
    const msg = String(e?.message||"");
    if(msg.includes("UNIQUE")) return res.status(409).json({ error:"slug_taken" });
    console.error(e);
    res.status(500).json({ error:"server_error" });
  }
});
