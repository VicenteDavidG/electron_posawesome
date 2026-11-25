const fs = require("fs");
const path = require("path");
const { BrowserWindow } = require("electron");
const { atomicWriteFileSync } = require("./security");

const REASON_LABELS_ES = {
  unknown: "Desconocido (posible tarea terminada o corte de energía)",
  tampered: "Alteración detectada en el registro de sesión (tampered)",
  "render-process-gone": "Fallo del proceso de visualización (render-process-gone)",
  "child-process-gone": "Fallo de un proceso auxiliar (child-process-gone)",
  unresponsive: "La ventana dejó de responder (unresponsive)",
  uncaughtException: "Error interno no controlado (uncaughtException)",
  unhandledRejection: "Promesa rechazada no controlada (unhandledRejection)",
  "session-end": "Cierre de sesión del sistema operativo (session-end)",
  shutdown: "Apagado del sistema operativo (shutdown)",
};

/**
 * Format an offline voucher identifier: LOCAL-YYYYMMDD-HHMMSS.
 */
function formatLocalVoucherNumber(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `LOCAL-${y}${m}${day}-${hh}${mm}${ss}`;
}

/**
 * Format an ISO date string to a human-readable Spanish local timestamp.
 */
function formatDisplayDateTime(isoOrDate) {
  if (!isoOrDate) return "No disponible";
  const d = new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) return String(isoOrDate);
  return d.toLocaleString("es-HN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function translateReason(reason) {
  return REASON_LABELS_ES[reason] || `Cierre inesperado (${reason || "unknown"})`;
}

/**
 * Build an 80mm thermal receipt HTML document for an unexpected-close voucher.
 */
