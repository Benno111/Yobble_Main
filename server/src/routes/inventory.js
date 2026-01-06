import express from "express";
import { requireAuth, requireRole } from "../auth.js";
import { all, get, run } from "../db.js";

export const inventoryRouter = express.Router();

/* GET /api/inventory */
inventoryRouter.get("/", requireAuth, async (req, res) => {
  const canSeePending = ["admin", "mod", "moderator"].includes(req.user?.role);
  const rows = await all(
    `SELECT i.id, i.code, i.name, i.description,
            CASE WHEN i.approval_status='approved' OR ?=1 THEN i.icon_path ELSE NULL END AS icon_path,
            inv.qty
     FROM inventory inv
     JOIN items i ON i.id = inv.item_id
     WHERE inv.user_id=?`,
    [canSeePending ? 1 : 0, req.user.uid]
  );
  res.json(rows);
});

/* POST /api/inventory/give  (DEV/ADMIN)
   { code, qty }
*/
inventoryRouter.post("/give", requireAuth, requireRole("admin", "mod", "moderator"), async (req, res) => {
  const { code, qty } = req.body || {};
  const q = Number(qty || 0);
  if (!code || !Number.isFinite(q) || q <= 0) return res.status(400).json({ error: "bad_request" });

  const item = await get("SELECT id FROM items WHERE code=?", [code]);
  if (!item) return res.status(404).json({ error: "item_not_found" });

  await run(
    `INSERT INTO inventory(user_id,item_id,qty)
     VALUES(?,?,?)
     ON CONFLICT(user_id,item_id)
     DO UPDATE SET qty = qty + excluded.qty`,
    [req.user.uid, item.id, q]
  );

  res.json({ ok: true });
});
