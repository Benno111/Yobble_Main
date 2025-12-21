#!/usr/bin/env bash
set -euo pipefail

PROTO_NAME="${1:-benno111engene}"
APP_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
LAUNCHER="$APP_DIR/launchgame2.sh"
DESKTOP_FILE="$HOME/.local/share/applications/${PROTO_NAME}.desktop"

mkdir -p "$HOME/.local/share/applications"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=benno111engene Launcher
Exec=$LAUNCHER %u
Type=Application
Terminal=true
MimeType=x-scheme-handler/$PROTO_NAME;
NoDisplay=true
EOF

xdg-mime default "$(basename "$DESKTOP_FILE")" "x-scheme-handler/$PROTO_NAME"
update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true

echo "Registered $PROTO_NAME:// for current user."
