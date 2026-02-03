const { contextBridge, ipcRenderer, webFrame } = require("electron");

// Inyectar CSS para asegurar persistencia de la barra
// Inyectar CSS y asegurar persistencia de la barra con MutationObserver
window.addEventListener("DOMContentLoaded", () => {
  // 1. Estilos base
  const style = document.createElement("style");
  style.innerHTML = `
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
  document.head.appendChild(style);

  // 2. Observador para forzar atributos si algo externo intenta ocultarla
  const observer = new MutationObserver(() => {
    const bar = document.getElementById("pos-shortcuts-bar");
    if (bar) {
      if (bar.style.display === "none") bar.style.display = "flex";
      if (bar.style.visibility === "hidden") bar.style.visibility = "visible";
      // Reforzar posición
      if (bar.style.position !== "fixed") bar.style.setProperty("position", "fixed", "important");
      if (bar.style.top !== "0px") bar.style.setProperty("top", "0", "important");
      if (bar.style.zIndex !== "2147483647") bar.style.setProperty("z-index", "2147483647", "important");
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden"]
  });
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
