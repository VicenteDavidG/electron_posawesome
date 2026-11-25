const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { safeStorage } = require("electron");

const SCRYPT_PREFIX = "scrypt";

/**
 * Write a file atomically via a temporary file and rename.
 */
function atomicWriteFileSync(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, data, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

/**
 * Encrypt a plaintext secret using Electron safeStorage.
 * Never falls back to plaintext storage.
 */
function encryptSecret(plaintext) {
  if (typeof plaintext !== "string") {
    throw new Error("Secret must be a string.");
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Electron safeStorage encryption is not available on this system.");
  }
  const encryptedBuffer = safeStorage.encryptString(plaintext);
  return encryptedBuffer.toString("base64");
}

/**
 * Decrypt a base64 cipher string produced by encryptSecret.
 */
function decryptSecret(base64Cipher) {
  if (!base64Cipher || typeof base64Cipher !== "string") {
    return "";
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Electron safeStorage encryption is not available on this system.");
  }
  const buffer = Buffer.from(base64Cipher, "base64");
  return safeStorage.decryptString(buffer);
}

/**
 * Hash a PIN with a random 16-byte salt using scrypt.
 */
function hashPin(pin) {
  const normalized = String(pin || "");
  if (!normalized) {
    throw new Error("PIN cannot be empty.");
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(normalized, salt, 64).toString("hex");
  return `${SCRYPT_PREFIX}:${salt}:${derived}`;
}

/**
 * Verify a candidate PIN against a stored scrypt hash in constant time.
 */
function verifyPin(pin, storedHash) {
  if (!pin || typeof storedHash !== "string") return false;
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== SCRYPT_PREFIX) return false;
  const [, salt, expectedHex] = parts;
  if (!salt || !expectedHex) return false;

  try {
    const derived = crypto.scryptSync(String(pin), salt, 64);
    const expected = Buffer.from(expectedHex, "hex");
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * Load or generate a 32-byte HMAC key encrypted with safeStorage.
 */
function getOrCreateHmacKey(sessionDir) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const keyPath = path.join(sessionDir, "hmac.key");

  if (fs.existsSync(keyPath)) {
    const cipherB64 = fs.readFileSync(keyPath, "utf8").trim();
    const keyHex = decryptSecret(cipherB64);
    const keyBuffer = Buffer.from(keyHex, "hex");
    if (keyBuffer.length === 32) {
      return keyBuffer;
    }
  }

  const newKey = crypto.randomBytes(32);
  const cipherB64 = encryptSecret(newKey.toString("hex"));
  atomicWriteFileSync(keyPath, cipherB64);
  return newKey;
}

/**
 * Deterministic JSON serialization with sorted object keys for HMAC signing.
 */
function canonicalStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalStringify(item)).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const entries = keys
    .filter((k) => value[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Sign a JSON-serializable payload with HMAC-SHA256.
 */
function signPayload(dataObj, hmacKey) {
  const canonical = canonicalStringify(dataObj);
  const hmac = crypto.createHmac("sha256", hmacKey).update(canonical, "utf8").digest("hex");
  return {
    payload: dataObj,
    hmac,
  };
}

/**
 * Verify an envelope { payload, hmac } against an HMAC-SHA256 key.
 */
function verifyPayload(envelope, hmacKey) {
  if (!envelope || typeof envelope !== "object" || !envelope.payload || typeof envelope.hmac !== "string") {
    return false;
  }
  try {
    const canonical = canonicalStringify(envelope.payload);
    const expectedHex = crypto.createHmac("sha256", hmacKey).update(canonical, "utf8").digest("hex");
    const actualBuf = Buffer.from(envelope.hmac, "hex");
    const expectedBuf = Buffer.from(expectedHex, "hex");
    if (actualBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Extension point for supervisor authorization.
 * Currently checks the installation-local Supervisor PIN hash.
 * Can be replaced later with server-side supervisor credential verification.
 */
async function verifySupervisor({ pin, config }) {
  if (!config || !config.supervisorPinHash) {
    return {
      ok: false,
      method: "pin",
      reason: "PIN de supervisor no configurado en esta instalación.",
    };
  }
  const matched = verifyPin(pin, config.supervisorPinHash);
  return {
    ok: matched,
    method: "pin",
    reason: matched ? null : "PIN de supervisor incorrecto.",
  };
}

module.exports = {
  atomicWriteFileSync,
  encryptSecret,
  decryptSecret,
  hashPin,
  verifyPin,
  getOrCreateHmacKey,
  canonicalStringify,
  signPayload,
  verifyPayload,
  verifySupervisor,
};
