#!/usr/bin/env bash
set -euo pipefail

URL="${1:-}"
if [ -z "$URL" ]; then
  echo "Usage: ./launchgame2.sh benno111engene://<slug>/<version>"
  exit 1
fi

URL="${URL#benno111engene://}"
SLUG="${URL%%/*}"
REST="${URL#*/}"
VER="${REST%%\?*}"

if [ -z "$SLUG" ] || [ -z "$VER" ]; then
  echo "Invalid URL. Expected benno111engene://<slug>/<version>"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "$ROOT/launchgame.sh" "$SLUG" "$VER"
