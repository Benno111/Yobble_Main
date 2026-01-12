import express from "express";
import { all, get, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { nowMs } from "../util.js";

export const gameEditorRouter = express.Router();

function defaultGameFormat() {
  return {
    format_version: 1,
    meta: {
      title: "Untitled 3D Game",
      description: "",
      tags: [],
      created_at: nowMs()
    },
    scene: {
      entities: [],
      systems: [],
      settings: {
        gravity: [0, -9.81, 0],
        units: "meter",
        ambient: "#0b0f14"
      }
    },
    assets: {
      meshes: [],
      materials: [],
      textures: [],
      audio: []
    },
    scripts: []
  };
}

function normalizePayload(body) {
  const name = String(body?.name || "Untitled Project").trim() || "Untitled Project";
  let data = body?.data;
  if (!data) data = defaultGameFormat();
  if (typeof data !== "string") {
    data = JSON.stringify(data);
  }
  return { name, data };
}

gameEditorRouter.get("/format", requireAuth, (req, res) => {
  res.json({ format: defaultGameFormat() });
});

gameEditorRouter.get("/projects", requireAuth, async (req, res) => {
  const rows = await all(
    `SELECT id, name, created_at, updated_at
     FROM game_editor_projects
     WHERE user_id=?
     ORDER BY updated_at DESC`,
    [req.user.uid]
  );
  res.json({ projects: rows });
});

gameEditorRouter.get("/projects/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_request" });
  const row = await get(
    `SELECT id, name, data, created_at, updated_at
     FROM game_editor_projects
     WHERE user_id=? AND id=?`,
    [req.user.uid, id]
  );
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json({ project: row });
});

gameEditorRouter.post("/projects", requireAuth, async (req, res) => {
  const payload = normalizePayload(req.body);
  const createdAt = nowMs();
  const result = await run(
    `INSERT INTO game_editor_projects (user_id, name, data, created_at, updated_at)
     VALUES (?,?,?,?,?)`,
    [req.user.uid, payload.name, payload.data, createdAt, createdAt]
  );
  res.json({
    project: {
      id: result.lastID,
      name: payload.name,
      data: payload.data,
      created_at: createdAt,
      updated_at: createdAt
    }
  });
});

gameEditorRouter.put("/projects/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_request" });
  const existing = await get(
    `SELECT id FROM game_editor_projects WHERE user_id=? AND id=?`,
    [req.user.uid, id]
  );
  if (!existing) return res.status(404).json({ error: "not_found" });

  const payload = normalizePayload(req.body);
  const updatedAt = nowMs();
  await run(
    `UPDATE game_editor_projects
     SET name=?, data=?, updated_at=?
     WHERE user_id=? AND id=?`,
    [payload.name, payload.data, updatedAt, req.user.uid, id]
  );
  res.json({
    project: {
      id,
      name: payload.name,
      data: payload.data,
      updated_at: updatedAt
    }
  });
});

gameEditorRouter.delete("/projects/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "bad_request" });
  await run(
    `DELETE FROM game_editor_projects WHERE user_id=? AND id=?`,
    [req.user.uid, id]
  );
  res.json({ ok: true });
});
