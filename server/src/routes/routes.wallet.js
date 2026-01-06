import express from "express";
import { requireAuth, requireRole } from "../auth.js";
import { getBalance, changeBalance } from "./wallet.js";
import { all } from "../db.js";

export const walletRouter = express.Router();

walletRouter.get("/me", requireAuth, async (req,res)=>{
  const balance = await getBalance(req.user.uid);
  res.json({ balance });
});

walletRouter.get("/transactions", requireAuth, async (req,res)=>{
  const rows = await all(
    `SELECT amount, reason, ref_type, ref_id, created_at
     FROM wallet_transactions
     WHERE user_id=?
     ORDER BY created_at DESC
     LIMIT 100`,
    [req.user.uid]
  );
  res.json({ transactions: rows });
});

walletRouter.post("/grant", requireAuth, requireRole("admin"), async (req,res)=>{
  const user_id = Number(req.body?.user_id);
  const amount = Number(req.body?.amount);
  if(!user_id || !Number.isFinite(amount)) return res.status(400).json({ error:"missing_fields" });
  await changeBalance(user_id, amount, "grant");
  res.json({ ok:true });
});
