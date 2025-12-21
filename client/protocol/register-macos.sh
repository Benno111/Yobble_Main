#!/usr/bin/env bash
set -euo pipefail

PROTO_NAME="${1:-benno111engene}"
APP_DIR="$(cd "$(dirname "$0")"/.. && pwd)"
LAUNCHER="$APP_DIR/launchgame.sh"
APP_BUNDLE="$HOME/Applications/benno111engene-protocol.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
PLIST="$CONTENTS/Info.plist"

mkdir -p "$MACOS" "$RESOURCES"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>benno111engene-protocol</string>
  <key>CFBundleIdentifier</key><string>com.benno111engene.protocol</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>$PROTO_NAME</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
EOF

cat > "$MACOS/launcher" <<EOF
#!/usr/bin/env bash
set -euo pipefail
URL="\${1:-}"
if [ -z "\$URL" ]; then exit 0; fi
SLUG="\$(echo "\$URL" | sed -E "s|^$PROTO_NAME://||" | cut -d'?' -f1 | cut -d'/' -f1)"
VER="\$(echo "\$URL" | sed -E "s|^$PROTO_NAME://||" | cut -d'?' -f1 | cut -d'/' -f2)"
exec "$LAUNCHER" "\$SLUG" "\$VER"
EOF
chmod +x "$MACOS/launcher"

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP_BUNDLE" >/dev/null 2>&1 || true

echo "Registered $PROTO_NAME:// for current user."
