# Contrato de Integración: LEAF Electron Shell ↔ POS Awesome (ERPNext v14)

Este documento describe el contrato técnico entre la carcasa de escritorio (**LEAF | PUNTO DE VENTA LOCAL**) y la aplicación web **POS Awesome** (`Grintsys/POS-Awesome-14`) en el servidor ERPNext v14.

---

## 1. Contrato en el Navegador (Renderer)

### 1.1 API expuesta por Electron (`window.leafShell`)

Expuesta mediante `contextBridge` (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`) en [`preload.js`](preload.js):

```js
window.leafShell = {
  version: "<package.json version>",
  platform: process.platform,
  printUrl({ url, deviceName }) => Promise<{ ok: boolean, printer?: string, error?: string | null }>,
  reportSnapshot(snapshot) => void,
  getContractInfo() => { shellVersion: string, supportedContract: ["1.0"] }
}
```

> **Compatibilidad temporal:** `window.asteroid` se mantiene como alias con `onKeyEvent`, `printUrl`, `reportSnapshot` y `getContractInfo` para las versiones actuales de POS Awesome que aún usan `window.asteroid.printUrl`.

### 1.2 Contrato esperado de POS Awesome (`window.leafPos`)

POS Awesome debe publicar en `window`:

```js
window.leafPos = {
  contract: "1.0",
  getSnapshot() {
    return {
      hasPendingItems: boolean,
      itemsCount: number,
      pendingTotal: number,
      currency: string,
      invoiceName: string | null,
      hasOpenShift: boolean,
      shiftName: string | null,
      posProfile: string | null,
      user: string | null,
      capturedAt: string // ISO-8601
    };
  },
  async canClose() {
    return {
      allowed: boolean,
      reason: "pending_items" | "open_shift" | null,
      message: string
    };
  }
};
```

Se recomienda además llamar a `window.leafShell?.reportSnapshot(window.leafPos.getSnapshot())` cada vez que cambie el carrito o el estado del turno. Mientras POS Awesome actualiza ese hook, la carcasa también consulta `getSnapshot()` cada 2 segundos y ante eventos `storage`.

### 1.3 Respaldo temporal si `window.leafPos` no existe

Si la página aún no define `window.leafPos`:
- La carcasa evalúa `Number(localStorage.getItem("totalPrice")) > 0` para detectar ítems pendientes y registra una advertencia en el log.
- No se usa `window.cur_pos` ni `pos_invoice_items`.

### 1.4 Llaves de `localStorage`

- **Llaves preservadas (NUNCA se borran al arrancar ni al recargar):**
  - `totalPrice`
  - `items_storage`
  - `customer_storage`
  - `sales_partners_storage`
- **Llaves limpiadas selectivamente (`clearLock` en `custom-asteroid.js`):**
  - `pos_tab_id`, `pos_active_tab`, `pos_open_tab`, `pos_open`, `pos_page_open`, `posawesome_pos_tab`, `point-of-sale`, `pos_channel`.

---

## 2. Diario Local de Sesión (`running.json`)

Ubicación: `<userData>/session/running.json`  
Llave HMAC: `<userData>/session/hmac.key` (cifrada con `Electron safeStorage`).

### Formato en disco

```json
{
  "payload": {
    "sessionId": "uuid-v4",
    "startedAt": "2026-11-25T07:00:00.000Z",
    "lastSeenAt": "2026-11-25T07:05:10.000Z",
    "appVersion": "2.0.0",
    "machineName": "CAJA-01",
    "state": "running",
    "lastSnapshot": { ... },
    "lastEvent": null
  },
  "hmac": "<hex-hmac-sha256>"
}
```

### Ciclo de vida

1. **Inicio:** Se inspecciona `running.json` antes de crear la nueva sesión:
   - Si no existe o tiene `state: "closed"` con HMAC válido → arranque normal.
   - Si tiene `state: "running"` con HMAC válido → cierre inesperado (`reason = lastEvent || "unknown"`).
   - Si el JSON está corrupto o el HMAC no coincide → cierre inesperado con `reason = "tampered"`.
2. **En ejecución:** Escritura atómica (archivo temporal + `rename`) cada 5 segundos y en cada snapshot nuevo (con límite de 1 escritura/segundo).
3. **Eventos críticos:** `render-process-gone`, `child-process-gone`, `unresponsive`, `uncaughtException`, `unhandledRejection`, `session-end` y `shutdown` se graban síncronamente antes de reaccionar.
4. **Cierre normal autorizado:** Se escribe `state: "closed"` y se elimina `running.json`.

---

## 3. Evento al Servidor (`register_unexpected_close`)

### Endpoint

`POST /api/method/posawesome.posawesome.api.posapp.register_unexpected_close`

Realizado desde el proceso principal usando la sesión autenticada de Electron (`sid`).

### Payload JSON

```json
{
  "client_session_id": "uuid-v4",
  "pos_profile": "Caja Principal",
  "pos_opening_shift": "POS-OPEN-2026-0001",
  "invoice_name": null,
  "pending_total": 1250,
  "currency": "L",
  "items_count": 3,
  "last_seen_at": "2026-11-25T07:05:10.000Z",
  "detected_at": "2026-11-25T07:06:00.000Z",
  "reason": "unknown",
  "machine_name": "CAJA-01",
  "app_version": "2.0.0"
}
```

### Idempotencia y cola local (`outbox.json`)

- El servidor debe garantizar idempotencia usando `client_session_id`.
- Se espera opcionalmente en la respuesta `{ message: { voucher_number, server_time } }` (con respaldo a cabecera HTTP `Date` y número local `LOCAL-AAAAMMDD-HHMMSS`).
- Ante error de red, HTTP 404 o HTTP 500, el evento permanece en `<userData>/session/outbox.json` y se reintenta al iniciar y cada 60 segundos.

---

## 4. Acoplamiento DOM heredado (Pendiente de migración en POS Awesome)

Las siguientes funciones en `custom-asteroid.js` mantienen selectores DOM mientras POS Awesome expone APIs dedicadas:
- Detección de pantalla de pago (`arePaymentButtonsVisible` buscando botones `VALIDAR`, `VALIDAR/IMPRIMIR`, `CANCELAR`).
- Enfoque de campo cantidad y búsqueda por selectores (`input[placeholder*="Buscar"]`, `.input-group.qty input`).

## 5. Punto de extensión de autorización de supervisor

En `src/security.js`, `verifySupervisor({ pin, config })` valida el hash scrypt local configurado durante el setup. Puede sustituirse por verificación de usuario/contraseña contra el servidor sin modificar el flujo de bloqueo de cierre.
