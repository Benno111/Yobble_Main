import express from "express";
import { requireAuth } from "../auth.js";
import { all, get, run } from "../db.js";

export const statsRouter = express.Router();

/* GET /api/stats/me */
statsRouter.get("/me", requireAuth, async (req, res) => {
  const rows = await all(
    `SELECT g.project, g.title, p.playtime_ms, p.sessions, p.last_played
     FROM game_playtime p
     JOIN games g ON g.id = p.game_id
     WHERE p.user_id=?
     ORDER BY p.playtime_ms DESC`,
    [req.user.uid]
  );
  res.json(rows);
});

/* POST /api/stats/ping { project, ms }  (simple playtime bump) */
statsRouter.post("/ping", requireAuth, async (req, res) => {
  const { project, ms } = req.body || {};
  const add = Number(ms || 0);
  if (!project || !Number.isFinite(add) || add <= 0) return res.status(400).json({ error: "bad_request" });

  const g = await get("SELECT id FROM games WHERE project=?", [project]);
  if (!g) return res.status(404).json({ error: "game_not_found" });

  const now = Date.now();
  await run(
    `INSERT INTO game_playtime(user_id, game_id, playtime_ms, sessions, last_played)
     VALUES(?,?,?,?,?)
     ON CONFLICT(user_id, game_id)
     DO UPDATE SET
       playtime_ms = playtime_ms + excluded.playtime_ms,
       sessions = sessions + 1,
       last_played = excluded.last_played`,
    [req.user.uid, g.id, add, 1, now]
  );

  res.json({ ok: true });
});

