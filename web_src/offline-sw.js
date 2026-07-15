const GAME_CACHE_PREFIX = "yobble-offline-game-v1:";
const SHELL_CACHE = "yobble-offline-shell-v1";

function cachePart(value) {
  return encodeURIComponent(String(value || ""));
}

function gameCacheName(project, version) {
  return `${GAME_CACHE_PREFIX}${cachePart(project)}:${cachePart(version)}`;
}

function parseGameUrl(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "games" || parts.length < 3) return null;
  return {
    project: decodeURIComponent(parts[1]),
    version: decodeURIComponent(parts[2])
  };
}

async function networkFirst(request, cacheName, fallbackUrl = "") {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok && request.method === "GET") {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallbackUrl) {
      const fallback = await cache.match(fallbackUrl);
      if (fallback) return fallback;
    }
    throw new Error("offline_miss");
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const game = parseGameUrl(url);
  if (game) {
    event.respondWith(networkFirst(request, gameCacheName(game.project, game.version)));
    return;
  }

  if (
    url.pathname === "/play" ||
    url.pathname === "/theme.css" ||
    url.pathname === "/style.css" ||
    url.pathname.startsWith("/js/")
  ) {
    event.respondWith(networkFirst(request, SHELL_CACHE, url.pathname === "/play" ? "/play" : ""));
  }
});
