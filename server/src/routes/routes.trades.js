import express from "express";
import { requireAuth } from "../auth.js";
import { get, all, run } from "../db.js";
import { getBalance, changeBalance } from "./wallet.js";

export const tradesRouter = express.Router();

tradesRouter.post("/create", requireAuth, async (req,res)=>{
  const {
    to_username,
    give_items = [],
    take_items = [],
    give_currency = 0,
    take_currency = 0,
    expires_in_hours = 24
  } = req.body || {};

  const targetName = String(to_username || "").trim();
  if(!targetName) return res.status(400).json({ error:"missing_fields" });

  const target = await get("SELECT id FROM users WHERE username=?", [targetName]);
  if(!target) return res.status(404).json({ error:"user_not_found" });
  if(target.id === req.user.uid) return res.status(400).json({ error:"cannot_trade_self" });

  const giveCur = Math.max(0, Number(give_currency || 0));
  const takeCur = Math.max(0, Number(take_currency || 0));

  const bal = await getBalance(req.user.uid);
  if(bal < giveCur) return res.status(400).json({ error:"insufficient_funds" });

  const now = Date.now();
  const exp = now + Math.max(1, Number(expires_in_hours || 24)) * 3600_000;

  const r = await run(
    `INSERT INTO trades(from_user,to_user,from_currency,to_currency,status,created_at,expires_at)
     VALUES(?,?,?,?, 'pending', ?, ?)`,
    [req.user.uid, target.id, giveCur, takeCur, now, exp]
  );
  const trade_id = r.lastID;

  async function insertItems(user_id, items){
    for(const it of items){
      const code = String(it?.code || "").trim();
      const qty = Math.max(1, Number(it?.qty || 1));
      if(!code) continue;
      const item = await get("SELECT id FROM items WHERE code=?", [code]);
      if(!item) throw new Error("item_not_found:" + code);
      await run(`INSERT INTO trade_items(trade_id,user_id,item_id,qty) VALUES(?,?,?,?)`, [trade_id, user_id, item.id, qty]);
    }
  }

  try{
    await insertItems(req.user.uid, give_items);
    await insertItems(target.id, take_items);
  }catch(e){
    await run("DELETE FROM trades WHERE id=?", [trade_id]);
    return res.status(400).json({ error:String(e.message || e) });
  }

  res.json({ ok:true, trade_id });
});

tradesRouter.get("/my", requireAuth, async (req,res)=>{
  const rows = await all(
    `SELECT t.*, u1.username AS from_username, u2.username AS to_username
     FROM trades t
     JOIN users u1 ON u1.id=t.from_user
     JOIN users u2 ON u2.id=t.to_user
     WHERE t.from_user=? OR t.to_user=?
     ORDER BY t.created_at DESC
     LIMIT 200`,
    [req.user.uid, req.user.uid]
  );
  res.json({ trades: rows });
});

tradesRouter.get("/items", requireAuth, async (req,res)=>{
  const trade_id = Number(req.query?.trade_id);
  if(!trade_id) return res.status(400).json({ error:"missing_fields" });
  const t = await get("SELECT * FROM trades WHERE id=?", [trade_id]);
  if(!t) return res.status(404).json({ error:"trade_not_found" });
  if(t.from_user !== req.user.uid && t.to_user !== req.user.uid) return res.status(403).json({ error:"forbidden" });

  const items = await all(
    `SELECT ti.user_id, i.code, i.name, ti.qty
     FROM trade_items ti
     JOIN items i ON i.id=ti.item_id
     WHERE ti.trade_id=?`,
    [trade_id]
  );
  res.json({ items });
});

tradesRouter.post("/accept", requireAuth, async (req,res)=>{
  const trade_id = Number(req.body?.trade_id);
  if(!trade_id) return res.status(400).json({ error:"missing_trade_id" });

  const t = await get("SELECT * FROM trades WHERE id=?", [trade_id]);
  if(!t) return res.status(404).json({ error:"trade_not_found" });
  if(t.to_user !== req.user.uid) return res.status(403).json({ error:"not_your_trade" });
  if(t.status !== "pending") return res.status(400).json({ error:"invalid_state" });

  if(t.expires_at && t.expires_at < Date.now()){
    await run("UPDATE trades SET status='expired' WHERE id=?", [trade_id]);
    return res.status(400).json({ error:"trade_expired" });
  }

  const balFrom = await getBalance(t.from_user);
  const balTo = await getBalance(t.to_user);
  if(balFrom < t.from_currency) return res.status(400).json({ error:"sender_insufficient_funds" });
  if(balTo < t.to_currency) return res.status(400).json({ error:"receiver_insufficient_funds" });

  const items = await all("SELECT * FROM trade_items WHERE trade_id=?", [trade_id]);

  for(const it of items){
    const inv = await get("SELECT qty FROM inventory WHERE user_id=? AND item_id=?", [it.user_id, it.item_id]);
    if(!inv || inv.qty < it.qty) return res.status(400).json({ error:"insufficient_items" });
  }

  if(t.from_currency){
    await changeBalance(t.from_user, -t.from_currency, "trade", "trade", trade_id);
    await changeBalance(t.to_user, t.from_currency, "trade", "trade", trade_id);
  }
  if(t.to_currency){
    await changeBalance(t.to_user, -t.to_currency, "trade", "trade", trade_id);
    await changeBalance(t.from_user, t.to_currency, "trade", "trade", trade_id);
  }

  for(const it of items){
    const other = it.user_id === t.from_user ? t.to_user : t.from_user;

    await run("UPDATE inventory SET qty=qty-? WHERE user_id=? AND item_id=?", [it.qty, it.user_id, it.item_id]);
    await run(
      `INSERT INTO inventory(user_id,item_id,qty)
       VALUES(?,?,?)
       ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`,
      [other, it.item_id, it.qty]
    );
  }

  await run("UPDATE trades SET status='accepted' WHERE id=?", [trade_id]);
  res.json({ ok:true });
});

tradesRouter.post("/cancel", requireAuth, async (req,res)=>{
  const trade_id = Number(req.body?.trade_id);
  if(!trade_id) return res.status(400).json({ error:"missing_trade_id" });

  const t = await get("SELECT * FROM trades WHERE id=?", [trade_id]);
  if(!t) return res.status(404).json({ error:"trade_not_found" });
  if(t.from_user !== req.user.uid) return res.status(403).json({ error:"not_owner" });
  if(t.status !== "pending") return res.status(400).json({ error:"invalid_state" });

  await run("UPDATE trades SET status='cancelled' WHERE id=?", [trade_id]);
  res.json({ ok:true });
});
