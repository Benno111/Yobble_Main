import { app, BrowserWindow, ipcMain, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const BASE_URL = (process.env.YOBBLE_LIVE_URL || process.env.YOBBLE_BASE_URL || "http://photography-cage.gl.at.ply.gg:52426/").replace(/\/$/, "");
const APP_NAME = "Yobble";
const windows = new Set();
const OFFLINE_ROOT = () => path.join(app.getPath("userData"), "offline-games");

app.setName(APP_NAME);
app.setAppUserModelId(APP_NAME);

function findExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveAppIconPath() {
  const appPath = app.getAppPath();
  return findExistingPath([
    path.join(appPath, "..", "server", "icon.ico"),
    path.join(appPath, "..", "icon.ico"),
    path.join(appPath, "server", "icon.ico")
  ]);
}

function isInternalUrl(url) {
  return url.startsWith("/") || url.startsWith(BASE_URL);
}

function safeSegment(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value || "").trim()).replace(/%2F/gi, "/");
}

function resolveUrl(target) {
  if (!target) {
    return new URL("/index", BASE_URL).toString();
  }
  if (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("file://") ||
    target.startsWith("data:")
  ) {
    return target;
  }
  return new URL(target, BASE_URL).toString();
}

function parseGameTarget(target) {
  try {
    const parsed = new URL(resolveUrl(target));
    if (parsed.pathname !== "/play" && !parsed.pathname.startsWith("/play/")) {
      return null;
    }
    const project = parsed.searchParams.get("project");
    const version = parsed.searchParams.get("version");
    const entry = parsed.searchParams.get("entry") || "index";
    if (!project || !version) return null;
    return { project, version, entry, url: parsed.toString() };
  } catch {
    return null;
  }
}

function getOfflineVersionDir(project, version) {
  return path.join(OFFLINE_ROOT(), safeSegment(project), safeSegment(version));
}

function getOfflineMarkerPath(project, version) {
  return path.join(getOfflineVersionDir(project, version), ".complete");
}

function resolveOfflineEntryPath(project, version, entry) {
  const versionDir = getOfflineVersionDir(project, version);
  const marker = getOfflineMarkerPath(project, version);
  if (!fs.existsSync(marker)) {
    return null;
  }
  const normalized = String(entry || "index").replace(/^\/+/, "");
  const candidates = [
    normalized,
    normalized.endsWith(".html") ? normalized : `${normalized}.html`,
    path.join(normalized, "index.html")
  ];
  for (const candidate of candidates) {
    const filePath = path.join(versionDir, candidate);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(versionDir) + path.sep) && resolved !== path.resolve(versionDir)) {
      continue;
    }
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }
  return null;
}

function countOfflineFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".complete") continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += countOfflineFiles(entryPath);
    } else if (entry.isFile()) {
      total += 1;
    }
  }
  return total;
}

function findOfflineEntry(dir) {
  const preferred = ["index.html", "index.htm"];
  for (const candidate of preferred) {
    if (fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isFile() && /\.html?$/i.test(entry.name)) return entry.name;
    if (entry.isDirectory()) {
      const nested = findOfflineEntry(entryPath);
      if (nested) return path.posix.join(entry.name, nested.replace(/\\/g, "/"));
    }
  }
  return "index";
}

function listOfflineGames() {
  const root = OFFLINE_ROOT();
  if (!fs.existsSync(root)) return [];
  const games = [];
  for (const projectEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(root, projectEntry.name);
    for (const versionEntry of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!versionEntry.isDirectory()) continue;
      const versionDir = path.join(projectDir, versionEntry.name);
      const marker = path.join(versionDir, ".complete");
      if (!fs.existsSync(marker)) continue;
      games.push({
        project: projectEntry.name,
        version: versionEntry.name,
        entry: findOfflineEntry(versionDir),
        cachedAt: Number(fs.readFileSync(marker, "utf8")) || 0,
        files: countOfflineFiles(versionDir)
      });
    }
  }
  return games.sort((a, b) => b.cachedAt - a.cachedAt);
}

function buildOfflineFileUrl(project, version, entry) {
  const filePath = resolveOfflineEntryPath(project, version, entry);
  return filePath ? pathToFileURL(filePath).toString() : null;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function ensureOfflineGameFiles(project, version) {
  const versionDir = getOfflineVersionDir(project, version);
  const manifestUrl = new URL(
    `/games/${encodePathSegment(project)}/${encodePathSegment(version)}/assets.json`,
    BASE_URL
  ).toString();
  const manifest = await fetchJson(manifestUrl);
  const versionFiles = manifest?.[version];
  if (!versionFiles || typeof versionFiles !== "object") {
    throw new Error("assets manifest was empty");
  }
  fs.mkdirSync(versionDir, { recursive: true });
  const entries = Object.keys(versionFiles);
  for (const relPath of entries) {
    const targetPath = path.join(versionDir, relPath);
    const resolvedTarget = path.resolve(targetPath);
    const resolvedRoot = path.resolve(versionDir);
    if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
      continue;
    }
    fs.mkdirSync(path.dirname(resolvedTarget), { recursive: true });
    const fileUrl = new URL(
      `/games/${encodePathSegment(project)}/${encodePathSegment(version)}/${relPath.split("/").map(encodeURIComponent).join("/")}`,
      BASE_URL
    ).toString();
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download ${relPath}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(resolvedTarget, buffer);
  }
  fs.writeFileSync(getOfflineMarkerPath(project, version), String(Date.now()));
  return versionDir;
}

