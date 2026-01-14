import express from "express";
import { requireAuth, requireRole } from "../auth.js";
import { all } from "../db.js";

export const modSearchRouter = express.Router();

modSearchRouter.get("/", requireAuth, requireRole("moderator"), async (req,res)=>{
  const q = "%" + String(req.query.q||"").trim() + "%";
  if(q.length < 3) return res.json({ users:[], games:[], items:[] });

  const users = await all(`SELECT id,username FROM users WHERE username LIKE ?`, [q]);
  const games = await all(`SELECT id,project,title FROM games WHERE project LIKE ?`, [q]);
  const items = await all(`SELECT id,code,name FROM items WHERE code LIKE ?`, [q]);

  res.json({ users, games, items });
});
