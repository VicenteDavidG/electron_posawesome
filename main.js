const { app, BrowserWindow, ipcMain, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");

// Ayuda a permitir impresión silenciosa (kiosk printing)
app.commandLine.appendSwitch("kiosk-printing");

const configPath = path.join(app.getPath("userData"), "config.json");
console.log("Config path (for debugging):", configPath);

// Mantener referencia global a la ventana principal
let mainWindow = null;

// Bloquear múltiples instancias
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: false,
    center: true,
    title: "LEAF | PUNTO DE VENTA LOCAL",

    // ICONO DE LA VENTANA (Windows/Linux)
    icon: path.join(__dirname, "leaf.ico"),

    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  });

  mainWindow = win;

  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    console.log("Config cargada:", config);

    win.loadURL(`${config.url}`);

    win.webContents.once("did-finish-load", () => {
      console.log("POS cargado");
      const scriptPath = path.join(__dirname, "custom-asteroid.js");
      const customScript = fs.readFileSync(scriptPath, "utf8");

      win.webContents
        .executeJavaScript(customScript)
        .then(() => console.log("Script personalizado inyectado"))
        .catch((err) => console.error("Error al inyectar script:", err));
    });
  } else {
    console.log("Mostrando setup.html");
    win.loadFile("setup.html");
  }

  // Bloquear acceso a herramientas de desarrollo
  win.webContents.on("before-input-event", (event, input) => {
    const key = (input.key || "").toLowerCase();
    const isDevShortcut =
      (key === "i" && input.control && input.shift) || key === "f12";
    if (isDevShortcut) event.preventDefault();
  });

  // Deshabilitar menú contextual (clic derecho)
  win.webContents.on("context-menu", (e) => e.preventDefault());

  // Atajos de teclado personalizados
  globalShortcut.register("F3", () =>
    win.webContents.send("tecla-cancelar-factura")
  );
  globalShortcut.register("F4", () =>
    win.webContents.send("tecla-eliminar-producto")
  );
  globalShortcut.register("F5", () =>
    win.webContents.send("tecla-cambiar-cantidad")
  );
  globalShortcut.register("F8", () =>
    win.webContents.send("tecla-validar-factura")
  );
  globalShortcut.register("F9", () =>
    win.webContents.send("tecla-validar-imprimir")
  );
  globalShortcut.register("F10", () => win.webContents.send("tecla-totalizar"));
  globalShortcut.register("CommandOrControl+F4", () =>
    win.webContents.send("tecla-manejo-efectivo")
  );

  // ---------------------------------------------------------
  // PREVENIR CIERRE SI HAY ITEMS EN CARRITO
  // ---------------------------------------------------------
  let isForceClose = false; // Bandera para cuando ya validamos y permitimos cerrar

  win.on("close", (e) => {
    if (isForceClose) return; // Si ya validamos, dejar cerrar

    e.preventDefault(); // Cancelar el cierre
    // Preguntar al renderer si hay items
    win.webContents.send("check-cart-status");
  });

  ipcMain.on("cart-status-response", (event, canClose) => {
    if (canClose) {
      isForceClose = true;
      win.close();
    } else {
      // Si no se puede cerrar, el renderer ya mostró un alert.
      // Aquí podríamos mostrar algo extra si quisieramos, pero con el alert basta.
      console.log("Intento de cierre bloqueado: hay items en el carrito.");
    }
  });
}

// Guardar configuración
ipcMain.on("guardar-config", (event, config) => {
  console.log("Guardando config en:", configPath);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log("Config guardada");

  app.relaunch();
  app.exit();
});

/**
 * IMPRESIÓN SILENCIOSA DESDE URL (printview)
 * El renderer (POSAwesome) manda: window.asteroid.printUrl({ url })
 * Este handler carga esa URL en una ventana oculta con la MISMA sesión (cookies/login)
 * y ejecuta webContents.print({ silent: true })
 */
ipcMain.handle("leaf:print-url", async (event, { url, deviceName } = {}) => {
  const parentWin =
    BrowserWindow.fromWebContents(event.sender) || mainWindow;

  if (!parentWin) return { ok: false, error: "No hay ventana principal." };
  if (!url) return { ok: false, error: "Falta 'url' para imprimir." };

  // Crear ventana oculta usando la misma sesión del POS (para conservar login/cookies)
  const printWin = new BrowserWindow({
    show: false,
    parent: parentWin,
    modal: false,
    webPreferences: {
      // usa la misma sesión
      session: parentWin.webContents.session,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  });

  try {
    await printWin.loadURL(url);

    const printers = await parentWin.webContents.getPrintersAsync();
    const defaultPrinter = printers.find((p) => p.isDefault)?.name;
    const target = deviceName || defaultPrinter;

    if (!target) {
      try {
        printWin.close();
      } catch { }
      return { ok: false, error: "No se encontró impresora predeterminada." };
    }

    const result = await new Promise((resolve) => {
      printWin.webContents.print(
        {
          silent: true,
          deviceName: target,
          printBackground: true,
        },
        (success, failureReason) => {
          resolve({
            ok: success,
            printer: target,
            error: success ? null : failureReason || "Print failed",
          });
        }
      );
    });

    try {
      printWin.close();
    } catch { }

    return result;
  } catch (e) {
    try {
      printWin.close();
    } catch { }
    return { ok: false, error: String(e?.message || e) };
  }
});

app.whenReady().then(createWindow);

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

process.on("uncaughtException", (err) => {
  console.error("Error no capturado:", err);
});
