import express from "express";
import { all, run, get } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

export const inventoryRouter = express.Router();

inventoryRouter.get("/me", requireAuth, async (req,res)=>{
  const rows = await all(
    `SELECT i.code, i.name, inv.qty
     FROM inventory inv
     JOIN items i ON i.id=inv.item_id
     WHERE inv.user_id=?
     ORDER BY i.name`,
    [req.user.uid]
  );
  res.json({ items: rows });
});

inventoryRouter.post("/give", requireAuth, requireRole("admin"), async (req,res)=>{
  const code = String(req.body?.code || "").trim();
  const qty = Math.max(1, Number(req.body?.qty || 1));
  if(!code) return res.status(400).json({ error:"missing_fields" });

  const item = await get("SELECT id FROM items WHERE code=?", [code]);
  if(!item) return res.status(404).json({ error:"item_not_found" });

  await run(
    `INSERT INTO inventory(user_id,item_id,qty)
     VALUES(?,?,?)
     ON CONFLICT(user_id,item_id) DO UPDATE SET qty=qty+excluded.qty`,
    [req.user.uid, item.id, qty]
  );
  res.json({ ok:true });
});
