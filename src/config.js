const fs = require("fs");
const path = require("path");
const { atomicWriteFileSync, encryptSecret } = require("./security");

/**
 * Resolve config.json path inside Electron userData directory.
 */
function getConfigPath(userDataDir) {
  return path.join(userDataDir, "config.json");
}

/**
 * Validate and normalize an HTTP/HTTPS server URL.
 */
function validateServerUrl(rawUrl) {
  const input = String(rawUrl || "").trim();
  if (!input) {
    return { valid: false, url: null, error: "Debe ingresar la URL del servidor." };
  }
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, url: null, error: "La URL debe comenzar con http:// o https://." };
    }
    return { valid: true, url: parsed.toString(), error: null };
  } catch {
    return { valid: false, url: null, error: "La URL del servidor no tiene un formato válido." };
  }
}

/**
 * Verify that a print URL uses http/https and shares the exact origin of configuredUrl.
 */
function isAllowedPrintUrl(targetUrl, configuredUrl) {
  if (!targetUrl || !configuredUrl) return false;
  try {
    const target = new URL(String(targetUrl));
    const base = new URL(String(configuredUrl));
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return false;
    }
    return target.origin === base.origin;
  } catch {
    return false;
  }
}

/**
 * Load config.json, normalizing defaults and migrating legacy plaintext fields.
 */
function loadConfig(userDataDir, logger) {
  const configPath = getConfigPath(userDataDir);
  if (!fs.existsSync(configPath)) return null;

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  let dirty = false;

  const normalized = {
    url: String(raw.url || "").trim(),
    username: String(raw.username || raw.usuario || "").trim(),
    passwordEncrypted: raw.passwordEncrypted || "",
    supervisorPinHash: raw.supervisorPinHash || "",
    hardResetPinHash: raw.hardResetPinHash || "",
    blockOnPendingItems:
      typeof raw.blockOnPendingItems === "boolean"
        ? raw.blockOnPendingItems
        : typeof raw.policy?.blockOnPendingItems === "boolean"
          ? raw.policy.blockOnPendingItems
          : true,
    blockOnOpenShift:
      typeof raw.blockOnOpenShift === "boolean"
        ? raw.blockOnOpenShift
        : typeof raw.policy?.blockOnOpenShift === "boolean"
          ? raw.policy.blockOnOpenShift
          : true,
  };

  if (raw.usuario !== undefined) dirty = true;

  // Migrate legacy plaintext credentials immediately
  const legacyPassword = raw.password || raw.clave;
  if (typeof legacyPassword === "string" && legacyPassword.length > 0) {
    if (!normalized.passwordEncrypted) {
      normalized.passwordEncrypted = encryptSecret(legacyPassword);
    }
    dirty = true;
    logger?.warn("Legacy plaintext password migrated to safeStorage encryption.");
  }

  if (raw.password !== undefined || raw.clave !== undefined) {
    dirty = true;
  }

  if (dirty) {
    atomicWriteFileSync(configPath, JSON.stringify(normalized, null, 2));
  }

  return normalized;
}

/**
 * Persist config.json atomically without leaving plaintext secrets on disk.
 */
function saveConfig(userDataDir, config) {
  const configPath = getConfigPath(userDataDir);
  const sanitized = {
    url: String(config.url || "").trim(),
    username: String(config.username || "").trim(),
    passwordEncrypted: String(config.passwordEncrypted || ""),
    supervisorPinHash: String(config.supervisorPinHash || ""),
    hardResetPinHash: String(config.hardResetPinHash || ""),
    blockOnPendingItems: config.blockOnPendingItems !== false,
    blockOnOpenShift: config.blockOnOpenShift !== false,
  };
  atomicWriteFileSync(configPath, JSON.stringify(sanitized, null, 2));
  return sanitized;
}

module.exports = {
  getConfigPath,
  validateServerUrl,
  isAllowedPrintUrl,
  loadConfig,
  saveConfig,
};
