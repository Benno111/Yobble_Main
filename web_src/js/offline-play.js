const OFFLINE_INDEX_KEY = "yobble:offline-games";
const OFFLINE_CACHE_PREFIX = "yobble-offline-game-v1:";
const OFFLINE_SHELL_CACHE = "yobble-offline-shell-v1";

function encodeGameSegment(value) {
  return encodeURIComponent(String(value || "").trim()).replace(/%2F/gi, "/");
}

function encodePath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function cacheKey(project, version) {
  return `${OFFLINE_CACHE_PREFIX}${encodeURIComponent(project)}:${encodeURIComponent(version)}`;
}

function readIndex() {
  try {
    const data = JSON.parse(localStorage.getItem(OFFLINE_INDEX_KEY) || "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeIndex(items) {
  localStorage.setItem(OFFLINE_INDEX_KEY, JSON.stringify(items));
}

function normalizeEntry(entry) {
  return String(entry || "index").replace(/\\/g, "/").replace(/^\/+/, "");
}

function entryCandidates(entry) {
  const normalized = normalizeEntry(entry);
  const candidates = [normalized];
  if (!normalized.endsWith(".html")) candidates.push(`${normalized}.html`);
  candidates.push(`${normalized.replace(/\/+$/, "")}/index.html`);
  return Array.from(new Set(candidates.filter(Boolean)));
}

function buildGameAssetUrl(project, version, relPath) {
  return `/games/${encodeGameSegment(project)}/${encodeGameSegment(version)}/${encodePath(relPath)}`;
}

export function getOfflineGames() {
  return readIndex().sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0));
}

export function getOfflineGame(project, version) {
  return getOfflineGames().find((item) => item.project === project && item.version === version) || null;
}

export function buildPlayUrl(project, version, entry) {
  return `/play?project=${encodeURIComponent(project)}&version=${encodeURIComponent(version)}&entry=${encodeURIComponent(normalizeEntry(entry))}`;
}

export async function registerOfflinePlayServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/offline-sw.js");
  } catch {
    return null;
  }
}

async function cacheShellFiles() {
  if (!("caches" in window)) return;
  try {
    const cache = await caches.open(OFFLINE_SHELL_CACHE);
    await Promise.allSettled(
      ["/play", "/theme.css", "/style.css", "/js/pages/play.js", "/js/api.js", "/js/offline-play.js"].map(async (url) => {
        const response = await fetch(url, { credentials: "include" });
        if (response.ok) await cache.put(url, response);
      })
    );
  } catch {}
}

export async function cacheGameForOffline({ project, version, entry = "index", title = "" }) {
  if (!project || !version || !("caches" in window)) {
    return { ok: false, error: "offline_cache_unavailable" };
  }
  await registerOfflinePlayServiceWorker();
  await cacheShellFiles();

  const manifestUrl = `/games/${encodeGameSegment(project)}/${encodeGameSegment(version)}/assets.json`;
  const manifestResponse = await fetch(manifestUrl, {
    credentials: "include",
    cache: "no-store",
    headers: { accept: "application/json" }
  });
  if (!manifestResponse.ok) {
    throw new Error("offline_manifest_unavailable");
  }
  const manifest = await manifestResponse.clone().json();
  const fileMap = manifest?.[version];
  if (!fileMap || typeof fileMap !== "object") {
    throw new Error("offline_manifest_empty");
  }

  const cache = await caches.open(cacheKey(project, version));
  await cache.put(manifestUrl, manifestResponse);
  const files = Object.keys(fileMap);
  for (const relPath of files) {
    const url = buildGameAssetUrl(project, version, relPath);
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`offline_asset_failed:${relPath}`);
    await cache.put(url, response);
  }

  const items = readIndex().filter((item) => !(item.project === project && item.version === version));
  const cachedAt = Date.now();
  items.push({ project, version, entry: normalizeEntry(entry), title, cachedAt, files: files.length });
  writeIndex(items);
  return { ok: true, cachedAt, files: files.length };
}

export async function hasCachedGameEntry(project, version, entry = "index") {
  if (!project || !version || !("caches" in window)) return false;
  try {
    const cache = await caches.open(cacheKey(project, version));
    for (const candidate of entryCandidates(entry)) {
      const match = await cache.match(buildGameAssetUrl(project, version, candidate));
      if (match) return true;
    }
  } catch {}
  return false;
}

