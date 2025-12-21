#!/usr/bin/env bash
set -euo pipefail
clear

# --------------------------------
# ARGS
# --------------------------------
if [ $# -lt 2 ]; then
  echo "Usage: ./launch-game.sh <slug> <version>"
  echo "Got: $*"
  while true; do
    read -p "Press Y to continue or N to exit: " yn
    case $yn in
        [Yy]* ) break;;
        [Nn]* ) exit 1;;
        * ) echo "Please answer Y or N.";;
    esac
  done
fi

SLUG="$1"
VER="$2"

SERVER="http://localhost:5050"
BASE_URL="$SERVER/games/$SLUG/$VER"

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$ROOT/app"
GAME_DIR="$APP_DIR/$SLUG/$VER"
ENTRY="$GAME_DIR/index.html"

mkdir -p "$GAME_DIR"

# --------------------------------
# FETCH ASSETS LIST
# --------------------------------
ASSETS_JSON="$(mktemp)"
echo " $ASSETS_JSON"
echo "$BASE_URL/assets.json"
curl -fsSL "$BASE_URL/assets.json" > "$ASSETS_JSON"

# --------------------------------
# DOWNLOAD / VERIFY FILES
# --------------------------------
node - "$GAME_DIR" "$BASE_URL" "$ASSETS_JSON" <<'NODE'
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const gameDir = process.argv[2];
const baseUrl = process.argv[3];
const assetsFile = process.argv[4];

const raw = fs.readFileSync(assetsFile, "utf8");
const parsed = JSON.parse(raw);
const versionKey = process.argv[3].split("/").pop();
const data = Array.isArray(parsed)
  ? parsed
  : parsed[versionKey] || Object.values(parsed)[0] || [];

let normalized = [];
if (Array.isArray(data)) {
  normalized = data.map(e => (typeof e === "string" ? { path: e } : e));
} else {
  normalized = Object.entries(data).map(([path, meta]) => ({
    path,
    size: meta && typeof meta === "object" ? meta.size : undefined
  }));
}

function download(entry) {
  return new Promise((resolve, reject) => {
    const url = baseUrl + "/" + entry.path;
    const out = path.join(gameDir, entry.path);
    fs.mkdirSync(path.dirname(out), { recursive: true });

    const proto = url.startsWith("https") ? https : http;
    proto.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} ${url}`));
        return;
      }
      const ws = fs.createWriteStream(out);
      res.pipe(ws);
      ws.on("finish", resolve);
      ws.on("error", reject);
    }).on("error", reject);
  });
}

(async () => {
  for (const entry of normalized) {
    const filePath = path.join(gameDir, entry.path);
    let needs = false;

    if (!fs.existsSync(filePath)) {
      console.log("⬇ missing:", entry.path);
      needs = true;
    } else {
      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        console.log("⬇ empty:", entry.path);
        needs = true;
      }
      if (entry.size && stat.size !== entry.size) {
        console.log("⬇ size mismatch:", entry.path);
        needs = true;
      }
    }

    if (needs) {
      await download(entry);
    }
  }
})().catch(e => {
  console.error("Install failed:", e.message);
  process.exit(1);
});
NODE

rm -f "$ASSETS_JSON"

# --------------------------------
# FINAL CHECK
# --------------------------------
if [ ! -f "$ENTRY" ]; then
  echo "❌ index.html missing"
  exit 1
fi

# --------------------------------
# LAUNCH
# --------------------------------
echo "🎮 Launching $SLUG@$VER"
npx electron "$ENTRY" --no-sandbox
