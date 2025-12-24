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
walletRouter.post("/grant", requireAuth, async (req, res) => {
  const { amount, reason, username } = req.body || {};
  const a = Number(amount || 0);
  if (!Number.isFinite(a) || a === 0) return res.status(400).json({ error: "bad_amount" });

  let targetId = req.user.uid;
  if (username) {
    if (!(req.user.role === "admin" || req.user.role === "mod" || req.user.role === "moderator")) {
      return res.status(403).json({ error: "forbidden" });
    }
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

/* POST /api/wallet/connect
   { address }
*/
walletRouter.post("/connect", requireAuth, async (req, res) => {
  const address = String(req.body?.address || "").trim();
  const label = String(req.body?.label || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "invalid_address" });
  }
  if (!label) {
    return res.status(400).json({ error: "missing_label" });
  }
  if (label.length > 60) {
    return res.status(400).json({ error: "label_too_long" });
  }

  const existing = await get(
    "SELECT id FROM users WHERE wallet_address=? AND id<>?",
    [address, req.user.uid]
  );
  if (existing) {
    return res.status(409).json({ error: "address_in_use" });
  }

  await run(
    "UPDATE users SET wallet_address=?, wallet_connected_at=?, wallet_label=? WHERE id=?",
    [address, Date.now(), label, req.user.uid]
  );

  res.json({ ok: true, address });
});