function buildVoucherHtml(voucher) {
  const totalAmount = Number(voucher.pendingTotal || 0).toFixed(2);
  const currencyPrefix = voucher.currency ? `${escapeHtml(voucher.currency)} ` : "";
  const reasonText = translateReason(voucher.reason);
  const detectedDisplay = voucher.serverTime
    ? `${formatDisplayDateTime(voucher.serverTime)} (Servidor) / ${formatDisplayDateTime(voucher.detectedAt)} (Local)`
    : `${formatDisplayDateTime(voucher.detectedAt)} (Local)`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>VALE - CIERRE INESPERADO DETECTADO</title>
  <style>
    @page {
      size: 80mm auto;
      margin: 4mm;
    }
    body {
      font-family: "Courier New", Courier, monospace;
      width: 72mm;
      margin: 0 auto;
      padding: 4px 0;
      color: #000000;
      font-size: 11px;
      line-height: 1.35;
    }
    .center { text-align: center; }
    .bold { font-weight: bold; }
    .title {
      font-size: 13px;
      font-weight: bold;
      text-align: center;
      border-top: 1px dashed #000;
      border-bottom: 1px dashed #000;
      padding: 6px 0;
      margin-bottom: 8px;
    }
    .amount-box {
      border: 1px solid #000;
      padding: 6px;
      margin: 8px 0;
      text-align: center;
    }
    .amount-value {
      font-size: 16px;
      font-weight: bold;
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 3px;
    }
    .label { font-weight: bold; }
    .val { text-align: right; word-break: break-word; }
    .divider {
      border-top: 1px dashed #000;
      margin: 8px 0;
    }
    .signature {
      margin-top: 28px;
      text-align: center;
    }
    .sig-line {
      border-top: 1px solid #000;
      width: 85%;
      margin: 0 auto 4px auto;
    }
  </style>
</head>
<body>
  <div class="center bold">LEAF | PUNTO DE VENTA LOCAL</div>
  <div class="title">VALE - CIERRE INESPERADO DETECTADO</div>

  <div class="row"><span class="label">No. de Vale:</span><span class="val bold">${escapeHtml(voucher.voucherNumber)}</span></div>
  <div class="row"><span class="label">ID Sesión:</span><span class="val">${escapeHtml(voucher.sessionId)}</span></div>

  <div class="amount-box">
    <div>VALOR FACTURA PENDIENTE</div>
    <div class="amount-value">${currencyPrefix}${escapeHtml(totalAmount)}</div>
    <div>Ítems en carrito: ${escapeHtml(voucher.itemsCount ?? 0)}</div>
  </div>

  <div class="row"><span class="label">Último registro:</span><span class="val">${escapeHtml(formatDisplayDateTime(voucher.lastSeenAt))}</span></div>
  <div class="row"><span class="label">Detección:</span><span class="val">${escapeHtml(detectedDisplay)}</span></div>

  <div class="divider"></div>

  <div class="row"><span class="label">Usuario:</span><span class="val">${escapeHtml(voucher.user || "No registrado")}</span></div>
  <div class="row"><span class="label">Perfil POS:</span><span class="val">${escapeHtml(voucher.posProfile || "No registrado")}</span></div>
  <div class="row"><span class="label">Turno de caja:</span><span class="val">${escapeHtml(voucher.shiftName || "No registrado")}</span></div>
  <div class="row"><span class="label">Equipo:</span><span class="val">${escapeHtml(voucher.machineName || "No disponible")}</span></div>
  <div class="row"><span class="label">Motivo:</span><span class="val">${escapeHtml(reasonText)}</span></div>

  <div class="divider"></div>

  <div class="signature">
    <div class="sig-line"></div>
    <div>Firma del supervisor</div>
  </div>
</body>
</html>`;
}

/**
 * Silently print an HTML document to the default (or specified) printer.
 */
async function printHtml({ html, parentWin, deviceName, userDataDir, logger }) {
  const testMode = process.env.LEAF_TEST_PRINT_MODE;
  if (testMode === "mock-ok" || testMode === "mock-fail") {
    if (userDataDir) {
      try {
        atomicWriteFileSync(
          path.join(userDataDir, "session", "last-printed-voucher.html"),
          html
        );
      } catch {
        // ignore in mock write
      }
    }
    if (testMode === "mock-ok") {
      return { ok: true, printer: deviceName || "MockPrinter", error: null };
    }
    return {
      ok: false,
      printer: deviceName || "MockPrinter",
      error: "Fallo simulado de impresora",
    };
  }

  if (!parentWin || parentWin.isDestroyed()) {
    return { ok: false, error: "No hay ventana principal disponible para imprimir." };
  }

  const printWin = new BrowserWindow({
    show: false,
    parent: parentWin,
    modal: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  });

  try {
    await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
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
    logger?.error("Failed to print HTML voucher.", { error: err });
    if (!printWin.isDestroyed()) printWin.close();
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * Create a persistent queue for unprinted unexpected-close vouchers.
 */
function createVoucherQueue(userDataDir, logger) {
  const queuePath = path.join(userDataDir, "session", "voucher-queue.json");

  function readAll() {
    if (!fs.existsSync(queuePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(queuePath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      logger?.error("Failed to parse voucher-queue.json.", { error: err });
      return [];
    }
  }

  function writeAll(items) {
    atomicWriteFileSync(queuePath, JSON.stringify(items, null, 2));
  }

  function enqueue(voucher) {
    if (!voucher || !voucher.sessionId) return;
    const list = readAll();
    const idx = list.findIndex((item) => item.sessionId === voucher.sessionId);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...voucher };
    } else {
      list.push(voucher);
    }
    writeAll(list);
  }

  function remove(sessionId) {
    const list = readAll().filter((item) => item.sessionId !== sessionId);
    writeAll(list);
  }

  return {
    getQueuePath: () => queuePath,
    getAll: readAll,
    enqueue,
    remove,
  };
}

module.exports = {
  formatLocalVoucherNumber,
  formatDisplayDateTime,
  translateReason,
  buildVoucherHtml,
  printHtml,
  createVoucherQueue,
};
