// ==============================
//  LEAF - POS Local
//  custom-asteroid.js
// ==============================

// --- Anti-lock: limpia banderas de "otra pestaña activa"
(() => {
  try {
    [
      'pos_tab_id', 'pos_active_tab', 'pos_open_tab',
      'pos_open', 'pos_page_open', 'posawesome_pos_tab',
      'point-of-sale', 'pos_channel'
    ].forEach(k => localStorage.removeItem(k));
    if (sessionStorage?.clear) sessionStorage.clear();
  } catch { }
})();

console.log("custom-asteroid.js cargado");

// Aviso por carrito pendiente
window.addEventListener('load', () => {
  const carrito = localStorage.getItem('pos_invoice_items');
  if (carrito && carrito !== '[]') {
    alert('Hay productos pendientes del cierre anterior. Se generará un vale de recuperación.');
  }
});

// ====================
// Atajos vía Asteroid
// ====================
if (window.asteroid) {
  window.asteroid.onKeyEvent((tecla) => {
    const fire = (k, opts = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
    if (tecla === 'tecla-cancelar-factura') fire('k', { ctrlKey: true });               // F3 → Ctrl+K
    if (tecla === 'tecla-eliminar-producto') fire('d', { ctrlKey: true });              // F4 → Ctrl+D
    if (tecla === 'tecla-cambiar-cantidad') fire('a', { ctrlKey: true, shiftKey: true });// F5 → Ctrl+Shift+A
    if (tecla === 'tecla-totalizar') fire('s', { ctrlKey: true });               // F10 → Ctrl+S
    if (tecla === 'tecla-validar-factura') fire('x', { ctrlKey: true });               // F8 (si lo usas)

    // Helper para detectar si estamos en la pantalla de pago
    const isPaymentWindowActive = () => {
      // 1. Selectores de clase (existentes + posibles nuevos)
      const classSelector = '.payments, .v-card.selection .v-btn, .payment-container, .pos-payment-component';
      const paymentEl = document.querySelector(classSelector);
      if (paymentEl && paymentEl.offsetParent !== null) return true;

      // 2. Detección por texto en botones (VALIDAR, VALIDAR/IMPRIMIR) - Visible
      // Busca botones que contengan "VALIDAR" en su texto
      const buttons = Array.from(document.querySelectorAll('button'));
      const hasValidarBtn = buttons.some(b => {
        if (!b.offsetParent) return false; // Debe ser visible
        const txt = (b.innerText || '').toUpperCase();
        return txt.includes('VALIDAR') || txt.includes('VALIDATE') || txt.includes('IMPRIMIR') || txt.includes('PRINT');
      });
      if (hasValidarBtn) return true;

      // 3. Detección por input característico "Notas adicionales"
      const noteInput = document.querySelector('input[placeholder*="Notas adicionales"], textarea[placeholder*="Notas adicionales"]');
      if (noteInput && noteInput.offsetParent !== null) return true;

      return false;
    };

    // F9: Validar + Imprimir (Solo si está en pantalla de pago)
    if (tecla === 'tecla-validar-imprimir') {
      if (isPaymentWindowActive()) {
        fire('a', { ctrlKey: true });
      } else {
        console.log('F9 ignorado: No se detectó la pantalla de pago activa.');
      }
    }
  });

  // Manejo de intento de cierre (Prevenir si hay items)
  window.asteroid.onCheckCartStatus(() => {
    let hasItems = false;

    // 1. Intentar ver objeto global de POS (ERPNext v14)
    try {
      if (window.cur_pos && window.cur_pos.cart && window.cur_pos.cart.items && window.cur_pos.cart.items.length > 0) {
        hasItems = true;
      }
    } catch (e) { }

    // 2. Fallback: localStorage
    if (!hasItems) {
      const stored = localStorage.getItem('pos_invoice_items');
      if (stored && stored !== '[]') {
        hasItems = true;
      }
    }

    if (hasItems) {
      // Bloquear
      alert('⚠️ NO PUEDES CERRAR: Hay productos en el carrito de venta.\n\nPor favor, completa la venta o elimina los items para salir.');
      window.asteroid.sendCartStatusResponse(false);
    } else {
      // Permitir
      window.asteroid.sendCartStatusResponse(true);
    }
  });
} else {
  console.warn("asteroid API no disponible");
}

// ============================
// Barra superior de atajos UI
// ============================
(() => {
  try {
    if (!window.asteroid) return;
    if (document.getElementById('pos-shortcuts-bar')) return;

    const CFG = {
      height: 40, width: '850px', top: 0, align: 'left', side: 0,
      r: 0, padX: 10, gap: 5, font: 'system-ui,-apple-system,Segoe UI,Roboto,Arial',
      fz: 12, btnH: 24, btnPadX: 10, btnR: 8,
      barBg: '#111', barFg: '#f3f3f3', btnBg: 'rgba(255,255,255,.08)', btnBgH: 'rgba(255,255,255,.16)',
      btnBd: '1px solid rgba(255,255,255,.18)', sh: '0 2px 10px rgba(0,0,0,.35)', z: 99999
    };

    const bar = document.createElement('div');
    bar.id = 'pos-shortcuts-bar';
    let left = '50%', right = 'auto', tx = 'translateX(-50%)';
    if (CFG.align === 'left') { left = CFG.side + 'px'; tx = 'none'; }
    if (CFG.align === 'right') { left = 'auto'; right = CFG.side + 'px'; tx = 'none'; }
    Object.assign(bar.style, {
      position: 'fixed', top: CFG.top + 'px', left, right, transform: tx,
      height: CFG.height + 'px', width: CFG.width, display: 'flex', alignItems: 'center',
      gap: CFG.gap + 'px', padding: `0 ${CFG.padX}px`, fontFamily: CFG.font, fontSize: CFG.fz + 'px',
      background: CFG.barBg, color: CFG.barFg, zIndex: String(CFG.z), boxShadow: CFG.sh, borderRadius: CFG.r + 'px'
    });

    const mkBtn = (txt, ttl, fn) => {
      const b = document.createElement('button'); b.textContent = txt; b.title = ttl || txt;
      Object.assign(b.style, {
        height: CFG.btnH + 'px', lineHeight: CFG.btnH + 'px', padding: `0 ${CFG.btnPadX}px`,
        border: CFG.btnBd, borderRadius: CFG.btnR + 'px', background: CFG.btnBg, color: CFG.barFg,
        cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap'
      }); b.onmouseenter = () => b.style.background = CFG.btnBgH;
      b.onmouseleave = () => b.style.background = CFG.btnBg; b.onclick = fn; return b;
    };

    const sendKey = ({ key, ctrl = false, shift = false }) => {
      const U = (key || '').toUpperCase(); const code = /^[A-Z]$/.test(U) ? `Key${U}` : /^[0-9]$/.test(key) ? `Digit${key}` : `Key${U}`;
      const base = { key, code, keyCode: U.charCodeAt(0) || 0, which: U.charCodeAt(0) || 0, ctrlKey: !!ctrl, shiftKey: !!shift, bubbles: true, cancelable: true };
      window.dispatchEvent(new KeyboardEvent('keydown', base));
      document.dispatchEvent(new KeyboardEvent('keydown', base));
      window.dispatchEvent(new KeyboardEvent('keyup', base));
      document.dispatchEvent(new KeyboardEvent('keyup', base));
    };

    // Reutilizamos la lógica de detección si es posible, o duplicamos la lógica básica
    const isPaymentActive = () => {
      // 1. Selectores de clase
      const classSelector = '.payments, .v-card.selection .v-btn, .payment-container, .pos-payment-component';
      const paymentEl = document.querySelector(classSelector);
      if (paymentEl && paymentEl.offsetParent !== null) return true;

      // 2. Botones (VALIDAR / IMPRIMIR)
      const buttons = Array.from(document.querySelectorAll('button'));
      const hasValidarBtn = buttons.some(b => {
        if (!b.offsetParent) return false;
        const txt = (b.innerText || '').toUpperCase();
        return txt.includes('VALIDAR') || txt.includes('VALIDATE') || txt.includes('IMPRIMIR') || txt.includes('PRINT');
      });
      if (hasValidarBtn) return true;

      // 3. Inputs
      const noteInput = document.querySelector('input[placeholder*="Notas adicionales"], textarea[placeholder*="Notas adicionales"]');
      if (noteInput && noteInput.offsetParent !== null) return true;

      return false;
    };

    bar.appendChild(mkBtn('F3 | Cancelar', 'Cancelar (Ctrl+K)', () => sendKey({ key: 'k', ctrl: true })));
    bar.appendChild(mkBtn('F4 | Eliminar ítem', 'Eliminar ítem (Ctrl+D)', () => sendKey({ key: 'd', ctrl: true })));
    bar.appendChild(mkBtn('F5 | Cantidad', 'Cambiar cantidad (Ctrl+Shift+A)', () => sendKey({ key: 'a', ctrl: true, shift: true })));
    bar.appendChild(mkBtn('F9 | Validar + Imp', 'Validar e imprimir (Ctrl+A)', () => {
      // Validar que estemos en pago
      if (isPaymentActive()) {
        sendKey({ key: 'a', ctrl: true });
      } else {
        console.log('Botón F9 ignorado: No estamos en pago');
      }
    }));
    bar.appendChild(mkBtn('F10 | Totalizar', 'Totalizar (Ctrl+S)', () => sendKey({ key: 's', ctrl: true })));

    const toggle = mkBtn('▲', 'Ocultar/mostrar barra', () => {
      const hide = bar.getAttribute('data-collapsed') === '1'; const next = !hide; bar.setAttribute('data-collapsed', next ? '1' : '0');
      [...bar.children].forEach(c => { if (c !== toggle) c.style.display = next ? 'none' : ''; }); toggle.textContent = next ? '▼' : '▲';
    });
    toggle.style.marginLeft = 'auto'; toggle.style.minWidth = '26px'; bar.appendChild(toggle);
    document.body.appendChild(bar);
  } catch (e) { console.error('Error en barra superior:', e); }
})();

// ================================================
// LEAF | Búsqueda estricta (prefijo) con panel UI
// + robusto: MutationObserver + captura global
// ================================================
(() => {
  const SLEEP = ms => new Promise(r => setTimeout(r, ms));
  let handling = false, panel = null, panelList = [], highlighted = -1;
  let searchInput = null; // se actualizará dinámicamente

  // ---------- UI panel ----------
  const ensurePanel = (anchor) => {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'absolute', maxHeight: '320px', overflowY: 'auto',
      background: '#111', color: '#f3f3f3',
      border: '1px solid rgba(255,255,255,.2)', borderRadius: '8px',
      boxShadow: '0 8px 24px rgba(0,0,0,.35)', zIndex: 999999,
      fontFamily: 'system-ui,-apple-system,Segoe UI,Roboto,Arial', fontSize: '12px'
    });
    document.body.appendChild(panel);
    return panel;
  };
  const placePanel = (anchor) => {
    const r = anchor.getBoundingClientRect();
    panel.style.left = r.left + 'px';
    panel.style.top = (r.bottom + 6 + window.scrollY) + 'px';
    panel.style.minWidth = Math.max(r.width, 280) + 'px';
  };
  const clearPanel = () => { highlighted = -1; panelList = []; if (panel?.parentNode) panel.parentNode.removeChild(panel); panel = null; };
  const highlight = (idx) => { highlighted = idx; if (!panel) return;[...panel.children].forEach((row, i) => row.style.background = i === idx ? 'rgba(255,255,255,.10)' : 'transparent'); };
  const renderPanel = (anchor, items, onPick) => {
    panelList = items.slice(0, 50);
    const p = ensurePanel(anchor); placePanel(anchor); p.innerHTML = '';
    if (!panelList.length) { const d = document.createElement('div'); d.textContent = 'Sin resultados por prefijo'; d.style.padding = '10px'; d.style.opacity = '.8'; p.appendChild(d); return; }
    panelList.forEach((it, idx) => {
      const row = document.createElement('div'); row.dataset.idx = String(idx);
      Object.assign(row.style, { padding: '10px 12px', cursor: 'pointer', display: 'grid', gridTemplateColumns: '120px 1fr', gap: '10px' });
      row.onmouseenter = () => highlight(idx);
      row.onclick = () => onPick(it);
      const code = document.createElement('div'); code.textContent = it.item_code || it.name || ''; code.style.fontWeight = '600';
      const name = document.createElement('div'); name.textContent = it.item_name || it.description || ''; name.style.opacity = '.9';
      row.appendChild(code); row.appendChild(name); p.appendChild(row);
    });
    highlight(-1);
  };

  // ---------- Backend helpers ----------
  const getStrictFlag = async () => {
    try {
      const profile = (window.cur_pos && (window.cur_pos.pos_profile?.name || window.cur_pos.pos_profile))
        || frappe?.defaults?.get_default?.('pos_profile');
      if (!profile) return false;
      const r = await frappe.db.get_value('POS Profile', profile, ['strict_search']);
      return !!(r?.message?.strict_search);
    } catch { return false; }
  };
  const quickLookup = async (term) => {
    try { const r = await frappe.call({ method: 'posawesome.api.search.quick_lookup', args: { term } }); return r?.message || {}; }
    catch { return {}; }
  };
  const prefixSearch = async (term, limit = 30) => {
    try { const r = await frappe.call({ method: 'posawesome.api.search.items_prefix', args: { term, limit } }); return r?.message || []; }
    catch { return []; }
  };
  const addItemToCart = async (item_code) => {
    try {
      if (window.cur_pos && typeof window.cur_pos.add_to_cart === 'function') { window.cur_pos.add_to_cart({ item_code }); return true; }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', ctrlKey: true, bubbles: true }));
      return true;
    } catch { return false; }
  };

  // ---------- Input detection + rebinding ----------
  const findSearchInput = () => {
    const sels = [
      'input[placeholder*="Buscar"]',
      'input[placeholder*="producto"]',
      'input[type="search"]',
      '.v-text-field__slot input',
      'input.pos-search'
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  };

  const bindToInput = (el) => {
    if (!el || el === searchInput) return;
    searchInput = el;
    console.log(' LEAF: input de búsqueda detectado/reasignado', el);

    // Cerrar panel al click fuera
    document.addEventListener('click', (e) => {
      if (!panel) return;
      if (e.target === searchInput) return;
      if (panel.contains(e.target)) return;
      clearPanel();
    });

    // Bloquear búsqueda “en vivo” cuando strict=ON y no hay %
    const blockLive = async (e, keyName = 'input') => {
      const term = (searchInput.value || '').trim();
      const hasPercent = term.includes('%');
      const strict = hasPercent ? false : await getStrictFlag();
      if (strict) {
        e.stopImmediatePropagation();
        searchInput.setAttribute('title', 'Modo estricto: presiona Enter para buscar por prefijo');
        if (!term) clearPanel();
        // Nota: 'input' no es cancelable, pero detener propagación en captura suele bastar.
      } else {
        searchInput.removeAttribute('title');
      }
    };
    searchInput.addEventListener('input', blockLive, { capture: true });
    searchInput.addEventListener('keyup', async (e) => { if (e.key !== 'Enter') await blockLive(e, 'keyup'); }, { capture: true });
  };

  // Observa el DOM por si Vue recrea el input
  const mo = new MutationObserver(() => {
    const el = findSearchInput();
    if (el) bindToInput(el);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // ---------- Captura global de teclado (Enter) ----------
  document.addEventListener('keydown', async (ev) => {
    // Solo nos interesa si el foco está en el input
    if (!searchInput || document.activeElement !== searchInput) return;

    // Navegación del panel
    if (panel) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); highlight(Math.min(highlighted + 1, panelList.length - 1)); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); highlight(Math.max(highlighted - 1, -1)); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); clearPanel(); return; }
      if (ev.key === 'Enter' && highlighted >= 0) {
        ev.preventDefault();
        const pick = panelList[highlighted];
        clearPanel();
        await addItemToCart(pick.item_code || pick.name);
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    }

    if (ev.key !== 'Enter') return;
    if (handling) return;
    handling = true;

    try {
      let term = (searchInput.value || '').trim();
      if (!term) { handling = false; return; }

      // 1) Exacto → carrito
      const exact = await quickLookup(term);
      if (exact.item_code) {
        ev.preventDefault(); ev.stopImmediatePropagation();
        await addItemToCart(exact.item_code);
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        clearPanel(); handling = false; return;
      }

      // 2) Estricto por defecto si no hay %
      const forceClassic = term.includes('%');
      const strict = forceClassic ? false : await getStrictFlag();

      if (strict) {
        if (term.length < 3) {
          ev.preventDefault(); ev.stopImmediatePropagation();
          frappe.show_alert?.({ message: __("Escribe al menos 3 caracteres para búsqueda por prefijo."), indicator: "orange" });
          handling = false; return;
        }
        const list = await prefixSearch(term, 30);
        if (list.length > 0) {
          ev.preventDefault(); ev.stopImmediatePropagation();
          renderPanel(searchInput, list, async (it) => {
            clearPanel(); await addItemToCart(it.item_code || it.name);
            searchInput.value = '';
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
          });
          handling = false; return;
        }
        // Fallback clásico → %term%
        ev.preventDefault(); ev.stopImmediatePropagation();
        term = `%${term}%`;
        searchInput.value = term;
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        handling = false;
        // Simula Enter para que el POS procese su búsqueda clásica
        const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
        searchInput.dispatchEvent(e);
        return;
      }

      // 3) Clásico (o usuario ya puso %): dejamos pasar
      handling = false; return;

    } catch (err) {
      console.error('LEAF strict search error:', err);
      handling = false;
    }
  }, { capture: true });

  // Primer bind (por si ya está montado)
  const tryBind = async () => {
    for (let i = 0; i < 50 && !searchInput; i++) {
      const el = findSearchInput();
      if (el) { bindToInput(el); break; }
      await SLEEP(200);
    }
    if (!searchInput) console.warn('LEAF: no pude encontrar el input de búsqueda del POS.');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tryBind);
  else tryBind();
})();
