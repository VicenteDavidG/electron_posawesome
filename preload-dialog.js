const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("leafUnexpectedClose", {
  getData: () => ipcRenderer.invoke("leaf:unexpected-close-data"),
  retryPrint: () => ipcRenderer.invoke("leaf:unexpected-close-retry-print"),
  acknowledge: () => ipcRenderer.invoke("leaf:unexpected-close-ack"),
});
