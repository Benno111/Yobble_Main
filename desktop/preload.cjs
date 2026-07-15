const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electron", {
  openGame: (targetUrl) => ipcRenderer.invoke("open-game", targetUrl),
  openExternal: (targetUrl) => ipcRenderer.invoke("open-external", targetUrl),
  cacheGameOffline: (project, version) => ipcRenderer.invoke("cache-game-offline", { project, version }),
  hasOfflineGame: (project, version, entry) => ipcRenderer.invoke("has-offline-game", { project, version, entry }),
  listOfflineGames: () => ipcRenderer.invoke("list-offline-games"),
  windowMinimize: () => ipcRenderer.invoke("window-minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window-toggle-maximize"),
  windowToggleFullscreen: () => ipcRenderer.invoke("window-toggle-fullscreen"),
  windowIsFullscreen: () => ipcRenderer.invoke("window-is-fullscreen"),
  windowClose: () => ipcRenderer.invoke("window-close")
});