function warmOfflineGame(target) {
  const parsed = parseGameTarget(target);
  if (!parsed) return;
  const existing = resolveOfflineEntryPath(parsed.project, parsed.version, parsed.entry);
  if (existing) return;
  ensureOfflineGameFiles(parsed.project, parsed.version).catch(() => {});
}

function loadOfflineFallback(win, target) {
  const parsed = parseGameTarget(target);
  if (!parsed) return false;
  const offlineUrl = buildOfflineFileUrl(parsed.project, parsed.version, parsed.entry);
  if (!offlineUrl) return false;
  win.loadURL(offlineUrl);
  return true;
}

function loadErrorPage(win, title, message, retryUrl) {
  const safeTitle = String(title || "Unable to load app");
  const safeMessage = String(message || "Please check your connection and try again.");
  const retryTarget = String(retryUrl || BASE_URL);
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${safeTitle.replace(/[&<>"]/g, "")}</title>
        <style>
          :root{color-scheme:dark}
          *{box-sizing:border-box}
          html,body{margin:0;min-height:100%;background:linear-gradient(180deg,#0b1020,#111827);color:#e5e7eb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
          main{min-height:100vh;display:grid;place-items:center;padding:24px}
          .card{max-width:680px;width:100%;background:rgba(15,23,42,.86);border:1px solid rgba(148,163,184,.2);border-radius:20px;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.35)}
          h1{margin:0 0 10px;font-size:28px}
          p{margin:0 0 16px;line-height:1.5;color:#cbd5e1}
          .actions{display:flex;gap:10px;flex-wrap:wrap}
          button,a{appearance:none;border:1px solid rgba(148,163,184,.24);background:#0f172a;color:#f8fafc;border-radius:12px;padding:10px 14px;font:inherit;cursor:pointer;text-decoration:none}
          button.primary{background:#2563eb;border-color:#2563eb}
        </style>
      </head>
      <body>
        <main>
          <section class="card">
            <h1>${safeTitle}</h1>
            <p>${safeMessage}</p>
            <div class="actions">
              <button class="primary" onclick='location.href=${JSON.stringify(retryTarget)}'>Retry</button>
              <a href="${BASE_URL}/index">Home</a>
            </div>
          </section>
        </main>
      </body>
    </html>
  `;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function createWindow(target = "/index") {
  const resolvedTarget = resolveUrl(target);
  const iconPath = resolveAppIconPath();
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#11161f",
    title: APP_NAME,
    frame: false,
    icon: iconPath,
    webPreferences: {
      preload: path.join(app.getAppPath(), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.removeMenu();
  windows.add(win);
  win.on("closed", () => windows.delete(win));
  win.__offlineFallbackAttempted = false;

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) {
      createWindow(url);
      return { action: "deny" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("did-fail-load", (_event, _errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    const url = validatedURL || resolvedTarget;
    if (!win.__offlineFallbackAttempted && loadOfflineFallback(win, url)) {
      win.__offlineFallbackAttempted = true;
      return;
    }
    loadErrorPage(win, "Yobble could not load", errorDescription || "The app could not reach the server.", url);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    loadErrorPage(
      win,
      "Yobble stopped responding",
      details?.reason === "crashed"
        ? "The page crashed while loading."
        : "The renderer process exited unexpectedly.",
      resolvedTarget
    );
  });

  warmOfflineGame(resolvedTarget);

  win.loadURL(resolvedTarget).catch(() => {
    if (!win.__offlineFallbackAttempted && loadOfflineFallback(win, resolvedTarget)) {
      win.__offlineFallbackAttempted = true;
      return;
    }
    loadErrorPage(win, "Yobble could not load", "The app could not reach the server.", resolvedTarget);
  });
  return win;
}

ipcMain.handle("open-game", async (_event, targetUrl) => {
  createWindow(targetUrl);
  return true;
});

ipcMain.handle("open-external", async (_event, targetUrl) => {
  await shell.openExternal(targetUrl);
  return true;
});

ipcMain.handle("cache-game-offline", async (_event, payload) => {
  const project = payload?.project;
  const version = payload?.version;
  if (!project || !version) {
    throw new Error("missing_project_or_version");
  }
  const versionDir = await ensureOfflineGameFiles(project, version);
  const files = countOfflineFiles(versionDir);
  return { ok: true, files };
});

ipcMain.handle("has-offline-game", (_event, payload) => {
  const project = payload?.project;
  const version = payload?.version;
  const entry = payload?.entry || "index";
  if (!project || !version) return false;
  return !!resolveOfflineEntryPath(project, version, entry);
});

ipcMain.handle("list-offline-games", () => listOfflineGames());

ipcMain.handle("window-minimize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
  return true;
});

ipcMain.handle("window-toggle-maximize", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  if (win.isMaximized()) {
    win.unmaximize();
  } else {
    win.maximize();
  }
  return true;
});

ipcMain.handle("window-toggle-fullscreen", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return false;
  win.setFullScreen(!win.isFullScreen());
  return true;
});

ipcMain.handle("window-is-fullscreen", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return !!win?.isFullScreen();
});

ipcMain.handle("window-close", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
  return true;
});

app.whenReady().then(() => {
  createWindow("/index");
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow("/index");
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
