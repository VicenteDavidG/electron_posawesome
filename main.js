const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  dialog,
  powerMonitor,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { createLogger } = require("./src/logger");
const { verifyPin, verifySupervisor } = require("./src/security");
const {
  getConfigPath,
  isAllowedPrintUrl,
  loadConfig,
} = require("./src/config");
const {
  applyClosePolicy,
  evaluateClosePermission,
} = require("./src/close-guard");

// Support isolated userData directory for automated testing
if (process.env.LEAF_USER_DATA_DIR) {
  app.setPath("userData", path.resolve(process.env.LEAF_USER_DATA_DIR));
}

// Enable mock keychain in headless/CI test mode to avoid OS Keychain prompts
if (process.env.LEAF_TEST_MODE === "1") {
  app.commandLine.appendSwitch("use-mock-keychain");
}

// Allow silent kiosk printing
app.commandLine.appendSwitch("kiosk-printing");

// Enforce single instance before registering ready listeners
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  process.exit(0);
}

const userDataDir = app.getPath("userData");
const logger = createLogger(userDataDir);

let mainWindow = null;
let currentConfig = null;
let lastSnapshot = null;
let isForceClose = false;
let isSystemShutdown = false;
let closeCheckInProgress = false;

// Active modal PIN prompt state (used for Supervisor Emergency Exit & Hard Reset)
let activePinDialog = null;

