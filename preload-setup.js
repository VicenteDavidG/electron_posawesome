const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("leafSetup", {
  testUrl: (url) => ipcRenderer.invoke("leaf:test-url", url),
  saveConfig: (payload) => ipcRenderer.invoke("leaf:save-config", payload),
});
