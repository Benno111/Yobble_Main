import express from "express";
import { all, get, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { nowMs, safeInt } from "../util.js";

export const currencyRouter = express.Router();

currencyRouter.get("/me", requireAuth, async (req,res)=>{
  const w = await get(`SELECT balance, updated_at FROM wallets WHERE user_id=?`, [req.user.uid]);
  const tx = await all(
    `SELECT id, delta, reason, meta_json, created_at
     FROM currency_transactions
     WHERE user_id=?
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.user.uid]
  );
  res.json({ wallet: w || { balance:0, updated_at:null }, transactions: tx });
});

currencyRouter.post("/adjust", requireAuth, async (req,res)=>{
  const uid = req.user.uid;
  const delta = safeInt(req.body?.delta, 0);
  const reason = String(req.body?.reason || "adjust");
  const meta_json = req.body?.meta ? JSON.stringify(req.body.meta) : null;
  if(!delta) return res.status(400).json({ error:"delta_required" });

  const now = nowMs();
  await run(
    `INSERT INTO wallets(user_id,balance,updated_at) VALUES(?,?,?)
     ON CONFLICT(user_id) DO NOTHING`,
    [uid, 0, now]
  );
  const w = await get(`SELECT balance FROM wallets WHERE user_id=?`, [uid]);
  const next = (w?.balance ?? 0) + delta;
  if(next < 0) return res.status(400).json({ error:"insufficient_funds" });

  await run(`UPDATE wallets SET balance=?, updated_at=? WHERE user_id=?`, [next, now, uid]);
  await run(
    `INSERT INTO currency_transactions(user_id,delta,reason,meta_json,created_at) VALUES(?,?,?,?,?)`,
    [uid, delta, reason, meta_json, now]
  );
  res.json({ ok:true, balance: next });
});
