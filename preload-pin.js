const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("leafPinDialog", {
  init: () => ipcRenderer.invoke("leaf:pin-dialog-init"),
  submit: (pin) => ipcRenderer.invoke("leaf:pin-dialog-submit", pin),
  cancel: () => ipcRenderer.send("leaf:pin-dialog-cancel"),
});