app.on("second-instance", () => {
  const win = mainWindow || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

/**
 * Open a secure modal PIN dialog (contextIsolation: true, sandbox: true).
 * Resolves to { confirmed: true } when validator returns { ok: true }, or { confirmed: false }.
 */
function openPinDialog({ parentWin, title, message, confirmLabel, onValidate }) {
  return new Promise((resolve) => {
    if (activePinDialog && activePinDialog.win && !activePinDialog.win.isDestroyed()) {
      activePinDialog.win.focus();
      resolve({ confirmed: false });
      return;
    }

    const promptWin = new BrowserWindow({
      parent: parentWin && !parentWin.isDestroyed() ? parentWin : undefined,
      modal: Boolean(parentWin && !parentWin.isDestroyed()),
      width: 380,
      height: 260,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title,
      webPreferences: {
        preload: path.join(__dirname, "preload-pin.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
      },
    });

    promptWin.setMenuBarVisibility(false);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      activePinDialog = null;
      resolve(result);
    };

    activePinDialog = {
      win: promptWin,
      meta: { title, message, confirmLabel },
      onValidate,
      finish,
    };

    promptWin.on("closed", () => finish({ confirmed: false }));
    promptWin.loadFile(path.join(__dirname, "pin-dialog.html"));
  });
}

ipcMain.handle("leaf:pin-dialog-init", (event) => {
  if (!activePinDialog || activePinDialog.win.webContents.id !== event.sender.id) {
    return null;
  }
  return activePinDialog.meta;
});

ipcMain.handle("leaf:pin-dialog-submit", async (event, pin) => {
  if (!activePinDialog || activePinDialog.win.webContents.id !== event.sender.id) {
    return { ok: false, error: "Sesión de autorización inválida." };
  }
  try {
    const result = await activePinDialog.onValidate(String(pin || ""));
    if (result?.ok) {
      const dialogRef = activePinDialog;
      dialogRef.finish({ confirmed: true });
      if (!dialogRef.win.isDestroyed()) {
        dialogRef.win.close();
      }
      return { ok: true };
    }
    return { ok: false, error: result?.error || "PIN incorrecto." };
  } catch (err) {
    logger.error("Error validating PIN dialog.", { error: err });
    return { ok: false, error: "Error al validar el PIN." };
  }
});

ipcMain.on("leaf:pin-dialog-cancel", (event) => {
  if (!activePinDialog || activePinDialog.win.webContents.id !== event.sender.id) return;
  const dialogRef = activePinDialog;
  dialogRef.finish({ confirmed: false });
  if (!dialogRef.win.isDestroyed()) {
    dialogRef.win.close();
  }
});

/**
 * Show a Spanish blocked-action alert when reload or navigation is prevented.
 */
async function showBlockedNavigationDialog(win, evaluation) {
  const detail =
    evaluation && !evaluation.allowed && evaluation.detail
      ? evaluation.detail
      : "La recarga manual está deshabilitada para proteger la venta y el turno en curso.";
  await dialog.showMessageBox(win, {
    type: "warning",
    title: "Acción bloqueada",
    message: "No es posible recargar ni salir de esta pantalla",
    detail,
    buttons: ["Entendido"],
  });
}

/**
 * Execute Hard Reset flow after verifying the installation Hard Reset PIN.
 */
async function handleHardResetMenu(win) {
  if (!currentConfig?.hardResetPinHash) {
    await dialog.showMessageBox(win, {
      type: "error",
      title: "Hard Reset no disponible",
      message: "No hay PIN de Hard Reset configurado en esta instalación.",
      buttons: ["Aceptar"],
    });
    return;
  }

  const { confirmed } = await openPinDialog({
    parentWin: win,
    title: "Hard Reset",
    message: "Ingrese el PIN de Hard Reset para restablecer la configuración local:",
    confirmLabel: "Restablecer",
    onValidate: async (pin) => {
      const valid = verifyPin(pin, currentConfig.hardResetPinHash);
      return {
        ok: valid,
        error: valid ? null : "PIN de Hard Reset incorrecto.",
      };
    },
  });

  if (!confirmed) return;

  logger.warn("Hard Reset authorized and executed.");
  const cfgPath = getConfigPath(userDataDir);
  if (fs.existsSync(cfgPath)) {
    try {
      fs.unlinkSync(cfgPath);
    } catch (err) {
      logger.error("Failed to remove config.json during Hard Reset.", { error: err });
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    await mainWindow.webContents.session.clearCache();
    await mainWindow.webContents.session.clearStorageData();
  }

  isForceClose = true;
  app.relaunch();
  app.exit(0);
}

/**
 * Build application menu without reload/forceReload/toggleDevTools.
 */
function buildAppMenu(win) {
  const menuTemplate = [
    {
      label: "Archivo",
      submenu: [
        {
          label: "Hard Reset",
          click: () => handleHardResetMenu(win),
        },
        { type: "separator" },
        {
          label: "Salir",
          click: () => {
            if (win && !win.isDestroyed()) {
              win.close();
            }
          },
        },
      ],
    },
    {
      label: "Edición",
      submenu: [
        { role: "undo", label: "Deshacer" },
        { role: "redo", label: "Rehacer" },
        { type: "separator" },
        { role: "cut", label: "Cortar" },
        { role: "copy", label: "Copiar" },
        { role: "paste", label: "Pegar" },
        { role: "selectAll", label: "Seleccionar todo" },
      ],
    },
    {
      label: "Ver",
      submenu: [
        { role: "resetZoom", label: "Tamaño real" },
        { role: "zoomIn", label: "Acercar" },
        { role: "zoomOut", label: "Alejar" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Pantalla completa" },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

/**
 * Handle POS window close guard (Phase A.1).
 */
async function handleCloseAttempt(win) {
  if (closeCheckInProgress || win.isDestroyed()) return;
  closeCheckInProgress = true;

  try {
    const evaluation = await evaluateClosePermission({
      webContents: win.webContents,
      lastSnapshot,
      config: currentConfig,
      timeoutMs: 3000,
      logger,
    });

    if (evaluation.snapshot) {
      lastSnapshot = evaluation.snapshot;
    }

    if (evaluation.allowed) {
      isForceClose = true;
      win.close();
      return;
    }

    logger.warn("Window close blocked by policy.", {
      reason: evaluation.reason,
      timedOut: evaluation.timedOut,
    });

    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      title: evaluation.title || "Cierre bloqueado",
      message: evaluation.detail || "No es posible cerrar la aplicación en este momento.",
      buttons: [
        "Volver al POS",
        "Salir de todos modos (requiere autorización de supervisor)",
      ],
      defaultId: 0,
      cancelId: 0,
    });

    if (response !== 1) {
      return;
    }

    const { confirmed } = await openPinDialog({
      parentWin: win,
      title: "Autorización de supervisor",
      message:
        "Salida de emergencia solicitada. Ingrese el PIN de supervisor para autorizar el cierre:",
      confirmLabel: "Autorizar salida",
      onValidate: async (pin) => {
        const authResult = await verifySupervisor({
          pin,
          config: currentConfig,
        });
        return {
          ok: authResult.ok,
          error: authResult.reason || "PIN de supervisor incorrecto.",
        };
      },
    });

    if (confirmed) {
      logger.warn("Supervisor authorized emergency exit.", { reason: evaluation.reason });
      isForceClose = true;
      if (!win.isDestroyed()) {
        win.close();
      }
    }
  } finally {
    closeCheckInProgress = false;
  }
}

function createWindow() {
  const configExists = fs.existsSync(getConfigPath(userDataDir));
  currentConfig = configExists ? loadConfig(userDataDir, logger) : null;

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: false,
    center: true,
    title: "LEAF | PUNTO DE VENTA LOCAL",
    icon: path.join(__dirname, "leaf.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      additionalArguments: [`--leaf-app-version=${app.getVersion()}`],
    },
  });

  mainWindow = win;
  buildAppMenu(win);

  if (currentConfig && currentConfig.url) {
    win.loadURL(currentConfig.url);

    win.webContents.on("did-finish-load", () => {
      const scriptPath = path.join(__dirname, "custom-asteroid.js");
      const customScript = fs.readFileSync(scriptPath, "utf8");
      win.webContents
        .executeJavaScript(customScript)
        .then(() => logger.info("Page helper script injected."))
        .catch((err) => logger.error("Failed to inject helper script.", { error: err }));
    });
  } else {
    logger.info("No config.json found; loading setup.html.");
    win.loadFile(path.join(__dirname, "setup.html"));
  }

  // Focused-window keyboard guards and POS shortcuts (replaces globalShortcut)
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = (input.key || "").toLowerCase();
    const hasModifier = Boolean(input.control || input.meta);

    // Block DevTools shortcuts
    if ((key === "i" && hasModifier && input.shift) || key === "f12") {
      event.preventDefault();
      return;
    }

    // Block manual reload (Ctrl+R / Cmd+R / Ctrl+Shift+R)
    if (key === "r" && hasModifier) {
      event.preventDefault();
      const policyCheck = applyClosePolicy({
        canCloseResult: null,
        snapshot: lastSnapshot,
        config: currentConfig,
      });
      showBlockedNavigationDialog(win, policyCheck);
      return;
    }

    // Route Ctrl+W / Cmd+W and Alt+F4 through the guarded close flow
    if ((key === "w" && hasModifier) || (key === "f4" && input.alt)) {
      event.preventDefault();
      win.close();
      return;
    }

    // Focused POS function keys
    const shortcutMap = {
      f3: "tecla-cancelar-factura",
      f4: "tecla-eliminar-producto",
      f5: "tecla-cambiar-cantidad",
      f8: "tecla-validar-factura",
      f9: "tecla-validar-imprimir",
      f10: "tecla-totalizar",
    };

    if (!input.alt && !input.control && !input.meta && shortcutMap[key]) {
      event.preventDefault();
      win.webContents.send(shortcutMap[key]);
    }
  });

  // Disable context menu
  win.webContents.on("context-menu", (e) => e.preventDefault());

  // Handle page-initiated unload (beforeunload) with close policy
  win.webContents.on("will-prevent-unload", (event) => {
    if (isSystemShutdown || isForceClose) {
      event.preventDefault();
      return;
    }
    const evaluation = applyClosePolicy({
      canCloseResult: null,
      snapshot: lastSnapshot,
      config: currentConfig,
    });
    if (evaluation.allowed) {
      event.preventDefault();
    } else {
      logger.warn("Blocked page-initiated unload due to active POS policy.", {
        reason: evaluation.reason,
      });
      showBlockedNavigationDialog(win, evaluation);
    }
  });

  // Handle page-initiated navigations / reloads when blocked by POS policy
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (isSystemShutdown || isForceClose) return;
    const currentUrl = win.webContents.getURL();
    if (!currentUrl || targetUrl === currentUrl) {
      // Same-URL reload attempt
      const evaluation = applyClosePolicy({
        canCloseResult: null,
        snapshot: lastSnapshot,
        config: currentConfig,
      });
      if (!evaluation.allowed) {
        event.preventDefault();
        showBlockedNavigationDialog(win, evaluation);
      }
      return;
    }

    const evaluation = applyClosePolicy({
      canCloseResult: null,
      snapshot: lastSnapshot,
      config: currentConfig,
    });
    if (!evaluation.allowed) {
      event.preventDefault();
      logger.warn("Blocked navigation due to active POS policy.", {
        reason: evaluation.reason,
        targetUrl,
      });
      showBlockedNavigationDialog(win, evaluation);
    }
  });

  // Guard window close (Alt+F4, X button, Archivo -> Salir, Ctrl+W)
  win.on("close", (e) => {
    if (isForceClose || isSystemShutdown) return;
    if (!currentConfig) return; // Allow closing setup screen freely
    e.preventDefault();
    handleCloseAttempt(win);
  });

  // Windows OS shutdown / logoff event on the BrowserWindow
  win.on("session-end", () => {
    logger.warn("OS session-end received; allowing exit without veto.");
    isSystemShutdown = true;
    isForceClose = true;
  });
}

