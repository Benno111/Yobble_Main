import express from "express";
import { requireAuth } from "../auth.js";
import { all, get, run } from "../db.js";

export const friendsRouter = express.Router();

/* -----------------------------
   GET /api/friends
----------------------------- */
friendsRouter.get("/", requireAuth, async (req, res) => {
  const rows = await all(
    `SELECT u.id, u.username, f.status
     FROM friends f
     JOIN users u ON u.id = f.friend_id
     WHERE f.user_id=?`,
    [req.user.uid]
  );
  res.json(rows);
});

/* -----------------------------
   POST /api/friends/request
----------------------------- */
friendsRouter.post("/request", requireAuth, async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: "missing_username" });

  const target = await get("SELECT id FROM users WHERE username=?", [username]);
  if (!target) return res.status(404).json({ error: "user_not_found" });

  if (target.id === req.user.uid) {
    return res.status(400).json({ error: "cannot_friend_self" });
  }

  await run(
    "INSERT OR IGNORE INTO friends(user_id,friend_id,status,created_at) VALUES(?,?,?,?)",
    [req.user.uid, target.id, "pending", Date.now()]
  );

  res.json({ ok: true });
});

/* -----------------------------
   POST /api/friends/accept
----------------------------- */
friendsRouter.post("/accept", requireAuth, async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "missing_userId" });

  await run(
    "UPDATE friends SET status='accepted' WHERE user_id=? AND friend_id=?",
    [userId, req.user.uid]
  );

  // reciprocal row
  await run(
    "INSERT OR IGNORE INTO friends(user_id,friend_id,status,created_at) VALUES(?,?,?,?)",
    [req.user.uid, userId, "accepted", Date.now()]
  );

  res.json({ ok: true });
});

/* -----------------------------
   POST /api/friends/remove
----------------------------- */
friendsRouter.post("/remove", requireAuth, async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "missing_userId" });

  await run(
    "DELETE FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)",
    [req.user.uid, userId, userId, req.user.uid]
  );

  res.json({ ok: true });
});

