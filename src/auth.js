const { sessionFetch } = require("./http");
const { validateServerUrl } = require("./config");

/**
 * Validate URL format and test HTTP reachability against the configured server.
 */
async function testServerUrl({ url, targetSession, timeoutMs = 6000 }) {
  const validation = validateServerUrl(url);
  if (!validation.valid) {
    return { ok: false, url: null, status: 0, error: validation.error };
  }

  try {
    const res = await sessionFetch(targetSession, validation.url, {
      method: "GET",
      headers: { Accept: "text/html,application/json" },
      timeoutMs,
    });

    if (res.status >= 200 && res.status < 500) {
      return { ok: true, url: validation.url, status: res.status, error: null };
    }

    return {
      ok: false,
      url: validation.url,
      status: res.status,
      error: `El servidor respondió con error HTTP ${res.status}.`,
    };
  } catch (err) {
    return {
      ok: false,
      url: validation.url,
      status: 0,
      error: `No se pudo conectar con el servidor (${err?.message || err}).`,
    };
  }
}

/**
 * Perform Frappe/ERPNext session login from the main process so credentials
 * never enter the renderer context or DOM.
 */
async function loginToServer({ serverUrl, username, password, targetSession, logger, timeoutMs = 8000 }) {
  if (!serverUrl || !username || !password || !targetSession) {
    return { ok: false, skipped: true, status: 0, error: null };
  }

  let origin;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return { ok: false, skipped: false, status: 0, error: "URL de servidor inválida." };
  }

  const loginUrl = `${origin}/api/method/login`;
  try {
    const res = await sessionFetch(targetSession, loginUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ usr: username, pwd: password }),
      timeoutMs,
    });

    const serverDate = res.headers?.get?.("date") || null;
    if (res.ok) {
      logger?.info("Main-process server login succeeded.", { status: res.status });
      return { ok: true, skipped: false, status: res.status, serverDate, error: null };
    }

    logger?.warn("Main-process server login failed.", { status: res.status });
    return {
      ok: false,
      skipped: false,
      status: res.status,
      serverDate,
      error: `Inicio de sesión rechazado (HTTP ${res.status}).`,
    };
  } catch (err) {
    logger?.warn("Main-process server login network error.", { error: err });
    return {
      ok: false,
      skipped: false,
      status: 0,
      serverDate: null,
      error: String(err?.message || err),
    };
  }
}

module.exports = {
  testServerUrl,
  loginToServer,
};
