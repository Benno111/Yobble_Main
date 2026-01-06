import express from "express";
import { all } from "../db.js";
import { requireAuth } from "../auth.js";

export const marketRouter = express.Router();

marketRouter.get("/listings", requireAuth, async (_req,res)=>{
  const rows = await all(
    `SELECT m.id, i.code, i.name, m.qty, m.price, u.username AS seller, m.created_at
     FROM marketplace m
     JOIN items i ON i.id=m.item_id
     JOIN users u ON u.id=m.seller_id
     ORDER BY m.created_at DESC`
  );
  res.json({ listings: rows });
});
