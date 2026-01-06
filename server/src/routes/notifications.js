import express from "express";
import { all, run } from "../db.js";
import { requireAuth } from "../auth.js";

export const notificationsRouter = express.Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get("/", async (req,res)=>{
  const rows = await all(
    "SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50",
    [req.user.id]
  );
  res.json(rows);
});

notificationsRouter.post("/read", async (req,res)=>{
  await run("UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?",
    [req.body.id, req.user.id]);
  res.json({ok:true});
});

notificationsRouter.post("/read-all", async (req,res)=>{
  await run("UPDATE notifications SET is_read=1 WHERE user_id=?", [req.user.id]);
  res.json({ok:true});
});
