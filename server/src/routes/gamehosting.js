import express from "express";
import { requireAuth } from "../auth.js";

export const gameHostingRouter = express.Router();

/* POST /api/gamehosting/publish (stub) */
gameHostingRouter.post("/publish", requireAuth, async (_req, res) => {
  res.json({ ok: false, error: "not_implemented" });
});

