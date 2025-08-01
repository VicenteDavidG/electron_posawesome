const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

const configPath = path.join(app.getPath('userData'), 'config.json');
console.log("Config path (for debugging):", configPath);

// ✅ Bloquear múltiples instancias
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: false,
    center: true,
    title: 'POS Awesome - Caja',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false  // 🚫 Oculta herramientas de desarrollo (F12 bloqueado también abajo)
    }
  });

  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log("Config cargada:", config);

    win.loadURL(`${config.url}`);

    win.webContents.once('did-finish-load', () => {
      console.log("POS cargado");
      const scriptPath = path.join(__dirname, "custom-asteroid.js");
      const customScript = fs.readFileSync(scriptPath, "utf8");

      win.webContents.executeJavaScript(customScript)
        .then(() => console.log("✅ Script personalizado inyectado"))
        .catch(err => console.error("❌ Error al inyectar script:", err));
    });

  } else {
    console.log("Mostrando setup.html");
    win.loadFile('setup.html');
  }

  // ✅ Bloquear acceso a herramientas de desarrollo
  win.webContents.on('before-input-event', (event, input) => {
    const key = input.key.toLowerCase();
    const isDevShortcut = (key === 'i' && input.control && input.shift) || key === 'f12';
    if (isDevShortcut) {
      event.preventDefault();
    }
  });

  // ✅ Deshabilitar menú contextual (clic derecho)
  win.webContents.on('context-menu', (e) => {
    e.preventDefault();
  });

  // ✅ Atajos de teclado personalizados
  globalShortcut.register('F3', () => {
    win.webContents.send('tecla-cancelar-factura');
  });

  globalShortcut.register('F4', () => {
    win.webContents.send('tecla-eliminar-producto');
  });

  globalShortcut.register('F5', () => {
    win.webContents.send('tecla-cambiar-cantidad');
  });

  globalShortcut.register('F8', () => {
    win.webContents.send('tecla-validar-factura');
  });

  globalShortcut.register('F9', () => {
    win.webContents.send('tecla-validar-imprimir');
  });

  globalShortcut.register('F10', () => {
    win.webContents.send('tecla-totalizar');
  });

  globalShortcut.register('CommandOrControl+F4', () => {
    win.webContents.send('tecla-manejo-efectivo');
  });
}

// ✅ Guardar configuración
ipcMain.on('guardar-config', (event, config) => {
  console.log("Guardando config en:", configPath);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log("Config guardada");

  app.relaunch();
  app.exit();
});

app.whenReady().then(createWindow);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// ✅ Captura errores inesperados
process.on('uncaughtException', err => {
  console.error("Error no capturado:", err);
});
