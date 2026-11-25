const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  dialog,
  powerMonitor,
} = require("electron");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { createLogger } = require("./src/logger");
const {
  encryptSecret,
  decryptSecret,
  hashPin,
  verifyPin,
  verifySupervisor,
} = require("./src/security");
const {
  getConfigPath,
  isAllowedPrintUrl,
  loadConfig,
  saveConfig,
} = require("./src/config");
const {
  applyClosePolicy,
  evaluateClosePermission,
} = require("./src/close-guard");
const { createSessionJournal } = require("./src/journal");
const { createOutbox } = require("./src/outbox");
const {
  formatLocalVoucherNumber,
  formatDisplayDateTime,
  translateReason,
  buildVoucherHtml,
  printHtml,
  createVoucherQueue,
} = require("./src/voucher");
const { testServerUrl, loginToServer } = require("./src/auth");
const { setupAutoUpdater } = require("./src/updater");

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
const journal = createSessionJournal(userDataDir, logger);
const outbox = createOutbox(userDataDir, logger);
const voucherQueue = createVoucherQueue(userDataDir, logger);

let mainWindow = null;
let currentConfig = null;
let lastSnapshot = null;
let isForceClose = false;
let isSystemShutdown = false;
let closeCheckInProgress = false;

// Active modal states
let activePinDialog = null;
let activeUnexpectedCloseModal = null;

