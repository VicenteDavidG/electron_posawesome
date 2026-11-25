const { test, expect, _electron: electron } = require("@playwright/test");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createMockPosServer } = require("./helpers/mock-pos-server");

const APP_ROOT = path.resolve(__dirname, "..");

function makeScryptPinHash(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(pin), salt, 64).toString("hex");
  return `scrypt:${salt}:${derived}`;
}

function createTempUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "leaf-pos-test-"));
}

function writeTestConfig(userDataDir, overrides = {}) {
  const cfg = {
    url: overrides.url,
    username: overrides.username ?? "cajero1",
    passwordEncrypted: overrides.passwordEncrypted ?? "",
    supervisorPinHash: makeScryptPinHash(overrides.supervisorPin || "1234"),
    hardResetPinHash: makeScryptPinHash(overrides.hardResetPin || "5678"),
    blockOnPendingItems:
      typeof overrides.blockOnPendingItems === "boolean"
        ? overrides.blockOnPendingItems
        : true,
    blockOnOpenShift:
      typeof overrides.blockOnOpenShift === "boolean"
        ? overrides.blockOnOpenShift
        : true,
  };
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, "config.json"),
    JSON.stringify(cfg, null, 2),
    "utf8"
  );
  return cfg;
}

async function launchLeafApp(userDataDir, extraEnv = {}) {
  const cleanEnv = { ...process.env };
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  return electron.launch({
    args: [APP_ROOT],
    env: {
      ...cleanEnv,
      LEAF_USER_DATA_DIR: userDataDir,
      LEAF_TEST_MODE: "1",
      ...extraEnv,
    },
  });
}

async function stubMessageBox(electronApp, responseIndex = 0) {
  await electronApp.evaluate(({ dialog }, idx) => {
    global.__leafCapturedDialogs = [];
    dialog.showMessageBox = async (_win, options) => {
      global.__leafCapturedDialogs.push(options);
      return { response: idx, checkboxChecked: false };
    };
  }, responseIndex);
}

async function getCapturedDialogs(electronApp) {
  return electronApp.evaluate(() => global.__leafCapturedDialogs || []);
}

async function sendWindowKey(electronApp, keyCode, modifiers = []) {
  await electronApp.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) return;
      win.focus();
      win.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: payload.keyCode,
        modifiers: payload.modifiers,
      });
      win.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: payload.keyCode,
        modifiers: payload.modifiers,
      });
    },
    { keyCode, modifiers }
  );
}

