const { net } = require("electron");

/**
 * Normalize headers lookup for Electron net.request responses.
 */
function buildHeaderGetter(rawHeaders = {}) {
  const lowerMap = new Map();
  for (const [k, v] of Object.entries(rawHeaders)) {
    lowerMap.set(k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v));
  }
  return {
    get(name) {
      return lowerMap.get(String(name || "").toLowerCase()) ?? null;
    },
  };
}

/**
 * Perform an HTTP request bound to a specific Electron session.
 * Prefers session.fetch when available (Electron 28+) and falls back to net.request.
 */
async function sessionFetch(targetSession, url, options = {}) {
  const timeoutMs = typeof options.timeoutMs === "number" ? options.timeoutMs : 8000;
  const method = (options.method || "GET").toUpperCase();
  const headers = options.headers || {};
  const body = options.body;

  if (targetSession && typeof targetSession.fetch === "function") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await targetSession.fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const req = net.request({
      url,
      method,
      session: targetSession,
      useSessionCookies: true,
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          req.abort();
        } catch {
          // ignore
        }
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    for (const [key, value] of Object.entries(headers)) {
      req.setHeader(key, value);
    }

    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const textBody = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode || 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage || "",
          headers: buildHeaderGetter(res.headers),
          async text() {
            return textBody;
          },
          async json() {
            return JSON.parse(textBody);
          },
        });
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    if (body !== undefined && body !== null) {
      req.write(typeof body === "string" ? body : String(body));
    }
    req.end();
  });
}

module.exports = {
  sessionFetch,
};
