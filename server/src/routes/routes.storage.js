import express from "express";
import { all, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { nowMs } from "../util.js";

export const storageRouter = express.Router();

storageRouter.get("/:project/:version", requireAuth, async (req, res) => {
  const project = String(req.params.project || "").trim();
  const version = String(req.params.version || "").trim();
  if (!project || !version) return res.status(400).json({ error: "bad_request" });

  const rows = await all(
    `SELECT key, value
     FROM game_kv
     WHERE user_id=? AND project=? AND version=?`,
    [req.user.uid, project, version]
  );
  const data = {};
  for (const row of rows) {
    data[row.key] = row.value;
  }
  res.json({ data });
});

storageRouter.post("/:project/:version", requireAuth, async (req, res) => {
  const project = String(req.params.project || "").trim();
  const version = String(req.params.version || "").trim();
  const key = String(req.body?.key || "");
  const value = req.body?.value ?? null;
  if (!project || !version || !key) return res.status(400).json({ error: "bad_request" });

  await run(
    `INSERT INTO game_kv (user_id, project, version, key, value, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id, project, version, key)
     DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [req.user.uid, project, version, key, String(value), nowMs()]
  );
  res.json({ ok: true });
});

storageRouter.delete("/:project/:version", requireAuth, async (req, res) => {
  const project = String(req.params.project || "").trim();
  const version = String(req.params.version || "").trim();
  if (!project || !version) return res.status(400).json({ error: "bad_request" });

  await run(
    `DELETE FROM game_kv WHERE user_id=? AND project=? AND version=?`,
    [req.user.uid, project, version]
  );
  res.json({ ok: true });
});

storageRouter.delete("/:project/:version/:key", requireAuth, async (req, res) => {
  const project = String(req.params.project || "").trim();
  const version = String(req.params.version || "").trim();
  const key = String(req.params.key || "");
  if (!project || !version || !key) return res.status(400).json({ error: "bad_request" });

  await run(
    `DELETE FROM game_kv WHERE user_id=? AND project=? AND version=? AND key=?`,
    [req.user.uid, project, version, key]
  );
  res.json({ ok: true });
});
