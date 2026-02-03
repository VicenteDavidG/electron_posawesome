const { app, BrowserWindow, ipcMain, globalShortcut, Menu, dialog, session } = require("electron");
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

    // --- TASK 1: Limpieza de sesión para evitar "otra pestaña activa" ---
    // Borramos ServiceWorkers y LocalStorage antes de cargar
    session.defaultSession.clearStorageData({
      storages: ["serviceworkers", "localstorage"]
    }).then(() => {
      console.log("Storage Data (ServiceWorkers/LS) limpiado correctamente.");
      win.loadURL(`${config.url}`);
    }).catch(err => {
      console.error("Error limpiando storage:", err);
      win.loadURL(`${config.url}`);
    });

    win.webContents.once("did-finish-load", () => {
      console.log("POS cargado");
      const scriptPath = path.join(__dirname, "custom-asteroid.js");
      const customScript = fs.readFileSync(scriptPath, "utf8");

      // --- TASK 3: Inyección de credenciales desde config ---
      // Pasamos user/pass al contexto de la ventana para que custom-asteroid lo use
      const injectionConfig = {
        username: config.username || "",
        password: config.password || ""
      };
      const configScript = `window.asteroid_config = ${JSON.stringify(injectionConfig)};`;

      win.webContents
        .executeJavaScript(configScript + customScript)
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
  // TASK 4: HARD RESET MENU
  // ---------------------------------------------------------
  const menuTemplate = [
    {
      label: "Archivo",
      submenu: [
        {
          label: "Hard Reset",
          click: async () => {
            // Prompt for PIN
            // Electron no tiene prompt nativo simple, usamos una ventana pequeña o hack con dialog.
            // Para simplicidad, usaremos una lógica de "Dialog" con input si fuera posible, 
            // pero standard electron dialog no tiene input.
            // Usaremos una pequeña ventana modal html.
            const promptWin = new BrowserWindow({
              parent: win,
              modal: true,
              width: 300,
              height: 250,
              resizable: false,
              webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
              }
            });
            promptWin.loadURL('data:text/html,' + encodeURIComponent(`
              <style>body{background:#222;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0}input{margin:10px 0;padding:5px;text-align:center;}button{padding:5px 10px;cursor:pointer;}</style>
              <h3>Hard Reset</h3>
              <p>Ingrese PIN de seguridad:</p>
              <input type="password" id="pin" autofocus />
              <button onclick="submit()">Confirmar</button>
              <script>
                const { ipcRenderer } = require('electron');
                function submit() {
                  const val = document.getElementById('pin').value;
                  ipcRenderer.send('hard-reset-pin', val);
                }
                document.getElementById('pin').addEventListener('keydown', e => {
                   if(e.key === 'Enter') submit();
                   if(e.key === 'Escape') window.close();
                });
              </script>
            `));
          }
        },
        { role: 'quit', label: "Salir" }
      ]
    },
    {
      label: "Edición",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "Ver",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  // Listener para el PIN del Hard Reset
  ipcMain.on('hard-reset-pin', async (event, pin) => {
    // Cerramos la ventanita de prompt
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w) w.close();

    if (pin === "246813") {
      console.log("PIN Correcto. Ejecutando Hard Reset...");

      // Borrar config
      if (fs.existsSync(configPath)) {
        try {
          fs.unlinkSync(configPath);
          console.log("config.json eliminado.");
        } catch (e) {
          console.error("Error borrando config:", e);
        }
      }

      // Borrar Cache y Storage
      if (mainWindow) {
        await mainWindow.webContents.session.clearCache();
        await mainWindow.webContents.session.clearStorageData();
        console.log("Cache y Storage borrados.");
      }

      // Reiniciar
      app.relaunch();
      app.exit(0);
    } else {
      dialog.showErrorBox("Error", "PIN Incorrecto");
    }
  });

  // ---------------------------------------------------------
  // ---------------------------------------------------------
  // PREVENIR CIERRE SI HAY ITEMS EN CARRITO
  // ---------------------------------------------------------
  let isForceClose = false; // Bandera para cuando ya validamos y permitimos cerrar

  win.on("close", (e) => {
    if (isForceClose) return; // Si ya validamos y es seguro, dejar cerrar

    e.preventDefault(); // Cancelar el cierre por defecto

    // Preguntar al renderer si hay items
    // El renderer responderá con 'cart-status-response'
    win.webContents.send("check-cart-status");
  });

  ipcMain.on("cart-status-response", (event, canClose) => {
    if (canClose) {
      isForceClose = true;
      // Importante: usar app.exit() o win.close() dependiendo del flujo deseado. 
      // Si llamamos win.close(), volverá a disparar el evento 'close', 
      // pero como isForceClose es true, permitirá el cierre.
      win.close();
    } else {
      // Si no se puede cerrar, el renderer ya mostró un alert.
      console.log("Intento de cierre bloqueado: hay items en el carrito.");
      // No hacemos nada más, el evento 'close' ya fue prevenido.
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