// Receive snapshot updates from POS Awesome / fallback monitor
ipcMain.on("leaf:report-snapshot", (_event, snapshot) => {
  if (!snapshot || typeof snapshot !== "object") return;
  lastSnapshot = {
    ...snapshot,
    receivedAt: new Date().toISOString(),
  };
});

// Temporary setup handler until Phase C enhances setup.html
ipcMain.on("guardar-config", (_event, config) => {
  const cfgPath = getConfigPath(userDataDir);
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), "utf8");
  isForceClose = true;
  app.relaunch();
  app.exit(0);
});

// Silent URL print handler with origin validation
ipcMain.handle("leaf:print-url", async (event, { url, deviceName } = {}) => {
  const parentWin = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!parentWin) return { ok: false, error: "No hay ventana principal." };
  if (!url) return { ok: false, error: "Falta 'url' para imprimir." };

  if (!currentConfig?.url || !isAllowedPrintUrl(url, currentConfig.url)) {
    logger.warn("Rejected leaf:print-url due to disallowed origin.", { url });
    return {
      ok: false,
      error: "Origen de impresión no autorizado.",
    };
  }

  const printWin = new BrowserWindow({
    show: false,
    parent: parentWin,
    modal: false,
    webPreferences: {
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
      if (!printWin.isDestroyed()) printWin.close();
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
            error: success ? null : failureReason || "Error de impresión",
          });
        }
      );
    });

    if (!printWin.isDestroyed()) printWin.close();
    return result;
  } catch (err) {
    if (!printWin.isDestroyed()) printWin.close();
    return { ok: false, error: String(err?.message || err) };
  }
});

// macOS/Linux OS shutdown event
powerMonitor.on("shutdown", () => {
  logger.warn("OS powerMonitor shutdown received; allowing exit without veto.");
  isSystemShutdown = true;
  isForceClose = true;
});

app.whenReady().then(createWindow);

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception in main process.", { error: err });
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection in main process.", { error: reason });
});
