const fs = require("fs");
const path = require("path");
const { atomicWriteFileSync } = require("./security");
const { sessionFetch } = require("./http");

const UNEXPECTED_CLOSE_ENDPOINT = "/api/method/posawesome.posawesome.api.posapp.register_unexpected_close";
const DEFAULT_RETRY_INTERVAL_MS = 60000;

/**
 * Create a persistent, idempotent outbox queue for unexpected-close server events.
 */
function createOutbox(userDataDir, logger) {
  const outboxPath = path.join(userDataDir, "session", "outbox.json");
  let retryTimer = null;
  let flushInFlight = false;

  function readQueue() {
    if (!fs.existsSync(outboxPath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(outboxPath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      logger?.error("Failed to parse outbox.json; resetting empty queue.", { error: err });
      return [];
    }
  }

  function writeQueue(items) {
    atomicWriteFileSync(outboxPath, JSON.stringify(items, null, 2));
  }

  /**
   * Enqueue an unexpected-close event idempotently by client_session_id.
   */
  function enqueue(eventPayload) {
    if (!eventPayload || !eventPayload.client_session_id) return false;
    const queue = readQueue();
    const exists = queue.some((item) => item.client_session_id === eventPayload.client_session_id);
    if (exists) {
      return false;
    }
    queue.push(eventPayload);
    writeQueue(queue);
    logger?.info("Queued unexpected-close event in outbox.", {
      client_session_id: eventPayload.client_session_id,
    });
    return true;
  }

  /**
   * Attempt to send all queued events to the server.
   */
  async function flush({ serverUrl, targetSession, timeoutMs = 5000 } = {}) {
    if (flushInFlight) {
      return { skipped: true, results: [], remaining: readQueue().length };
    }
    if (!serverUrl || !targetSession) {
      return { skipped: true, results: [], remaining: readQueue().length };
    }

    flushInFlight = true;
    const results = [];
    try {
      let origin;
      try {
        origin = new URL(serverUrl).origin;
      } catch {
        return { skipped: true, results: [], remaining: readQueue().length };
      }

      const endpointUrl = `${origin}${UNEXPECTED_CLOSE_ENDPOINT}`;
      const queue = readQueue();
      if (queue.length === 0) {
        return { skipped: false, results: [], remaining: 0 };
      }

      const remaining = [];
      for (const item of queue) {
        try {
          const res = await sessionFetch(targetSession, endpointUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(item),
            timeoutMs,
          });

          const serverDateHeader = res.headers?.get?.("date") || null;

          if (res.ok) {
            let body = null;
            try {
              body = await res.json();
            } catch {
              body = null;
            }
            const payload = body?.message && typeof body.message === "object" ? body.message : body;
            const voucherNumber = payload?.voucher_number || payload?.name || null;
            const serverTime = payload?.server_time || serverDateHeader || null;

            logger?.info("Sent unexpected-close event to server.", {
              client_session_id: item.client_session_id,
              status: res.status,
              voucherNumber,
            });
            results.push({
              client_session_id: item.client_session_id,
              ok: true,
              status: res.status,
              voucherNumber,
              serverTime,
            });
          } else {
            logger?.warn("Server rejected unexpected-close event; keeping in outbox.", {
              client_session_id: item.client_session_id,
              status: res.status,
            });
            remaining.push(item);
            results.push({
              client_session_id: item.client_session_id,
              ok: false,
              status: res.status,
              serverTime: serverDateHeader,
              error: `HTTP ${res.status}`,
            });
          }
        } catch (err) {
          logger?.warn("Network error sending unexpected-close event; keeping in outbox.", {
            client_session_id: item.client_session_id,
            error: err,
          });
          remaining.push(item);
          results.push({
            client_session_id: item.client_session_id,
            ok: false,
            status: 0,
            error: String(err?.message || err),
          });
        }
      }

      writeQueue(remaining);
      return {
        skipped: false,
        results,
        remaining: remaining.length,
      };
    } finally {
      flushInFlight = false;
    }
  }

  /**
   * Start periodic retry timer (every 60 seconds by default).
   */
  function startRetryLoop(getContext, intervalMs = DEFAULT_RETRY_INTERVAL_MS) {
    stopRetryLoop();
    retryTimer = setInterval(() => {
      const ctx = typeof getContext === "function" ? getContext() : null;
      if (ctx?.serverUrl && ctx?.targetSession) {
        flush(ctx).catch((err) => {
          logger?.error("Unexpected error in outbox retry loop.", { error: err });
        });
      }
    }, intervalMs);
    if (typeof retryTimer.unref === "function") {
      retryTimer.unref();
    }
  }

  function stopRetryLoop() {
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  return {
    getOutboxPath: () => outboxPath,
    getPendingCount: () => readQueue().length,
    getPendingItems: () => readQueue(),
    enqueue,
    flush,
    startRetryLoop,
    stopRetryLoop,
  };
}

module.exports = {
  UNEXPECTED_CLOSE_ENDPOINT,
  createOutbox,
};
