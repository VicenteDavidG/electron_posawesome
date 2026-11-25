# Changelog

## [2.0.0] - 2026-11-25

### Agregado
- **Guardia real de cierre y recarga (`src/close-guard.js`)**:
  - Consulta `window.leafPos.canClose()` con tiempo máximo de 3 segundos y respaldo al último `reportSnapshot` en memoria (y respaldo temporal `localStorage.totalPrice`).
  - Bloqueo por productos pendientes (`blockOnPendingItems`) y por turno de caja abierto (`blockOnOpenShift`), configurables en `config.json`.
  - Salida de emergencia con cuadro nativo en español y verificación de PIN de supervisor (`verifySupervisor()`).
  - Bloqueo de recarga manual (`Ctrl+R`, `Ctrl+Shift+R`, menú Ver), `Ctrl+W`, `Alt+F4`, `will-prevent-unload` y `will-navigate`.
  - Manejo de apagado del sistema (`session-end` en Windows, `powerMonitor` `shutdown` en macOS/Linux) sin vetar el cierre del SO.
- **Diario de sesión y recuperación ante cierres inesperados (`src/journal.js`, `src/outbox.js`, `src/voucher.js`)**:
  - Registro firmado con HMAC-SHA256 (`safeStorage`) en `session/running.json` con escritura atómica cada 5s y en cambios de estado.
  - Detección automática al iniciar (incluyendo manipulación `tampered`) y notificación modal bloqueante en español (`unexpected-close-dialog.html`).
  - Generación e impresión silenciosa de vale térmico de 80 mm (`VALE - CIERRE INESPERADO DETECTADO`), con cola de reintento local (`voucher-queue.json`).
  - Cola persistente e idempotente (`outbox.json`) para `register_unexpected_close` con reintento al inicio y cada 60 segundos.
  - Recuperación ante `render-process-gone`, `unresponsive`, `child-process-gone`, `uncaughtException` y `unhandledRejection` con log rotativo (`logs/leaf-pos.log`).
- **Contrato y API (`preload.js`)**:
  - Exposición de `window.leafShell` (`version`, `platform`, `printUrl`, `reportSnapshot`, `getContractInfo`) manteniendo `window.asteroid` como alias temporal.
- **Pruebas y documentación**:
  - Suite automatizada con Playwright (`tests/leaf-pos.spec.js`) y servidor simulado (`tests/helpers/mock-pos-server.js`).
  - Documentación técnica en `INTEGRATION.md`.

### Cambiado
- **Seguridad y estabilidad**:
  - `nodeIntegration: false`, `contextIsolation: true` y `sandbox: true` en todas las ventanas (incluyendo diálogo de PIN `pin-dialog.html`, setup `setup.html` y diálogo de cierre inesperado).
  - Eliminado `globalShortcut`; atajos de teclado limitados a la ventana enfocada mediante `before-input-event`.
  - Re-inyección automática de `custom-asteroid.js` en cada `did-finish-load` validando el origen configurado.
  - Eliminado el borrado de `localStorage` al arrancar, preservando `totalPrice`, `items_storage`, `customer_storage` y `sales_partners_storage`.
  - Autenticación movida al proceso principal (`POST /api/method/login` en `src/auth.js`) con clave cifrada mediante `safeStorage`, eliminando `window.asteroid_config`.
  - Eliminado el PIN fijo `246813`; PIN de supervisor y PIN de Hard Reset configurables por instalación con hash `scrypt`.
  - `requestSingleInstanceLock()` finaliza inmediatamente con `process.exit(0)` en instancias duplicadas.
  - `leaf:print-url` valida que el origen coincida con la URL configurada.
  - `setup.html` limpiado y dotado de prueba de conexión antes de guardar.
- **Empaquetado y plataforma**:
  - Actualizado Electron, `electron-builder` y configurado `electron-updater` para GitHub Releases.
  - Exclusión de `test_logic.html`, `.vscode`, `tests/` y documentación en `build.files`.
