const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

const configPath = path.join(app.getPath('userData'), 'config.json');
console.log("Config path (for debugging):", configPath);

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
      devTools: false
    }
  });

  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log("Config cargada:", config);

    win.loadURL(`${config.url}`);

    // Ejecuta el JS personalizado al cargar el POS
    win.webContents.once('did-finish-load', () => {
      console.log("POS cargado");
      const scriptPath = path.join(__dirname, "custom-asteroid.js");
      const customScript = fs.readFileSync(scriptPath, "utf8");

      // Inyectar directamente el script JS
      win.webContents.executeJavaScript(customScript)
        .then(() => console.log("Script personalizado inyectado"))
        .catch(err => console.error("Error al inyectar script:", err));
    });

  } else {
    console.log("Mostrando setup.html");
    win.loadFile('setup.html');
  }

  // Atajos de teclado personalizados (ASTEROID POS)

  globalShortcut.register('F3', () => {
    win.webContents.send('tecla-cancelar-factura');
  });

  globalShortcut.register('F4', () => {
    win.webContents.send('tecla-eliminar-producto');
  });

  globalShortcut.register('F5', () => {
    win.webContents.send('tecla-cambiar-cantidad');
  });

  globalShortcut.register('F10', () => {
    win.webContents.send('tecla-totalizar');
  });

  globalShortcut.register('F8', () => {
    win.webContents.send('tecla-validar-factura');
  });

  // Validar e imprimir (desde payments.vue)
  globalShortcut.register('F9', () => {
    win.webContents.send('tecla-validar-imprimir');
  });

  globalShortcut.register('CommandOrControl+F4', () => {
    win.webContents.send('tecla-manejo-efectivo');
  });
}

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
