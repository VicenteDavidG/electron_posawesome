const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED_KEY_CHANNELS = [
  "tecla-eliminar-producto",
  "tecla-totalizar",
  "tecla-cancelar-factura",
  "tecla-cambiar-cantidad",
  "tecla-validar-factura",
  "tecla-validar-imprimir",
];

function getAppVersion() {
  const arg = process.argv.find((item) => item.startsWith("--leaf-app-version="));
  return arg ? arg.slice("--leaf-app-version=".length) : "1.0.0";
}

// Keep shortcuts bar visible above POS Awesome UI
window.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent = `
    #pos-shortcuts-bar {
      position: fixed !important;
      top: 0 !important;
      z-index: 2147483647 !important;
      display: flex !important;
      visibility: visible !important;
      transform: none !important;
      opacity: 1 !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  if (!document.body) return;
  const observer = new MutationObserver(() => {
    const bar = document.getElementById("pos-shortcuts-bar");
    if (!bar) return;
    if (bar.style.display === "none") bar.style.display = "flex";
    if (bar.style.visibility === "hidden") bar.style.visibility = "visible";
    if (bar.style.position !== "fixed") bar.style.setProperty("position", "fixed", "important");
    if (bar.style.top !== "0px") bar.style.setProperty("top", "0", "important");
    if (bar.style.zIndex !== "2147483647") bar.style.setProperty("z-index", "2147483647", "important");
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden"],
  });
});

const shellVersion = getAppVersion();

const leafShellApi = {
  version: shellVersion,
  platform: process.platform,
  printUrl: (payload) => ipcRenderer.invoke("leaf:print-url", payload),
  reportSnapshot: (snapshot) => ipcRenderer.send("leaf:report-snapshot", snapshot),
  getContractInfo: () => ({ shellVersion, supportedContract: ["1.0"] }),
};

contextBridge.exposeInMainWorld("leafShell", leafShellApi);

// Temporary compatibility alias for current POS Awesome builds using window.asteroid
contextBridge.exposeInMainWorld("asteroid", {
  onKeyEvent: (callback) => {
    if (typeof callback !== "function") return;
    for (const channel of ALLOWED_KEY_CHANNELS) {
      ipcRenderer.on(channel, () => callback(channel));
    }
  },
  printUrl: leafShellApi.printUrl,
  reportSnapshot: leafShellApi.reportSnapshot,
  getContractInfo: leafShellApi.getContractInfo,
});
