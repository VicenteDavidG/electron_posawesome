const PROBE_SCRIPT = `
(async () => {
  try {
    if (window.leafPos && typeof window.leafPos.canClose === "function") {
      const canCloseResult = await window.leafPos.canClose();
      let snapshot = null;
      if (typeof window.leafPos.getSnapshot === "function") {
        snapshot = window.leafPos.getSnapshot();
      }
      return { source: "leafPos", canCloseResult, snapshot };
    }
    const rawTotal = localStorage.getItem("totalPrice");
    const pendingTotal = Number(rawTotal) || 0;
    return {
      source: "fallback_totalPrice",
      canCloseResult: {
        allowed: !(pendingTotal > 0),
        reason: pendingTotal > 0 ? "pending_items" : null,
        message: pendingTotal > 0 ? "Hay productos sin facturar." : ""
      },
      snapshot: {
        hasPendingItems: pendingTotal > 0,
        itemsCount: pendingTotal > 0 ? 1 : 0,
        pendingTotal,
        currency: "",
        invoiceName: null,
        hasOpenShift: false,
        shiftName: null,
        posProfile: null,
        user: null,
        capturedAt: new Date().toISOString()
      }
    };
  } catch (err) {
    return { source: "error", error: String(err && err.message ? err.message : err) };
  }
})()
`;

/**
 * Apply configured close/reload policy to a snapshot or canClose response.
 */
function applyClosePolicy({ canCloseResult, snapshot, config, timedOut = false, fallbackUsed = false }) {
  const blockPending = config?.blockOnPendingItems !== false;
  const blockShift = config?.blockOnOpenShift !== false;

  const hasPendingItems = Boolean(
    canCloseResult?.reason === "pending_items" ||
    snapshot?.hasPendingItems ||
    (typeof snapshot?.pendingTotal === "number" && snapshot.pendingTotal > 0)
  );

  const hasOpenShift = Boolean(
    canCloseResult?.reason === "open_shift" ||
    snapshot?.hasOpenShift
  );

  if (hasPendingItems && blockPending) {
    return {
      allowed: false,
      reason: "pending_items",
      title: "Cierre bloqueado",
      detail: canCloseResult?.message || "Hay productos sin facturar. Complete o cancele la venta antes de salir.",
      snapshot: snapshot || null,
      timedOut,
      fallbackUsed,
    };
  }

  if (hasOpenShift && blockShift) {
    return {
      allowed: false,
      reason: "open_shift",
      title: "Turno de caja abierto",
      detail: canCloseResult?.message || "Debe hacer el cierre de caja antes de salir.",
      snapshot: snapshot || null,
      timedOut,
      fallbackUsed,
    };
  }

  // If the page explicitly blocked for another reason and policy didn't explicitly disable it
  if (canCloseResult && canCloseResult.allowed === false && canCloseResult.reason !== "open_shift" && canCloseResult.reason !== "pending_items") {
    return {
      allowed: false,
      reason: canCloseResult.reason || "blocked",
      title: "Cierre bloqueado",
      detail: canCloseResult.message || "No es posible cerrar la aplicación en este momento.",
      snapshot: snapshot || null,
      timedOut,
      fallbackUsed,
    };
  }

  // If renderer timed out and we have no snapshot at all, require supervisor override
  if (timedOut && !snapshot) {
    return {
      allowed: false,
      reason: "unresponsive",
      title: "La página no responde",
      detail: "El punto de venta no respondió a tiempo para verificar si hay productos sin facturar o turno abierto.",
      snapshot: null,
      timedOut: true,
      fallbackUsed: false,
    };
  }

  return {
    allowed: true,
    reason: null,
    title: null,
    detail: null,
    snapshot: snapshot || null,
    timedOut,
    fallbackUsed,
  };
}

/**
 * Evaluate whether the POS window may close or reload.
 * 1. Queries window.leafPos.canClose() with a 3-second timeout (fallback to localStorage totalPrice).
 * 2. On timeout/error, falls back to the latest lastSnapshot held in main memory.
 * 3. Applies blockOnPendingItems / blockOnOpenShift policy.
 */
async function evaluateClosePermission({ webContents, lastSnapshot, config, timeoutMs = 3000, logger }) {
  let timedOut = false;
  let probe = null;

  try {
    if (!webContents || webContents.isDestroyed()) {
      timedOut = true;
    } else {
      probe = await Promise.race([
        webContents.executeJavaScript(PROBE_SCRIPT, true),
        new Promise((resolve) =>
          setTimeout(() => {
            timedOut = true;
            resolve({ source: "timeout" });
          }, timeoutMs)
        ),
      ]);
    }
  } catch (err) {
    logger?.warn("Close probe failed; falling back to lastSnapshot.", { error: err });
    probe = { source: "error", error: String(err?.message || err) };
  }

  if (timedOut || !probe || probe.source === "timeout" || probe.source === "error") {
    logger?.warn("Renderer did not respond to close check in time; using lastSnapshot.", {
      source: probe?.source || "timeout",
      hasLastSnapshot: Boolean(lastSnapshot),
    });
    return applyClosePolicy({
      canCloseResult: null,
      snapshot: lastSnapshot || null,
      config,
      timedOut: true,
      fallbackUsed: false,
    });
  }

  const fallbackUsed = probe.source === "fallback_totalPrice";
  if (fallbackUsed) {
    logger?.warn("window.leafPos not found on page; using localStorage totalPrice fallback.");
  }

  const snapshot = probe.snapshot || lastSnapshot || null;
  return applyClosePolicy({
    canCloseResult: probe.canCloseResult,
    snapshot,
    config,
    timedOut: false,
    fallbackUsed,
  });
}

module.exports = {
  applyClosePolicy,
  evaluateClosePermission,
};
