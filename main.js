const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow; // ✅ Declaramos mainWindow

const configPath = path.join(app.getPath('userData'), 'config.json');
console.log("Config path (for debugging):", configPath);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    resizable: false,
    center: true,
    title: 'POS Awesome - Caja',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true
    }
  });

  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log("Config cargada:", config);

    mainWindow.loadURL(`${config.url}`);

    mainWindow.webContents.once('did-finish-load', () => {
      console.log("POS cargado");
      const scriptPath = path.join(__dirname, "custom-asteroid.js");
      const customScript = fs.readFileSync(scriptPath, "utf8");

      mainWindow.webContents.executeJavaScript(customScript)
        .then(() => console.log("✅ Script personalizado inyectado"))
        .catch(err => console.error("❌ Error al inyectar script:", err));

      // ✅ Abre DevTools automáticamente
      mainWindow.webContents.openDevTools();
    });

  } else {
    console.log("Mostrando setup.html");
    mainWindow.loadFile('setup.html');

    // ✅ También abre DevTools si aún no hay config
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.openDevTools();
    });
  }

  // Atajos personalizados
  globalShortcut.register('F5', () => {
    mainWindow.webContents.send('tecla-cambiar-cantidad');
  });

  globalShortcut.register('F3', () => {
    mainWindow.webContents.send('tecla-cancelar-factura');
  });

  globalShortcut.register('F4', () => {
    console.log("F4 PRESIONADA");
    mainWindow.webContents.send('tecla-eliminar-producto');
  });

  globalShortcut.register('F10', () => {
    mainWindow.webContents.send('tecla-totalizar');
  });

  globalShortcut.register('F9', () => {
    mainWindow.webContents.send('tecla-aceptar-factura');
  });

  globalShortcut.register('F8', () => {
    mainWindow.webContents.send('tecla-aceptar-factura');
  });

  globalShortcut.register('CommandOrControl+F4', () => {
    mainWindow.webContents.send('tecla-manejo-efectivo');
  });
}

// Guardar config
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

process.on('uncaughtException', err => {
  console.error("Error no capturado:", err);
});
