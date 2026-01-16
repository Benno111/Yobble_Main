import express from "express";
import { all } from "../db.js";

export const changelogRouter = express.Router();

changelogRouter.get("/", async (_req, res) => {
  try {
    const rows = await all(
      `SELECT id, title, body, created_at, created_by
       FROM changelog_entries
       ORDER BY created_at DESC, id DESC`
    );
    res.json({ entries: rows });
  } catch (err) {
    console.error("changelog list error", err);
    res.status(500).json({ error: "server_error" });
  }
});
