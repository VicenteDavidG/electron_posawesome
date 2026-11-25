const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  atomicWriteFileSync,
  getOrCreateHmacKey,
  signPayload,
  verifyPayload,
} = require("./security");

const HEARTBEAT_INTERVAL_MS = 5000;
const SNAPSHOT_THROTTLE_MS = 1000;

/**
 * Create a signed, crash-resistant session journal manager under <userData>/session/running.json.
 */
function createSessionJournal(userDataDir, logger) {
  const sessionDir = path.join(userDataDir, "session");
  const runningPath = path.join(sessionDir, "running.json");

  let hmacKey = null;
  let currentRecord = null;
  let heartbeatTimer = null;
  let snapshotFlushTimer = null;
  let lastSnapshotWriteAt = 0;

  function ensureHmacKey() {
    if (!hmacKey) {
      hmacKey = getOrCreateHmacKey(sessionDir);
    }
    return hmacKey;
  }

  function writeRecordSync(record) {
    if (!record) return;
    try {
      const key = ensureHmacKey();
      const signed = signPayload(record, key);
      atomicWriteFileSync(runningPath, JSON.stringify(signed, null, 2));
    } catch (err) {
      logger?.error("Failed to write session journal.", { error: err });
    }
  }

  /**
   * Inspect any leftover running.json from a previous execution.
   */
  function inspectPreviousSession() {
    if (!fs.existsSync(runningPath)) {
      return { detected: false };
    }

    let rawText = "";
    try {
      rawText = fs.readFileSync(runningPath, "utf8");
    } catch (err) {
      logger?.error("Could not read previous running.json.", { error: err });
      return {
        detected: true,
        reason: "tampered",
        record: {
          sessionId: crypto.randomUUID(),
          startedAt: null,
          lastSeenAt: null,
          appVersion: null,
          machineName: null,
          state: "running",
          lastSnapshot: null,
          lastEvent: "tampered",
        },
      };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      logger?.warn("Previous running.json contains invalid JSON; treating as tampered.");
      return {
        detected: true,
        reason: "tampered",
        record: {
          sessionId: crypto.randomUUID(),
          startedAt: null,
          lastSeenAt: null,
          appVersion: null,
          machineName: null,
          state: "running",
          lastSnapshot: null,
          lastEvent: "tampered",
        },
      };
    }

    let key;
    try {
      key = ensureHmacKey();
    } catch (err) {
      logger?.error("Failed to load HMAC key while inspecting journal.", { error: err });
      return {
        detected: true,
        reason: "tampered",
        record: parsed?.payload || {
          sessionId: crypto.randomUUID(),
          lastSnapshot: null,
          lastEvent: "tampered",
        },
      };
    }

    const validSignature = verifyPayload(parsed, key);
    if (!validSignature) {
      logger?.warn("running.json HMAC verification failed; treating as tampered.");
      const payload = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : {};
      return {
        detected: true,
        reason: "tampered",
        record: {
          sessionId: payload.sessionId || crypto.randomUUID(),
          startedAt: payload.startedAt || null,
          lastSeenAt: payload.lastSeenAt || null,
          appVersion: payload.appVersion || null,
          machineName: payload.machineName || null,
          state: payload.state || "running",
          lastSnapshot: payload.lastSnapshot || null,
          lastEvent: "tampered",
        },
      };
    }

    const data = parsed.payload;
    if (data.state === "closed") {
      try {
        fs.unlinkSync(runningPath);
      } catch {
        // ignore
      }
      return { detected: false };
    }

    const reason = data.lastEvent || "unknown";
    logger?.warn("Unexpected close detected from previous session.", {
      sessionId: data.sessionId,
      reason,
      lastSeenAt: data.lastSeenAt,
    });
    return {
      detected: true,
      reason,
      record: data,
    };
  }

  /**
   * Start a new active session journal and begin 5-second heartbeats.
   */
  function startSession({ appVersion, machineName }) {
    stopTimers();
    const now = new Date().toISOString();
    currentRecord = {
      sessionId: crypto.randomUUID(),
      startedAt: now,
      lastSeenAt: now,
      appVersion,
      machineName,
      state: "running",
      lastSnapshot: null,
      lastEvent: null,
    };
    writeRecordSync(currentRecord);
    lastSnapshotWriteAt = Date.now();

    heartbeatTimer = setInterval(() => {
      if (!currentRecord || currentRecord.state !== "running") return;
      currentRecord.lastSeenAt = new Date().toISOString();
      writeRecordSync(currentRecord);
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeatTimer.unref === "function") {
      heartbeatTimer.unref();
    }

    return currentRecord;
  }

  /**
   * Update snapshot in memory and persist at most once per second.
   */
  function updateSnapshot(snapshot) {
    if (!currentRecord || currentRecord.state !== "running") return;
    currentRecord.lastSnapshot = snapshot;
    currentRecord.lastSeenAt = new Date().toISOString();

    const elapsed = Date.now() - lastSnapshotWriteAt;
    if (elapsed >= SNAPSHOT_THROTTLE_MS) {
      if (snapshotFlushTimer) {
        clearTimeout(snapshotFlushTimer);
        snapshotFlushTimer = null;
      }
      lastSnapshotWriteAt = Date.now();
      writeRecordSync(currentRecord);
    } else if (!snapshotFlushTimer) {
      snapshotFlushTimer = setTimeout(() => {
        snapshotFlushTimer = null;
        if (currentRecord && currentRecord.state === "running") {
          lastSnapshotWriteAt = Date.now();
          writeRecordSync(currentRecord);
        }
      }, SNAPSHOT_THROTTLE_MS - elapsed);
      if (typeof snapshotFlushTimer.unref === "function") {
        snapshotFlushTimer.unref();
      }
    }
  }

  /**
   * Synchronously record a critical lifecycle or error event before reacting.
   */
  function recordEvent(eventName) {
    if (!currentRecord) {
      const now = new Date().toISOString();
      currentRecord = {
        sessionId: crypto.randomUUID(),
        startedAt: now,
        lastSeenAt: now,
        appVersion: null,
        machineName: null,
        state: "running",
        lastSnapshot: null,
        lastEvent: eventName,
      };
    } else {
      currentRecord.lastEvent = eventName;
      currentRecord.lastSeenAt = new Date().toISOString();
    }
    writeRecordSync(currentRecord);
  }

  function stopTimers() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (snapshotFlushTimer) {
      clearTimeout(snapshotFlushTimer);
      snapshotFlushTimer = null;
    }
  }

  /**
   * Mark clean close, persist state: "closed", and remove running.json.
   */
  function markCleanClose() {
    stopTimers();
    if (currentRecord) {
      currentRecord.state = "closed";
      currentRecord.lastSeenAt = new Date().toISOString();
      writeRecordSync(currentRecord);
    }
    try {
      if (fs.existsSync(runningPath)) {
        fs.unlinkSync(runningPath);
      }
    } catch (err) {
      logger?.error("Failed to remove running.json on clean close.", { error: err });
    }
  }

  return {
    getRunningPath: () => runningPath,
    getCurrentRecord: () => currentRecord,
    inspectPreviousSession,
    startSession,
    updateSnapshot,
    recordEvent,
    markCleanClose,
  };
}

module.exports = {
  createSessionJournal,
};