app.on("second-instance", () => {
  const win = mainWindow || BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

/**
 * Open a secure modal PIN dialog (contextIsolation: true, sandbox: true).
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
 * Build server outbox payload from a previous session record.
 */
function buildUnexpectedClosePayload({ record, reason, detectedAt }) {
  const snap = record?.lastSnapshot || {};
  return {
    client_session_id: record?.sessionId,
    pos_profile: snap.posProfile || null,
    pos_opening_shift: snap.shiftName || null,
    invoice_name: snap.invoiceName || null,
    pending_total: Number(snap.pendingTotal || 0),
    currency: snap.currency || "",
    items_count: Number(snap.itemsCount || 0),
    last_seen_at: record?.lastSeenAt || record?.startedAt || detectedAt,
    detected_at: detectedAt,
    reason,
    machine_name: record?.machineName || os.hostname(),
    app_version: record?.appVersion || app.getVersion(),
  };
}

/**
 * Build voucher object from an unexpected close incident.
 */
function buildVoucherData({ record, reason, detectedAt, serverVoucherNumber, serverTime }) {
  const snap = record?.lastSnapshot || {};
  const voucherNumber = serverVoucherNumber || formatLocalVoucherNumber(new Date(detectedAt));
  return {
    sessionId: record?.sessionId,
    voucherNumber,
    pendingTotal: Number(snap.pendingTotal || 0),
    currency: snap.currency || "",
    itemsCount: Number(snap.itemsCount || 0),
    lastSeenAt: record?.lastSeenAt || record?.startedAt || detectedAt,
    detectedAt,
    serverTime: serverTime || null,
    lastSeenDisplay: formatDisplayDateTime(record?.lastSeenAt || record?.startedAt || detectedAt),
    detectedDisplay: serverTime
      ? `${formatDisplayDateTime(serverTime)} (Servidor)`
      : `${formatDisplayDateTime(detectedAt)} (Local)`,
    user: snap.user || currentConfig?.username || null,
    posProfile: snap.posProfile || null,
    shiftName: snap.shiftName || null,
    machineName: record?.machineName || os.hostname(),
    reason,
    reasonLabel: translateReason(reason),
    requiresVoucher: Number(snap.pendingTotal || 0) > 0,
    printed: false,
    queued: false,
    printer: null,
    printError: null,
  };
}

/**
 * Attempt to print a voucher and update queue state accordingly.
 */
async function attemptVoucherPrint(voucherData, parentWin) {
  const html = buildVoucherHtml(voucherData);
  const printResult = await printHtml({
    html,
    parentWin,
    userDataDir,
    logger,
  });

  if (printResult.ok) {
    voucherData.printed = true;
    voucherData.queued = false;
    voucherData.printer = printResult.printer || "Impresora predeterminada";
    voucherData.printError = null;
    voucherQueue.remove(voucherData.sessionId);
    logger.info("Unexpected-close voucher printed.", {
      sessionId: voucherData.sessionId,
      voucherNumber: voucherData.voucherNumber,
      printer: voucherData.printer,
    });
  } else {
    voucherData.printed = false;
    voucherData.queued = true;
    voucherData.printError = printResult.error || "Error al imprimir";
    voucherQueue.enqueue(voucherData);
    logger.warn("Voucher printing failed; queued for retry.", {
      sessionId: voucherData.sessionId,
      voucherNumber: voucherData.voucherNumber,
      error: voucherData.printError,
    });
  }
  return voucherData;
}

/**
 * Show blocking Spanish unexpected-close modal before continuing to POS.
 */
function showUnexpectedCloseDialog({ parentWin, voucherData }) {
  return new Promise((resolve) => {
    const dialogWin = new BrowserWindow({
      parent: parentWin && !parentWin.isDestroyed() ? parentWin : undefined,
      modal: Boolean(parentWin && !parentWin.isDestroyed()),
      width: 560,
      height: 520,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: "Cierre inesperado detectado",
      webPreferences: {
        preload: path.join(__dirname, "preload-dialog.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
      },
    });

    dialogWin.setMenuBarVisibility(false);

    let canDismiss = !voucherData.requiresVoucher;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      activeUnexpectedCloseModal = null;
      resolve();
    };

    activeUnexpectedCloseModal = {
      win: dialogWin,
      parentWin,
      voucherData,
      setCanDismiss: (val) => {
        canDismiss = Boolean(val);
      },
      finish,
    };

    dialogWin.on("close", (e) => {
      if (!canDismiss && !isSystemShutdown) {
        e.preventDefault();
      }
    });

    dialogWin.on("closed", () => finish());
    dialogWin.loadFile(path.join(__dirname, "unexpected-close-dialog.html"));
  });
}

ipcMain.handle("leaf:unexpected-close-data", async (event) => {
  if (
    !activeUnexpectedCloseModal ||
    activeUnexpectedCloseModal.win.webContents.id !== event.sender.id
  ) {
    return null;
  }
  const { voucherData, parentWin, setCanDismiss } = activeUnexpectedCloseModal;
  if (voucherData.requiresVoucher && !voucherData.printed && !voucherData.queued) {
    await attemptVoucherPrint(voucherData, parentWin);
    setCanDismiss(Boolean(voucherData.printed || voucherData.queued));
  }
  return voucherData;
});

ipcMain.handle("leaf:unexpected-close-retry-print", async (event) => {
  if (
    !activeUnexpectedCloseModal ||
    activeUnexpectedCloseModal.win.webContents.id !== event.sender.id
  ) {
    return null;
  }
  const { voucherData, parentWin, setCanDismiss } = activeUnexpectedCloseModal;
  await attemptVoucherPrint(voucherData, parentWin);
  setCanDismiss(Boolean(voucherData.printed || voucherData.queued));
  return voucherData;
});

ipcMain.handle("leaf:unexpected-close-ack", (event) => {
  if (
    !activeUnexpectedCloseModal ||
    activeUnexpectedCloseModal.win.webContents.id !== event.sender.id
  ) {
    return { ok: false };
  }
  const { voucherData, win, setCanDismiss, finish } = activeUnexpectedCloseModal;
  if (voucherData.requiresVoucher && !voucherData.printed && !voucherData.queued) {
    return { ok: false };
  }
  setCanDismiss(true);
  finish();
  if (!win.isDestroyed()) {
    win.close();
  }
  return { ok: true };
});

/**
 * Process an unexpected close incident: enqueue in outbox, flush if online, and notify cashier.
 */
async function handleUnexpectedCloseDetection({ inspection, parentWin }) {
  const detectedAt = new Date().toISOString();
  const payload = buildUnexpectedClosePayload({
    record: inspection.record,
    reason: inspection.reason,
    detectedAt,
  });

  outbox.enqueue(payload);

  let serverVoucherNumber = null;
  let serverTime = null;
  try {
    const flushRes = await outbox.flush({
      serverUrl: currentConfig?.url,
      targetSession: parentWin.webContents.session,
      timeoutMs: 3500,
    });
    const matched = flushRes.results?.find(
      (r) => r.client_session_id === payload.client_session_id
    );
    if (matched) {
      serverVoucherNumber = matched.voucherNumber || null;
      serverTime = matched.serverTime || null;
    }
  } catch (err) {
    logger.warn("Immediate outbox flush on startup failed; kept in outbox.", { error: err });
  }

  const voucherData = buildVoucherData({
    record: inspection.record,
    reason: inspection.reason,
    detectedAt,
    serverVoucherNumber,
    serverTime,
  });

  await showUnexpectedCloseDialog({ parentWin, voucherData });
}

/**
 * Retry printing any queued vouchers from menu.
 */
async function retryQueuedVouchers(win) {
  const queued = voucherQueue.getAll();
  if (queued.length === 0) {
    await dialog.showMessageBox(win, {
      type: "info",
      title: "Vales pendientes",
      message: "No hay vales pendientes por imprimir.",
      buttons: ["Aceptar"],
    });
    return;
  }

  let printedCount = 0;
  for (const voucher of queued) {
    const updated = await attemptVoucherPrint({ ...voucher }, win);
    if (updated.printed) printedCount++;
  }

  await dialog.showMessageBox(win, {
    type: printedCount === queued.length ? "info" : "warning",
    title: "Reintento de vales",
    message: `Se imprimieron ${printedCount} de ${queued.length} vale(s) pendiente(s).`,
    buttons: ["Aceptar"],
  });
}

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
  journal.markCleanClose();
  outbox.stopRetryLoop();

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
          label: "Reintentar vales pendientes",
          click: () => retryQueuedVouchers(win),
        },
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
      journal.updateSnapshot(lastSnapshot);
    }

    if (evaluation.allowed) {
      journal.markCleanClose();
      outbox.stopRetryLoop();
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
      journal.markCleanClose();
      outbox.stopRetryLoop();
      isForceClose = true;
      if (!win.isDestroyed()) {
        win.close();
      }
    }
  } finally {
    closeCheckInProgress = false;
  }
}

