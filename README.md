# Yobble

Yobble is a game publishing platform with a web UI, API server, and desktop clients (AppImage/Windows builds). The server hosts game uploads, user accounts, moderation tools, and marketplace features, while the web frontend ships from `web_src/` and is minified into `temp/web-runtime/` at startup.

## Features
- Game hosting with versioned assets and access controls
- User accounts, profiles, reviews, notifications, and chat
- Moderation, reports, appeals, and support tooling
- Marketplace, inventory, and wallet flows
- Web IDE and 3D studio integration

## Project layout
- `server/src` API server and websocket chat
- `web_src` web frontend source (served/minified at runtime)
- `temp/web-runtime` generated web runtime output
- `game_storage` uploaded game builds
- `save` data assets (TOS, item icons, levels)
- `Client_linux` packaged Linux client assets
- `Client_win` packaged Windows client assets
- `scripts` helper scripts (AppImage build)

## Quick start (server)
1) Install dependencies

```sh
npm --prefix server install
```

2) Start the server

```sh
npm --prefix server start
```

By default the server listens on `PORT=5050` and optionally `PORT2=3000`. If TLS certs exist at `Benno111 Chat/cert.pem` and `Benno111 Chat/key.pem`, HTTPS starts on `HTTPS_PORT=5443`.

## Configuration
Environment variables used by the server:
- `PORT` primary HTTP port (default: `5050`)
- `PORT2` secondary HTTP port (default: `3000`)
- `HTTPS_PORT` HTTPS port (default: `5443`)

## AppImage build (Linux)
The AppImage build pulls from `Client_linux/` and produces `dist/Yobble.appimage`.

```sh
scripts/build-appimage.sh 0.7.0
```

## Data locations
- Uploaded games: `game_storage/`
- Uploaded items/icons: `save/item_icons/`
- TOS content: `save/tos`
- Custom levels: `save/custom_levels/`

## Notes
- The server minifies `web_src/` into `temp/web-runtime/` on startup.
- A legacy entrypoint exists at `index.js` in the repo root; current server entrypoint is `server/src/index.js`.
