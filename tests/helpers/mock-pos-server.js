const http = require("http");

/**
 * Start a lightweight local HTTP server simulating ERPNext + POS Awesome
 * with window.leafPos contract, login endpoint, and register_unexpected_close endpoint.
 */
function createMockPosServer() {
  const loginCalls = [];
  const unexpectedCloseCalls = [];
  let unexpectedCloseMode = "ok"; // "ok" | "500" | "404"

  const renderLoginHtml = () => `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Login Mock</title></head>
<body>
  <h1>ERPNext Login</h1>
  <form id="login-form" method="GET" action="/pos">
    <input id="usr" name="usr" />
    <button id="login-btn" type="submit">Entrar</button>
  </form>
</body>
</html>`;

  const renderPosHtml = () => `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>POS Awesome Mock</title></head>
<body>
  <h1>POS Awesome</h1>
  <div id="shortcut-log"></div>
  <button>VALIDAR</button>
  <button>VALIDAR/IMPRIMIR</button>
  <button>CANCELAR</button>
  <input type="search" placeholder="Buscar producto" />
  <script>
    window.__leafTestState = {
      hasPendingItems: false,
      itemsCount: 0,
      pendingTotal: 0,
      currency: "L",
      invoiceName: null,
      hasOpenShift: false,
      shiftName: null,
      posProfile: "Caja Principal",
      user: "cajero1@leaf.local",
      hangCanClose: false,
      receivedShortcuts: []
    };

    window.leafPos = {
      contract: "1.0",
      getSnapshot() {
        return {
          hasPendingItems: window.__leafTestState.hasPendingItems,
          itemsCount: window.__leafTestState.itemsCount,
          pendingTotal: window.__leafTestState.pendingTotal,
          currency: window.__leafTestState.currency,
          invoiceName: window.__leafTestState.invoiceName,
          hasOpenShift: window.__leafTestState.hasOpenShift,
          shiftName: window.__leafTestState.shiftName,
          posProfile: window.__leafTestState.posProfile,
          user: window.__leafTestState.user,
          capturedAt: new Date().toISOString()
        };
      },
      async canClose() {
        if (window.__leafTestState.hangCanClose) {
          return new Promise(() => {});
        }
        if (window.__leafTestState.hasPendingItems) {
          return {
            allowed: false,
            reason: "pending_items",
            message: "Hay productos sin facturar en el carrito."
          };
        }
        if (window.__leafTestState.hasOpenShift) {
          return {
            allowed: false,
            reason: "open_shift",
            message: "Debe hacer el cierre de caja antes de salir."
          };
        }
        return { allowed: true, reason: null, message: "" };
      }
    };

    if (window.asteroid && typeof window.asteroid.onKeyEvent === "function") {
      window.asteroid.onKeyEvent((key) => {
        window.__leafTestState.receivedShortcuts.push(key);
        const log = document.getElementById("shortcut-log");
        if (log) log.textContent = window.__leafTestState.receivedShortcuts.join(",");
      });
    }
  </script>
</body>
</html>`;

  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, "http://127.0.0.1");

    if (req.method === "POST" && parsed.pathname === "/api/method/login") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          loginCalls.push(JSON.parse(body));
        } catch {
          loginCalls.push(body);
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": "sid=mock-session-id; Path=/; HttpOnly",
        });
        res.end(JSON.stringify({ message: "Logged In" }));
      });
      return;
    }

    if (
      req.method === "POST" &&
      parsed.pathname ===
        "/api/method/posawesome.posawesome.api.posapp.register_unexpected_close"
    ) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (unexpectedCloseMode === "500") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ exc: "Simulated 500" }));
          return;
        }
        if (unexpectedCloseMode === "404") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ exc: "Not Found" }));
          return;
        }
        const parsedBody = JSON.parse(body);
        unexpectedCloseCalls.push(parsedBody);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            message: {
              voucher_number: `SRV-${unexpectedCloseCalls.length}`,
              server_time: new Date().toISOString(),
            },
          })
        );
      });
      return;
    }

    if (parsed.pathname === "/login") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLoginHtml());
      return;
    }

    if (parsed.pathname === "/printview") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<html><body><p>Factura Impresa</p></body></html>");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderPosHtml());
  });

  return {
    start(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => {
          const addr = server.address();
          resolve(`http://127.0.0.1:${addr.port}`);
        });
      });
    },
    stop() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    getLoginCalls: () => loginCalls,
    getUnexpectedCloseCalls: () => unexpectedCloseCalls,
    clearCalls: () => {
      loginCalls.length = 0;
      unexpectedCloseCalls.length = 0;
    },
    setUnexpectedCloseMode: (mode) => {
      unexpectedCloseMode = mode;
    },
  };
}

module.exports = {
  createMockPosServer,
};
