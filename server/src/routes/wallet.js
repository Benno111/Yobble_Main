import express from "express";
import { requireAuth, requireRole } from "../auth.js";
import { get, run } from "../db.js";

export const walletRouter = express.Router();

/* GET /api/wallet */
walletRouter.get("/", requireAuth, async (req, res) => {
  const row = await get("SELECT balance FROM wallets WHERE user_id=?", [req.user.uid]);
  res.json(row || { balance: 0 });
});

/* POST /api/wallet/grant (DEV/ADMIN)
   { amount, reason }
*/
walletRouter.post("/grant", requireAuth, requireRole("admin", "mod", "moderator"), async (req, res) => {
  const { amount, reason, username } = req.body || {};
  const a = Number(amount || 0);
  if (!Number.isFinite(a) || a === 0) return res.status(400).json({ error: "bad_amount" });

  let targetId = req.user.uid;
  if (username) {
    const u = await get("SELECT id FROM users WHERE username=?", [String(username).trim()]);
    if (!u) return res.status(404).json({ error: "user_not_found" });
    targetId = u.id;
  }

  const now = Date.now();
  await run("INSERT OR IGNORE INTO wallets(user_id,balance,updated_at) VALUES(?,?,?)", [targetId, 0, now]);
  await run("UPDATE wallets SET balance = balance + ?, updated_at=? WHERE user_id=?", [a, now, targetId]);
  await run(
    "INSERT INTO wallet_transactions(user_id,amount,reason,created_at) VALUES(?,?,?,?)",
    [targetId, a, String(reason || "grant"), now]
  );

  res.json({ ok: true });
});
