import express from "express";
import { all, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { nowMs } from "../util.js";

export const storageRouter = express.Router();

storageRouter.get("/:slug/:version", requireAuth, async (req, res) => {
  const slug = String(req.params.slug || "").trim();
  const version = String(req.params.version || "").trim();
  if (!slug || !version) return res.status(400).json({ error: "bad_request" });

  const rows = await all(
    `SELECT key, value
     FROM game_kv
     WHERE user_id=? AND slug=? AND version=?`,
    [req.user.uid, slug, version]
  );
  const data = {};
  for (const row of rows) {
    data[row.key] = row.value;
  }
  res.json({ data });
});

storageRouter.post("/:slug/:version", requireAuth, async (req, res) => {
  const slug = String(req.params.slug || "").trim();
  const version = String(req.params.version || "").trim();
  const key = String(req.body?.key || "");
  const value = req.body?.value ?? null;
  if (!slug || !version || !key) return res.status(400).json({ error: "bad_request" });

  await run(
    `INSERT INTO game_kv (user_id, slug, version, key, value, updated_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id, slug, version, key)
     DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [req.user.uid, slug, version, key, String(value), nowMs()]
  );
  res.json({ ok: true });
});

storageRouter.delete("/:slug/:version", requireAuth, async (req, res) => {
  const slug = String(req.params.slug || "").trim();
  const version = String(req.params.version || "").trim();
  if (!slug || !version) return res.status(400).json({ error: "bad_request" });

  await run(
    `DELETE FROM game_kv WHERE user_id=? AND slug=? AND version=?`,
    [req.user.uid, slug, version]
  );
  res.json({ ok: true });
});

storageRouter.delete("/:slug/:version/:key", requireAuth, async (req, res) => {
  const slug = String(req.params.slug || "").trim();
  const version = String(req.params.version || "").trim();
  const key = String(req.params.key || "");
  if (!slug || !version || !key) return res.status(400).json({ error: "bad_request" });

  await run(
    `DELETE FROM game_kv WHERE user_id=? AND slug=? AND version=? AND key=?`,
    [req.user.uid, slug, version, key]
  );
  res.json({ ok: true });
});