/**
 * Load configured POS URL, perform main-process login if configured, and attach window guards.
 */
async function startPosInWindow(win, config) {
  currentConfig = config;
  const prevInspection = journal.inspectPreviousSession();

  journal.startSession({
    appVersion: app.getVersion(),
    machineName: os.hostname(),
  });

  outbox.startRetryLoop(() => ({
    serverUrl: currentConfig?.url,
    targetSession: win && !win.isDestroyed() ? win.webContents.session : null,
    timeoutMs: 5000,
  }));

  if (currentConfig.username && currentConfig.passwordEncrypted) {
    try {
      const password = decryptSecret(currentConfig.passwordEncrypted);
      await loginToServer({
        serverUrl: currentConfig.url,
        username: currentConfig.username,
        password,
        targetSession: win.webContents.session,
        logger,
      });
    } catch (err) {
      logger.warn("Could not decrypt or execute main-process login.", { error: err });
    }
  }

  if (prevInspection.detected) {
    await handleUnexpectedCloseDetection({
      inspection: prevInspection,
      parentWin: win,
    });
  } else {
    outbox
      .flush({
        serverUrl: currentConfig.url,
        targetSession: win.webContents.session,
        timeoutMs: 4000,
      })
      .catch(() => {});
  }

  if (win.isDestroyed()) return;

  const configuredOrigin = new URL(currentConfig.url).origin;
  win.webContents.on("did-finish-load", () => {
    try {
      const loadedUrl = win.webContents.getURL();
      if (!loadedUrl || new URL(loadedUrl).origin !== configuredOrigin) {
        return;
      }
      const scriptPath = path.join(__dirname, "custom-asteroid.js");
      const customScript = fs.readFileSync(scriptPath, "utf8");
      win.webContents
        .executeJavaScript(customScript)
        .then(() => logger.info("Page helper script injected."))
        .catch((err) => logger.error("Failed to inject helper script.", { error: err }));
    } catch (err) {
      logger.error("Error checking loaded origin before script injection.", { error: err });
    }
  });

  win.loadURL(currentConfig.url);
}

