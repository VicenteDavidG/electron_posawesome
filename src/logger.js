const fs = require("fs");
const path = require("path");

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_ROTATED_FILES = 5;
const SENSITIVE_KEY_PATTERN = /pass|pin|clave|secret|hmac/i;

/**
 * Recursively redact sensitive keys before writing log metadata.
 */
function sanitizeValue(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = "[REDACTED]";
      } else {
        out[key] = sanitizeValue(val, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * Rotate log files when the active log exceeds MAX_LOG_BYTES.
 */
function rotateLogsIfNeeded(logPath) {
  try {
    if (!fs.existsSync(logPath)) return;
    const stats = fs.statSync(logPath);
    if (stats.size < MAX_LOG_BYTES) return;

    const oldest = `${logPath}.${MAX_ROTATED_FILES}`;
    if (fs.existsSync(oldest)) {
      fs.unlinkSync(oldest);
    }
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const src = `${logPath}.${i}`;
      const dst = `${logPath}.${i + 1}`;
      if (fs.existsSync(src)) {
        fs.renameSync(src, dst);
      }
    }
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // Avoid throwing from logger rotation
  }
}

/**
 * Create a rotating file logger under <userData>/logs/leaf-pos.log.
 */
function createLogger(userDataDir) {
  const logsDir = path.join(userDataDir, "logs");
  const logPath = path.join(logsDir, "leaf-pos.log");

  const writeEntry = (level, message, meta) => {
    const timestamp = new Date().toISOString();
    let suffix = "";
    if (meta !== undefined) {
      try {
        suffix = " " + JSON.stringify(sanitizeValue(meta));
      } catch {
        suffix = " [unserializable metadata]";
      }
    }
    const line = `[${timestamp}] [${level}] ${message}${suffix}\n`;

    try {
      fs.mkdirSync(logsDir, { recursive: true });
      rotateLogsIfNeeded(logPath);
      fs.appendFileSync(logPath, line, "utf8");
    } catch {
      // Fallback silently to console if filesystem write fails
    }

    if (level === "ERROR") {
      console.error(line.trimEnd());
    } else if (level === "WARN") {
      console.warn(line.trimEnd());
    } else {
      console.log(line.trimEnd());
    }
  };

  return {
    getLogPath: () => logPath,
    info: (message, meta) => writeEntry("INFO", message, meta),
    warn: (message, meta) => writeEntry("WARN", message, meta),
    error: (message, meta) => writeEntry("ERROR", message, meta),
  };
}

module.exports = {
  createLogger,
  sanitizeValue,
};
