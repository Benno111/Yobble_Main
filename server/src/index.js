import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { initDb, get } from "./db.js";

// ⭐ Single import for all routers
import {
  authRouter,
  gamesRouter,
  notificationsRouter,
  reviewsRouter,
  profileRouter,
  reportsRouter,
  gameHostingRouter,
  friendsRouter,
  inventoryRouter,
  marketRouter,
  walletRouter,
  moderationRouter,
  itemsRouter,
  statsRouter
} from "./routes/_routers.js";

/* -----------------------------
   PATH SETUP
----------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "../..");
const WEB_DIR = path.join(PROJECT_ROOT, "web");
const GAME_STORAGE_DIR = path.join(PROJECT_ROOT, "game_storage");

function listFilesRecursive(baseDir, sub = "") {
  const abs = path.join(baseDir, sub);
  let out = [];

  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "assets.json") continue;

    const rel = path.join(sub, e.name);
    const full = path.join(baseDir, rel);

    if (e.isDirectory()) {
      out.push(...listFilesRecursive(baseDir, rel));
    } else {
      const stat = fs.statSync(full);
      out.push({
        path: rel.replace(/\\/g, "/"),
        size: stat.size
      });
    }
  }
  return out;
}

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "8mb" }));

/* -----------------------------
   API MOUNTING (ONE PLACE)
----------------------------- */
app.use("/api/auth", authRouter);
app.use("/api/games", gamesRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/profile", profileRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/gamehosting", gameHostingRouter);

app.use("/api/friends", friendsRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/market", marketRouter);
app.use("/api/wallet", walletRouter);
app.use("/api/mod", moderationRouter);
app.use("/api/items", itemsRouter);
app.use("/api/stats", statsRouter);

/* -----------------------------
   GAME LANDING PAGE
----------------------------- */
app.get("/games/:slug", (req, res, next) => {
  if (req.path.split("/").length !== 3) return next();
  res.sendFile(path.join(WEB_DIR, "game.html"));
});

/* -----------------------------
   RAW GAME FILES
----------------------------- */
app.use("/games/:slug", async (req, res, next) => {
  const slug = String(req.params.slug || "").trim();
  if (!slug) return res.sendStatus(404);
  try {
    const row = await get("SELECT is_hidden FROM games WHERE slug=?", [slug]);
    if (!row || row.is_hidden) return res.sendStatus(404);
  } catch {
    return res.sendStatus(500);
  }
  next();
});

app.get("/games/:slug/:version/assets.json", async (req, res) => {
  const { slug, version } = req.params;
  if (!slug || !version) return res.sendStatus(400);

  try {
    const row = await get("SELECT is_hidden FROM games WHERE slug=?", [slug]);
    if (!row || row.is_hidden) return res.sendStatus(404);
  } catch {
    return res.sendStatus(500);
  }

  const dir = path.join(GAME_STORAGE_DIR, slug, version);
  if (!fs.existsSync(dir)) return res.sendStatus(404);

  res.setHeader("Cache-Control", "public, max-age=60");
  const assets = listFilesRecursive(dir);
  const fileMap = {};
  for (const entry of assets) {
    fileMap[entry.path] = { size: entry.size };
  }
  res.json({ [version]: fileMap });
});

app.use("/games", express.static(GAME_STORAGE_DIR, {
  extensions: ["html"]
}));

/* -----------------------------
   WEB UI
----------------------------- */
app.use("/", express.static(WEB_DIR, { extensions: ["html"] }));

app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(WEB_DIR, "assets", "favicon.ico"));
});

app.get("/:page", (req, res, next) => {
  const p = String(req.params.page || "");
  if (p.includes(".") || p.includes("/")) return next();
  res.sendFile(path.join(WEB_DIR, p + ".html"), err => {
    if (err) next();
  });
});

/* -----------------------------
   START
----------------------------- */
await initDb();

const PORT = Number(process.env.PORT || 5050);
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