async function safeRemoveDir(dirPath) {
  fs.rmSync(dirPath, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

test.describe("LEAF | Punto de Venta Local - Acceptance Suite", () => {
  let mockServer;
  let baseUrl;

  test.beforeEach(async () => {
    mockServer = createMockPosServer();
    baseUrl = await mockServer.start();
  });

  test.afterEach(async () => {
    await mockServer.stop();
  });

  test("AC1: blocks Alt+F4, X close, menu Salir, Ctrl+R, Ctrl+Shift+R, and F5 reload when cart has items", async () => {
    const userDataDir = createTempUserDataDir();
    writeTestConfig(userDataDir, { url: `${baseUrl}/pos` });

    const app = await launchLeafApp(userDataDir);
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(() => Boolean(window.leafPos && window.__leafInjected));

      await stubMessageBox(app, 0);

      // Put test items in cart
      await page.evaluate(() => {
        window.__leafTestState.hasPendingItems = true;
        window.__leafTestState.itemsCount = 2;
        window.__leafTestState.pendingTotal = 1250;
      });
      // Wait for snapshot reporter to sync
      await page.waitForTimeout(2300);

      // 1) Alt+F4
      await sendWindowKey(app, "F4", ["alt"]);
      await page.waitForTimeout(250);

      // 2) Window X button (win.close())
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].close();
      });
      await page.waitForTimeout(250);

      // 3) Menu Salir
      await app.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu();
        const fileMenu = menu.items.find((i) => i.label === "Archivo");
        const salirItem = fileMenu.submenu.items.find((i) => i.label === "Salir");
        salirItem.click();
      });
      await page.waitForTimeout(250);

      // 4) Ctrl+R (or Meta+R on macOS)
      const mod = process.platform === "darwin" ? "meta" : "control";
      await sendWindowKey(app, "R", [mod]);
      await page.waitForTimeout(250);

      // 5) Ctrl+Shift+R
      await sendWindowKey(app, "R", [mod, "shift"]);
      await page.waitForTimeout(250);

      // 6) F5 triggers quantity shortcut, never reloads page
      await page.evaluate(() => {
        window.__leafDidNotReloadMarker = "still-alive";
      });
      await sendWindowKey(app, "F5");
      await page.waitForTimeout(250);

      const marker = await page.evaluate(() => window.__leafDidNotReloadMarker);
      const shortcuts = await page.evaluate(
        () => window.__leafTestState.receivedShortcuts
      );
      expect(marker).toBe("still-alive");
      expect(shortcuts).toContain("tecla-cambiar-cantidad");

      const dialogs = await getCapturedDialogs(app);
      expect(dialogs.length).toBeGreaterThanOrEqual(5);
      for (const dlg of dialogs) {
        const fullText = `${dlg.title} ${dlg.message} ${dlg.detail || ""}`;
        expect(fullText).toContain("Hay productos sin facturar");
      }
      expect(app.process().killed).toBe(false);
    } finally {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
      await safeRemoveDir(userDataDir);
    }
  });

  test("AC2: blocks close on open shift with empty cart when policy=true, allows when policy=false", async () => {
    // Part 1: blockOnOpenShift = true
    const dir1 = createTempUserDataDir();
    writeTestConfig(dir1, { url: `${baseUrl}/pos`, blockOnOpenShift: true });

    const app1 = await launchLeafApp(dir1);
    try {
      const page1 = await app1.firstWindow();
      await page1.waitForFunction(() => Boolean(window.leafPos && window.__leafInjected));
      await stubMessageBox(app1, 0);

      await page1.evaluate(() => {
        window.__leafTestState.hasPendingItems = false;
        window.__leafTestState.hasOpenShift = true;
        window.__leafTestState.shiftName = "POS-SHIFT-01";
      });
      await page1.waitForTimeout(300);

      await app1.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].close();
      });
      await page1.waitForTimeout(300);

      const dialogs = await getCapturedDialogs(app1);
      expect(dialogs.length).toBe(1);
      expect(dialogs[0].message).toContain("Debe hacer el cierre de caja antes de salir");
    } finally {
      await app1.evaluate(({ app }) => app.exit(0)).catch(() => {});
      fs.rmSync(dir1, { recursive: true, force: true });
    }

    // Part 2: blockOnOpenShift = false
    const dir2 = createTempUserDataDir();
    writeTestConfig(dir2, { url: `${baseUrl}/pos`, blockOnOpenShift: false });

    const app2 = await launchLeafApp(dir2);
    try {
      const page2 = await app2.firstWindow();
      await page2.waitForFunction(() => Boolean(window.leafPos && window.__leafInjected));
      await stubMessageBox(app2, 0);

      await page2.evaluate(() => {
        window.__leafTestState.hasPendingItems = false;
        window.__leafTestState.hasOpenShift = true;
        window.__leafTestState.shiftName = "POS-SHIFT-02";
      });
      await page2.waitForTimeout(300);

      const exitPromise = new Promise((resolve) => app2.on("close", () => resolve(true)));
      await app2.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].close();
      });
      const exited = await exitPromise;
      expect(exited).toBe(true);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  test("AC3: unresponsive page times out under 4s and allows emergency supervisor PIN exit", async () => {
    const userDataDir = createTempUserDataDir();
    writeTestConfig(userDataDir, {
      url: `${baseUrl}/pos`,
      supervisorPin: "4321",
    });

    const app = await launchLeafApp(userDataDir);
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => Boolean(window.leafPos && window.__leafInjected));

      // Stub messageBox to choose "Salir de todos modos..." (button index 1)
      await stubMessageBox(app, 1);

      await page.evaluate(() => {
        window.__leafTestState.hangCanClose = true;
      });

      const started = Date.now();
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].close();
      });

      // Wait for modal PIN dialog window to appear
      let pinWin = null;
      for (let i = 0; i < 45; i++) {
        const wins = app.windows();
        pinWin = wins.find((w) => w.url().includes("pin-dialog.html"));
        if (pinWin) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const elapsedMs = Date.now() - started;

      expect(pinWin).toBeTruthy();
      expect(elapsedMs).toBeLessThan(4000);

      const dialogs = await getCapturedDialogs(app);
      expect(dialogs.length).toBe(1);
      expect(dialogs[0].buttons[1]).toContain("Salir de todos modos");

      const exitPromise = new Promise((resolve) => app.on("close", () => resolve(true)));
      await pinWin.fill("#pin-input", "4321");
      await pinWin.click("#confirm-btn");
      expect(await exitPromise).toBe(true);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("AC4: detects forced kill with L 1250.00 cart, prints/queues voucher, and detects tampered running.json", async () => {
    const userDataDir = createTempUserDataDir();
    writeTestConfig(userDataDir, { url: `${baseUrl}/pos` });

    // Session 1: populate cart with L 1,250.00 and kill process with SIGKILL
    const app1 = await launchLeafApp(userDataDir, {
      LEAF_TEST_PRINT_MODE: "mock-ok",
    });
    const page1 = await app1.firstWindow();
    await page1.waitForFunction(() => Boolean(window.leafPos && window.__leafInjected));

    await page1.evaluate(() => {
      window.__leafTestState.hasPendingItems = true;
      window.__leafTestState.itemsCount = 3;
      window.__leafTestState.pendingTotal = 1250;
      window.__leafTestState.currency = "L";
      window.__leafTestState.shiftName = "SHIFT-99";
    });

    // Wait for running.json to persist the 1250 snapshot
    const runningPath = path.join(userDataDir, "session", "running.json");
    await expect
      .poll(
        () => {
          if (!fs.existsSync(runningPath)) return 0;
          const data = JSON.parse(fs.readFileSync(runningPath, "utf8"));
          return data?.payload?.lastSnapshot?.pendingTotal || 0;
        },
        { timeout: 5000 }
      )
      .toBe(1250);

    const pid = app1.process().pid;
    process.kill(pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 400));

    // Session 2: restart and verify unexpected-close modal + printed voucher
    const app2 = await launchLeafApp(userDataDir, {
      LEAF_TEST_PRINT_MODE: "mock-ok",
    });
    try {
      const dialogWin = await app2.firstWindow();
      await dialogWin.waitForLoadState("domcontentloaded");
      await expect(dialogWin.locator("h2")).toContainText(
        "Se detectó un cierre inesperado de la sesión anterior"
      );
      await expect(dialogWin.locator("#amount")).toContainText("L 1250.00");
      await expect(dialogWin.locator("#continue-btn")).toBeEnabled();

      const printedHtmlPath = path.join(
        userDataDir,
        "session",
        "last-printed-voucher.html"
      );
      expect(fs.existsSync(printedHtmlPath)).toBe(true);
      const printedHtml = fs.readFileSync(printedHtmlPath, "utf8");
      expect(printedHtml).toContain("VALE - CIERRE INESPERADO DETECTADO");
      expect(printedHtml).toContain("L 1250.00");
      expect(printedHtml).toContain("Firma del supervisor");

      const closePromise = dialogWin.waitForEvent("close").catch(() => {});
      await dialogWin.click("#continue-btn");
      await closePromise;

      // Wait for POS window to load and running.json to be created
      await expect
        .poll(() => fs.existsSync(runningPath), { timeout: 5000 })
        .toBe(true);

      // Tamper test: modify running.json manually while app2 runs, then kill and restart
      const runningRaw = JSON.parse(fs.readFileSync(runningPath, "utf8"));
      runningRaw.payload.lastSnapshot = {
        ...(runningRaw.payload.lastSnapshot || {}),
        hasPendingItems: true,
        itemsCount: 1,
        pendingTotal: 9999,
        currency: "L",
      };
      fs.writeFileSync(runningPath, JSON.stringify(runningRaw, null, 2), "utf8");
      process.kill(app2.process().pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 400));

      const app3 = await launchLeafApp(userDataDir, {
        LEAF_TEST_PRINT_MODE: "mock-fail",
      });
      try {
        const tamperDialog = await app3.firstWindow();
        await expect(tamperDialog.locator("#reason")).toContainText("tampered");
        await expect(tamperDialog.locator("#retry-btn")).toBeVisible();
        await expect(tamperDialog.locator("#continue-btn")).toBeEnabled();
        const queueFile = path.join(userDataDir, "session", "voucher-queue.json");
        expect(fs.existsSync(queueFile)).toBe(true);
      } finally {
        await app3.evaluate(({ app }) => app.exit(0)).catch(() => {});
      }
    } finally {
      await app2.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await new Promise((r) => setTimeout(r, 200));
      await safeRemoveDir(userDataDir);
    }
  });

  test("AC5: offline unexpected close queues in outbox and delivers once idempotently when server returns", async () => {
    const userDataDir = createTempUserDataDir();
    // Stop server to simulate offline environment
    await mockServer.stop();
    const deadPortUrl = "http://127.0.0.1:59999/pos";
    writeTestConfig(userDataDir, { url: deadPortUrl });

    // Seed an unclosed running.json via app1 then kill
    const app1 = await launchLeafApp(userDataDir, {
      LEAF_TEST_PRINT_MODE: "mock-ok",
    });
    const win1 = await app1.firstWindow();
    await win1.waitForTimeout(400);
    process.kill(app1.process().pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 400));

    // Relaunch offline -> incident queued in outbox.json
    const app2 = await launchLeafApp(userDataDir, {
      LEAF_TEST_PRINT_MODE: "mock-ok",
    });
    const offlineDialog = await app2.firstWindow();
    await expect(offlineDialog.locator("#continue-btn")).toBeEnabled();
    await offlineDialog.click("#continue-btn");

    const outboxPath = path.join(userDataDir, "session", "outbox.json");
    expect(fs.existsSync(outboxPath)).toBe(true);
    const queued = JSON.parse(fs.readFileSync(outboxPath, "utf8"));
    expect(queued.length).toBe(1);
    const sessionId = queued[0].client_session_id;

    await app2.evaluate(({ app }) => app.exit(0)).catch(() => {});

    // Bring server back online on a fresh port and update config url, then launch app3
    mockServer = createMockPosServer();
    baseUrl = await mockServer.start();
    const cfgPath = path.join(userDataDir, "config.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.url = `${baseUrl}/pos`;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");

    // Clean running.json so app3 starts cleanly and flushes outbox
    const runningPath = path.join(userDataDir, "session", "running.json");
    if (fs.existsSync(runningPath)) fs.unlinkSync(runningPath);

    const app3 = await launchLeafApp(userDataDir, {
      LEAF_TEST_PRINT_MODE: "mock-ok",
    });
    try {
      await expect
        .poll(() => mockServer.getUnexpectedCloseCalls().length, { timeout: 6000 })
        .toBe(1);

      const calls = mockServer.getUnexpectedCloseCalls();
      expect(calls[0].client_session_id).toBe(sessionId);

      // Wait for outbox.json to empty
      await expect
        .poll(
          () => JSON.parse(fs.readFileSync(outboxPath, "utf8")).length,
          { timeout: 4000 }
        )
        .toBe(0);
    } finally {
      await app3.evaluate(({ app }) => app.exit(0)).catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("AC6: normal clean close with empty cart and closed shift removes running.json and shows no warning on restart", async () => {
    const userDataDir = createTempUserDataDir();
    writeTestConfig(userDataDir, { url: `${baseUrl}/pos` });

    const app1 = await launchLeafApp(userDataDir);
    const page1 = await app1.firstWindow();
    await page1.waitForFunction(() => Boolean(window.leafPos && window.__leafInjected));

    const exitPromise = new Promise((resolve) => app1.on("close", () => resolve(true)));
    await app1.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close();
    });
    expect(await exitPromise).toBe(true);

    const runningPath = path.join(userDataDir, "session", "running.json");
    expect(fs.existsSync(runningPath)).toBe(false);

    const app2 = await launchLeafApp(userDataDir);
    try {
      const page2 = await app2.firstWindow();
      await page2.waitForLoadState("domcontentloaded");
      expect(page2.url()).toContain("/pos");
      expect(app2.windows().some((w) => w.url().includes("unexpected-close"))).toBe(false);
    } finally {
      await app2.evaluate(({ app }) => app.exit(0)).catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("AC7: shortcuts survive login navigation and allowed reload, and localStorage keys are preserved", async () => {
    const userDataDir = createTempUserDataDir();
    writeTestConfig(userDataDir, { url: `${baseUrl}/login` });

    const app = await launchLeafApp(userDataDir);
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => Boolean(window.__leafInjected));

      // Seed POS Awesome localStorage keys before reload
      await page.evaluate(() => {
        localStorage.setItem("totalPrice", "0");
        localStorage.setItem("items_storage", '[{"item_code":"A1"}]');
        localStorage.setItem("customer_storage", '{"name":"Cliente"}');
      });

      // Navigate through login form -> /pos
      await page.click("#login-btn");
      await page.waitForURL("**/pos**");
      await page.waitForFunction(() => Boolean(window.__leafInjected && window.leafShell));

      await sendWindowKey(app, "F10");
      await page.waitForTimeout(250);
      let shortcuts = await page.evaluate(
        () => window.__leafTestState.receivedShortcuts
      );
      expect(shortcuts).toContain("tecla-totalizar");

      // Allowed reload (empty cart & closed shift)
      await page.reload();
      await page.waitForFunction(() => Boolean(window.__leafInjected && window.leafShell));

      await sendWindowKey(app, "F3");
      await page.waitForTimeout(250);
      shortcuts = await page.evaluate(
        () => window.__leafTestState.receivedShortcuts
      );
      expect(shortcuts).toContain("tecla-cancelar-factura");

      // Verify POS Awesome localStorage keys were preserved across reload
      const stored = await page.evaluate(() => ({
        items: localStorage.getItem("items_storage"),
        customer: localStorage.getItem("customer_storage"),
      }));
      expect(stored.items).toBe('[{"item_code":"A1"}]');
      expect(stored.customer).toBe('{"name":"Cliente"}');
    } finally {
      await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
      await safeRemoveDir(userDataDir);
    }
  });

  test("AC8 & print-url origin check: password never reaches page, logs, or plaintext config; foreign print URLs blocked", async () => {
    const userDataDir = createTempUserDataDir();
    const secretPassword = "SuperSecretPassword!99";

    // Configure via setup.html flow first
    const setupApp = await launchLeafApp(userDataDir);
    const setupPage = await setupApp.firstWindow();
    await setupPage.waitForLoadState("domcontentloaded");

    await setupPage.fill("#url", `${baseUrl}/pos`);
    await setupPage.fill("#username", "cajero_seguro");
    await setupPage.fill("#password", secretPassword);
    await setupPage.fill("#supervisor-pin", "1122");
    await setupPage.fill("#supervisor-pin-confirm", "1122");
    await setupPage.fill("#hard-reset-pin", "3344");
    await setupPage.fill("#hard-reset-pin-confirm", "3344");

    // Override app.relaunch so setup exits cleanly without spawning orphan process
    await setupApp.evaluate(({ app }) => {
      app.relaunch = () => {};
    });

    const exitPromise = new Promise((resolve) =>
      setupApp.on("close", () => resolve(true))
    );
    await setupPage.click("#save-btn");
    expect(await exitPromise).toBe(true);

    const configRaw = fs.readFileSync(path.join(userDataDir, "config.json"), "utf8");
    expect(configRaw).not.toContain(secretPassword);
    expect(configRaw).not.toContain("1122");
    expect(configRaw).not.toContain("3344");
    const parsedCfg = JSON.parse(configRaw);
    expect(parsedCfg.passwordEncrypted).toBeTruthy();
    expect(parsedCfg.supervisorPinHash.startsWith("scrypt:")).toBe(true);
    expect(parsedCfg.hardResetPinHash.startsWith("scrypt:")).toBe(true);

    // Relaunch configured app -> verify main-process login & zero secret exposure
    const posApp = await launchLeafApp(userDataDir);
    try {
      const page = await posApp.firstWindow();
      await page.waitForFunction(() => Boolean(window.leafShell && window.__leafInjected));

      expect(mockServer.getLoginCalls().length).toBe(1);
      expect(mockServer.getLoginCalls()[0]).toEqual({
        usr: "cajero_seguro",
        pwd: secretPassword,
      });

      const pageCheck = await page.evaluate((secret) => {
        const hasAsteroidConfig = typeof window.asteroid_config !== "undefined";
        const bodyHasSecret = document.documentElement.innerHTML.includes(secret);
        const shellInfo = window.leafShell.getContractInfo();
        return { hasAsteroidConfig, bodyHasSecret, shellInfo };
      }, secretPassword);

      expect(pageCheck.hasAsteroidConfig).toBe(false);
      expect(pageCheck.bodyHasSecret).toBe(false);
      expect(pageCheck.shellInfo.supportedContract).toContain("1.0");

      // Log file must not contain password
      const logContent = fs.readFileSync(
        path.join(userDataDir, "logs", "leaf-pos.log"),
        "utf8"
      );
      expect(logContent).not.toContain(secretPassword);

      // Verify printUrl blocks foreign origin
      const badPrint = await page.evaluate(() =>
        window.leafShell.printUrl({ url: "http://evil.example/printview" })
      );
      expect(badPrint.ok).toBe(false);
      expect(badPrint.error).toContain("no autorizado");
    } finally {
      await posApp.evaluate(({ app }) => app.exit(0)).catch(() => {});
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
