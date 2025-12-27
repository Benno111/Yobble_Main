import express from "express";
import { requireAuth } from "../auth.js";

export const launcherRouter = express.Router();

/* POST /api/launcher/token  (stub)
   You’ll implement token table handshake later.
*/
launcherRouter.post("/token", requireAuth, async (_req, res) => {
  // Return placeholder so callers don’t break
  res.json({ ok: false, error: "not_implemented" });
});

/* POST /api/launcher/verify (stub) */
launcherRouter.post("/verify", async (_req, res) => {
  res.json({ ok: false, error: "not_implemented" });
});

