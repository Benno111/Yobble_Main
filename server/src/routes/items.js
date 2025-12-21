import express from "express";
import { all } from "../db.js";

export const itemsRouter = express.Router();

/* GET /api/items */
itemsRouter.get("/", async (_req, res) => {
  const rows = await all("SELECT id, code, name FROM items ORDER BY id DESC");
  res.json(rows);
});