async function createWindow() {
  const configExists = fs.existsSync(getConfigPath(userDataDir));
  currentConfig = configExists ? loadConfig(userDataDir, logger) : null;
  const isConfigured = Boolean(currentConfig && currentConfig.url);

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: false,
    center: true,
    title: "LEAF | PUNTO DE VENTA LOCAL",
    icon: path.join(__dirname, "leaf.ico"),
    webPreferences: {
      preload: path.join(__dirname, isConfigured ? "preload.js" : "preload-setup.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      additionalArguments: [`--leaf-app-version=${app.getVersion()}`],
    },
  });

  mainWindow = win;
  buildAppMenu(win);

  // Window-scoped keyboard guards and POS shortcuts (attached before loading URL)
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" && input.type !== "rawKeyDown") return;
    if (!currentConfig?.url) return;

    const key = (input.key || "").toLowerCase();
    const code = (input.code || "").toLowerCase();
    const hasModifier = Boolean(input.control || input.meta);

    if (
      ((key === "i" || code === "keyi") && hasModifier && input.shift) ||
      key === "f12" ||
      code === "f12"
    ) {
      event.preventDefault();
      return;
    }

    if ((key === "r" || code === "keyr") && hasModifier) {
      event.preventDefault();
      const policyCheck = applyClosePolicy({
        canCloseResult: null,
        snapshot: lastSnapshot,
        config: currentConfig,
      });
      showBlockedNavigationDialog(win, policyCheck);
      return;
    }

    if (
      ((key === "w" || code === "keyw") && hasModifier) ||
      ((key === "f4" || code === "f4") && input.alt)
    ) {
      event.preventDefault();
      win.close();
      return;
    }

    const shortcutMap = {
      f3: "tecla-cancelar-factura",
      f4: "tecla-eliminar-producto",
      f5: "tecla-cambiar-cantidad",
      f8: "tecla-validar-factura",
      f9: "tecla-validar-imprimir",
      f10: "tecla-totalizar",
    };

    const shortcutChannel = shortcutMap[key] || shortcutMap[code];
    if (!input.alt && !input.control && !input.meta && shortcutChannel) {
      event.preventDefault();
      win.webContents.send(shortcutChannel);
    }
  });

  win.webContents.on("context-menu", (e) => e.preventDefault());

  win.webContents.on("will-prevent-unload", (event) => {
    if (isSystemShutdown || isForceClose || !currentConfig?.url) {
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

  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (isSystemShutdown || isForceClose || !currentConfig?.url) return;
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

  win.webContents.on("render-process-gone", async (_event, details) => {
    logger.error("Renderer process gone.", { details });
    journal.recordEvent("render-process-gone");

    const record = journal.getCurrentRecord();
    const snap = record?.lastSnapshot || lastSnapshot;
    const pendingTotal = Number(snap?.pendingTotal || 0);

    await dialog.showMessageBox(win, {
      type: "error",
      title: "Error en la pantalla del punto de venta",
      message: "La pantalla del punto de venta se detuvo inesperadamente.",
      detail:
        pendingTotal > 0
          ? "Se registró el incidente y se generará el vale por los productos pendientes antes de recargar."
          : "Se registró el incidente en el diario local. La aplicación se recargará ahora.",
      buttons: ["Recargar punto de venta"],
    });

    if (pendingTotal > 0 && currentConfig?.url && !win.isDestroyed()) {
      const detectedAt = new Date().toISOString();
      const payload = buildUnexpectedClosePayload({
        record: { ...record, lastSnapshot: snap },
        reason: "render-process-gone",
        detectedAt,
      });
      outbox.enqueue(payload);
      const voucherData = buildVoucherData({
        record: { ...record, lastSnapshot: snap },
        reason: "render-process-gone",
        detectedAt,
      });
      await attemptVoucherPrint(voucherData, win);
    }

    if (currentConfig?.url && !win.isDestroyed()) {
      win.loadURL(currentConfig.url);
    }
  });

  win.on("unresponsive", async () => {
    logger.warn("Main window became unresponsive.");
    journal.recordEvent("unresponsive");

    const { response } = await dialog.showMessageBox(win, {
      type: "warning",
      title: "Ventana sin respuesta",
      message: "El punto de venta dejó de responder.",
      detail:
        "Puede esperar unos segundos o recargar la pantalla de forma segura (el estado quedó guardado en el diario).",
      buttons: ["Esperar", "Recargar punto de venta"],
      defaultId: 0,
    });

    if (response === 1 && currentConfig?.url && !win.isDestroyed()) {
      win.loadURL(currentConfig.url);
    }
  });

  win.on("close", (e) => {
    if (isForceClose || isSystemShutdown) return;
    if (!currentConfig) return;
    e.preventDefault();
    handleCloseAttempt(win);
  });

  win.on("session-end", () => {
    logger.warn("OS session-end received; recording in journal and allowing exit.");
    journal.recordEvent("session-end");
    isSystemShutdown = true;
    isForceClose = true;
  });

  if (isConfigured) {
    await startPosInWindow(win, currentConfig);
  } else {
    logger.info("No config.json found; loading setup.html.");
    win.loadFile(path.join(__dirname, "setup.html"));
  }
}

// Receive snapshot updates from POS Awesome / fallback monitor
ipcMain.on("leaf:report-snapshot", (_event, snapshot) => {
  if (!snapshot || typeof snapshot !== "object") return;
  lastSnapshot = {
    ...snapshot,
    receivedAt: new Date().toISOString(),
  };
  journal.updateSnapshot(lastSnapshot);
});

// Setup: test server URL connectivity
ipcMain.handle("leaf:test-url", async (event, url) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const targetSession = senderWin?.webContents?.session;
  return testServerUrl({ url, targetSession });
});

// Setup: validate, test URL, encrypt password, hash both PINs, and persist config
ipcMain.handle("leaf:save-config", async (event, input) => {
  const senderWin = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const targetSession = senderWin?.webContents?.session;

  const urlCheck = await testServerUrl({
    url: input?.url,
    targetSession,
  });
  if (!urlCheck.ok) {
    return { ok: false, error: urlCheck.error };
  }

  const supPin = String(input?.supervisorPin || "");
  const hrPin = String(input?.hardResetPin || "");
  if (supPin.length < 4 || hrPin.length < 4) {
    return {
      ok: false,
      error: "Los códigos PIN deben tener al menos 4 caracteres.",
    };
  }

  try {
    const passwordPlain = String(input?.password || "");
    const passwordEncrypted = passwordPlain ? encryptSecret(passwordPlain) : "";
    const supervisorPinHash = hashPin(supPin);
    const hardResetPinHash = hashPin(hrPin);

    saveConfig(userDataDir, {
      url: urlCheck.url,
      username: String(input?.username || "").trim(),
      passwordEncrypted,
      supervisorPinHash,
      hardResetPinHash,
      blockOnPendingItems: input?.blockOnPendingItems !== false,
      blockOnOpenShift: input?.blockOnOpenShift !== false,
    });

    logger.info("Initial setup configuration saved securely.");
    isForceClose = true;
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (err) {
    logger.error("Failed to save configuration.", { error: err });
    return {
      ok: false,
      error: `No se pudo guardar la configuración de forma segura: ${err?.message || err}`,
    };
  }
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

powerMonitor.on("shutdown", () => {
  logger.warn("OS powerMonitor shutdown received; recording in journal and allowing exit.");
  journal.recordEvent("shutdown");
  isSystemShutdown = true;
  isForceClose = true;
});

app.on("child-process-gone", (_event, details) => {
  logger.error("Child process gone.", { details });
  journal.recordEvent("child-process-gone");
});

app.whenReady().then(async () => {
  await createWindow();
  setupAutoUpdater(logger);
});

process.on("uncaughtException", (err) => {
  journal.recordEvent("uncaughtException");
  logger.error("Uncaught exception in main process.", { error: err });
});

process.on("unhandledRejection", (reason) => {
  journal.recordEvent("unhandledRejection");
  logger.error("Unhandled rejection in main process.", { error: reason });
});
