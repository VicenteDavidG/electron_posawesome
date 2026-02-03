const { contextBridge, ipcRenderer, webFrame } = require("electron");

// Inyectar CSS para asegurar persistencia de la barra
window.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.innerHTML = `
    #pos-shortcuts-bar {
      position: fixed !important;
      top: 0 !important;
      z-index: 2147483647 !important; /* Max signed 32-bit integer */
      display: flex !important;
      visibility: visible !important;
      transform: none !important; /* Evitar transformaciones que creen nuevos contextos de apilamiento */
    }
  `;
  document.head.appendChild(style);
});

contextBridge.exposeInMainWorld("asteroid", {
  onKeyEvent: (callback) => {
    ipcRenderer.on("tecla-eliminar-producto", () =>
      callback("tecla-eliminar-producto")
    ); // F4 → Ctrl+D
    ipcRenderer.on("tecla-totalizar", () => callback("tecla-totalizar")); // F10 → Ctrl+S
    ipcRenderer.on("tecla-cancelar-factura", () =>
      callback("tecla-cancelar-factura")
    ); // F3 → Ctrl+K
    ipcRenderer.on("tecla-cambiar-cantidad", () =>
      callback("tecla-cambiar-cantidad")
    ); // F5 → Ctrl+Shift+A
    ipcRenderer.on("tecla-aceptar-factura", () =>
      callback("tecla-aceptar-factura")
    ); //
    ipcRenderer.on("tecla-manejo-efectivo", () =>
      callback("tecla-manejo-efectivo")
    ); //
    ipcRenderer.on("tecla-validar-factura", () =>
      callback("tecla-validar-factura")
    ); // F8 → Ctrl+X
    ipcRenderer.on("tecla-validar-imprimir", () =>
      callback("tecla-validar-imprimir")
    ); // F9 → Ctrl+A
  },

  guardarConfig: (config) => {
    ipcRenderer.send("guardar-config", config);
  },

  // NUEVO: imprimir desde URL (printview) sin diálogo
  printUrl: (payload) => ipcRenderer.invoke("leaf:print-url", payload),

  // NUEVO: Prevenir cierre
  onCheckCartStatus: (callback) =>
    ipcRenderer.on("check-cart-status", () => callback()),
  sendCartStatusResponse: (canClose) =>
    ipcRenderer.send("cart-status-response", canClose),
});
