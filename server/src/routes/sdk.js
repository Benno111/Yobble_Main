import express from "express";
import { verifyToken } from "../auth.js";
import { get } from "../db.js";

export const sdkRouter = express.Router();

function readAuthUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;
  try {
    return verifyToken(token);
  } catch {
    return null;
  }
}

sdkRouter.get("/multiplayer", (req, res) => {
  const decoded = readAuthUser(req);
  res.json({
    enabled: true,
    provider: "photon",
    userId: decoded?.uid || null,
    username: decoded?.username || null
  });
});

sdkRouter.post("/multiplayer", (req, res) => {
  res.json({ ok: true });
});

sdkRouter.get("/player/stats", async (req, res) => {
  const decoded = readAuthUser(req);
  if (!decoded?.uid) return res.json({ ok: false, error: "not_authenticated" });
  const row = await get(
    `SELECT playtime_seconds, matches_played, wins
     FROM stats WHERE user_id=?`,
    [decoded.uid]
  );
  res.json({
    ok: true,
    stats: row || { playtime_seconds: 0, matches_played: 0, wins: 0 }
  });
});
