import express from "express";
import { requireAuth } from "../auth.js";
import { all, get, run } from "../db.js";

export const reviewsRouter = express.Router();

reviewsRouter.get("/:project/reviews", requireAuth, async (req,res)=>{
  const project = String(req.params.project || "").trim();
  const g = await get("SELECT id FROM games WHERE project=? AND is_hidden=0", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const rows = await all(
    `SELECT r.rating, r.comment, r.created_at, r.updated_at, u.username
     FROM game_reviews r
     JOIN users u ON u.id=r.user_id
     WHERE r.game_id=?
       AND (u.is_banned IS NULL OR u.is_banned=0)
     ORDER BY r.updated_at DESC
     LIMIT 100`,
    [g.id]
  );

  const avg = await get(`SELECT AVG(rating) AS avg, COUNT(*) AS count FROM game_reviews WHERE game_id=?`, [g.id]);
  res.json({ reviews: rows, avg_rating: avg?.avg ?? null, count: avg?.count ?? 0 });
});

reviewsRouter.post("/:project/review", requireAuth, async (req,res)=>{
  const project = String(req.params.project || "").trim();
  const rating = Number(req.body?.rating);
  const comment = String(req.body?.comment || "").trim().slice(0, 2000);

  if(!Number.isFinite(rating) || rating < 1 || rating > 5){
    return res.status(400).json({ error:"invalid_rating" });
  }

  const g = await get("SELECT id FROM games WHERE project=? AND is_hidden=0", [project]);
  if(!g) return res.status(404).json({ error:"game_not_found" });

  const now = Date.now();

  await run(
    `INSERT INTO game_reviews(game_id,user_id,rating,comment,created_at,updated_at)
     VALUES(?,?,?,?,?,?)
     ON CONFLICT(game_id,user_id) DO UPDATE SET
       rating=excluded.rating,
       comment=excluded.comment,
       updated_at=excluded.updated_at`,
    [g.id, req.user.uid, rating, comment || null, now, now]
  );

  res.json({ ok:true });
});
