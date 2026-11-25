// ==============================
//  LEAF | Local POS Helper
//  custom-asteroid.js
// ==============================
(() => {
  if (window.__leafInjected) return;
  window.__leafInjected = true;

  const shellApi = window.leafShell || window.asteroid;
  const keyBridge = window.asteroid;

  // Targeted multi-tab lock cleanup ONLY.
  // Never removes totalPrice, items_storage, customer_storage, or sales_partners_storage.
  const TAB_LOCK_KEYS = [
    "pos_tab_id",
    "pos_active_tab",
    "pos_open_tab",
    "pos_open",
    "pos_page_open",
    "posawesome_pos_tab",
    "point-of-sale",
    "pos_channel",
  ];

  const clearLock = () => {
    try {
      for (const key of TAB_LOCK_KEYS) {
        localStorage.removeItem(key);
      }
    } catch {
      // ignore storage errors
    }
  };

  clearLock();
  setInterval(clearLock, 2000);

  // ============================
  // Snapshot monitoring (leafPos + totalPrice fallback)
  // ============================
  let warnedMissingContract = false;
  let lastSerializedSnapshot = "";

  const readSnapshot = () => {
    if (window.leafPos && typeof window.leafPos.getSnapshot === "function") {
      try {
        const snap = window.leafPos.getSnapshot();
        if (snap && typeof snap === "object") {
          return snap;
        }
      } catch (err) {
        console.warn("LEAF: leafPos.getSnapshot() threw an error:", err);
      }
    } else if (!warnedMissingContract) {
      warnedMissingContract = true;
      console.warn(
        "LEAF: window.leafPos not found; using temporary localStorage.totalPrice fallback."
      );
    }

    const totalPrice = Number(localStorage.getItem("totalPrice")) || 0;
    return {
      hasPendingItems: totalPrice > 0,
      itemsCount: totalPrice > 0 ? 1 : 0,
      pendingTotal: totalPrice,
      currency: "",
      invoiceName: null,
      hasOpenShift: false,
      shiftName: null,
      posProfile: null,
      user: null,
      capturedAt: new Date().toISOString(),
    };
  };

  const publishSnapshotIfChanged = (force = false) => {
    if (!shellApi || typeof shellApi.reportSnapshot !== "function") return;
    const snap = readSnapshot();
    const compareKey = JSON.stringify({
      hasPendingItems: Boolean(snap.hasPendingItems),
      itemsCount: Number(snap.itemsCount || 0),
      pendingTotal: Number(snap.pendingTotal || 0),
      currency: snap.currency || "",
      invoiceName: snap.invoiceName || null,
      hasOpenShift: Boolean(snap.hasOpenShift),
      shiftName: snap.shiftName || null,
      posProfile: snap.posProfile || null,
      user: snap.user || null,
    });
    if (force || compareKey !== lastSerializedSnapshot) {
      lastSerializedSnapshot = compareKey;
      shellApi.reportSnapshot(snap);
    }
  };

  publishSnapshotIfChanged(true);
  window.addEventListener("storage", () => publishSnapshotIfChanged(false));
  setInterval(() => publishSnapshotIfChanged(false), 2000);

  // ============================
  // Focused shortcuts via preload IPC
  // ============================
  const arePaymentButtonsVisible = () => {
    const buttons = document.getElementsByTagName("button");
    let hasValidar = false;
    let hasValidarImprimir = false;
    let hasCancelar = false;

    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      const txt = (btn.textContent || btn.innerText || "").toUpperCase().trim();
      const visible = Boolean(
        btn.offsetWidth || btn.offsetHeight || btn.getClientRects().length
      );
      if (!visible) continue;

      if (!hasValidar && txt === "VALIDAR") {
        hasValidar = true;
      } else if (
        !hasValidarImprimir &&
        (txt === "VALIDAR/IMPRIMIR" || txt.includes("VALIDAR/IMPRIMIR"))
      ) {
        hasValidarImprimir = true;
      } else if (!hasCancelar && txt === "CANCELAR") {
        hasCancelar = true;
      }

      if (hasValidar && hasValidarImprimir && hasCancelar) return true;
    }
    return false;
  };

  const findSearchInput = () => {
    const selectors = [
      'input[placeholder*="Buscar"]',
      'input[placeholder*="producto"]',
      'input[type="search"]',
      ".v-text-field__slot input",
      "input.pos-search",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  };

  window.handleQuantityFocus = (dispatch = true) => {
    if (dispatch) {
      const eventOpts = {
        key: "A",
        code: "KeyA",
        keyCode: 65,
        which: 65,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      };
      window.dispatchEvent(new KeyboardEvent("keydown", eventOpts));
      document.dispatchEvent(new KeyboardEvent("keydown", eventOpts));
      window.dispatchEvent(new KeyboardEvent("keyup", eventOpts));
      document.dispatchEvent(new KeyboardEvent("keyup", eventOpts));
    }

    setTimeout(() => {
      const qtySelectors = [
        ".input-group.qty input",
        'div[data-fieldname="qty"] input',
        ".qty-input",
        'input[aria-label="Quantity"]',
        'input[type="number"]',
      ];

      let qtyInput = null;
      for (const sel of qtySelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent) {
          qtyInput = el;
          break;
        }
      }

      if (
        !qtyInput &&
        document.activeElement &&
        document.activeElement.tagName === "INPUT" &&
        document.activeElement.offsetParent &&
        document.activeElement.type === "number"
      ) {
        qtyInput = document.activeElement;
      }

      if (qtyInput) {
        qtyInput.focus();
        qtyInput.select();

        qtyInput.addEventListener(
          "keydown",
          (e) => {
            if (e.key === "Enter") {
              setTimeout(() => {
                const searchEl = findSearchInput();
                if (searchEl) searchEl.focus();
              }, 150);
            }
          },
          { once: true }
        );
      } else {
        console.warn("LEAF: No quantity input found to focus.");
      }
    }, 100);
  };

  if (keyBridge && typeof keyBridge.onKeyEvent === "function") {
    keyBridge.onKeyEvent((shortcutKey) => {
      const fire = (k, opts = {}) =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: k,
            bubbles: true,
            cancelable: true,
            ...opts,
          })
        );

      if (shortcutKey === "tecla-cancelar-factura") fire("k", { ctrlKey: true });
      if (shortcutKey === "tecla-eliminar-producto") fire("d", { ctrlKey: true });
      if (shortcutKey === "tecla-cambiar-cantidad") {
        window.handleQuantityFocus(true);
      }
      if (shortcutKey === "tecla-totalizar") fire("s", { ctrlKey: true });
      if (shortcutKey === "tecla-validar-factura") fire("x", { ctrlKey: true });
      if (shortcutKey === "tecla-validar-imprimir") {
        if (arePaymentButtonsVisible()) {
          fire("a", { ctrlKey: true });
        } else {
          console.log("LEAF: F9 ignored outside payment screen.");
        }
      }
    });

    // Guard physical Ctrl+A outside payment screen and align physical Ctrl+Shift+A focus
    document.addEventListener(
      "keydown",
      (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "a") {
          if (!arePaymentButtonsVisible()) {
            e.preventDefault();
            e.stopImmediatePropagation();
          }
        }

        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "a") {
          if (e.isTrusted && window.handleQuantityFocus) {
            window.handleQuantityFocus(false);
          }
        }
      },
      true
    );
  }

  // ============================
  // Top shortcuts bar UI
  // ============================
  const mountShortcutsBar = () => {
    try {
      if (!shellApi || !document.body) return;
      if (document.getElementById("pos-shortcuts-bar")) return;

      const CFG = {
        height: 40,
        width: "850px",
        top: 0,
        align: "left",
        side: 0,
        r: 0,
        padX: 10,
        gap: 5,
        font: "system-ui,-apple-system,Segoe UI,Roboto,Arial",
        fz: 12,
        btnH: 24,
        btnPadX: 10,
        btnR: 8,
        barBg: "#111",
        barFg: "#f3f3f3",
        btnBg: "rgba(255,255,255,.08)",
        btnBgH: "rgba(255,255,255,.16)",
        btnBd: "1px solid rgba(255,255,255,.18)",
        sh: "0 2px 10px rgba(0,0,0,.35)",
        z: 99999,
      };

      const bar = document.createElement("div");
      bar.id = "pos-shortcuts-bar";
      Object.assign(bar.style, {
        position: "fixed",
        top: `${CFG.top}px`,
        left: `${CFG.side}px`,
        right: "auto",
        transform: "none",
        height: `${CFG.height}px`,
        width: CFG.width,
        display: "flex",
        alignItems: "center",
        gap: `${CFG.gap}px`,
        padding: `0 ${CFG.padX}px`,
        fontFamily: CFG.font,
        fontSize: `${CFG.fz}px`,
        background: CFG.barBg,
        color: CFG.barFg,
        zIndex: String(CFG.z),
        boxShadow: CFG.sh,
        borderRadius: `${CFG.r}px`,
      });

      const mkBtn = (txt, ttl, fn) => {
        const b = document.createElement("button");
        b.textContent = txt;
        b.title = ttl || txt;
        Object.assign(b.style, {
          height: `${CFG.btnH}px`,
          lineHeight: `${CFG.btnH}px`,
          padding: `0 ${CFG.btnPadX}px`,
          border: CFG.btnBd,
          borderRadius: `${CFG.btnR}px`,
          background: CFG.btnBg,
          color: CFG.barFg,
          cursor: "pointer",
          userSelect: "none",
          whiteSpace: "nowrap",
        });
        b.onmouseenter = () => (b.style.background = CFG.btnBgH);
        b.onmouseleave = () => (b.style.background = CFG.btnBg);
        b.onclick = fn;
        return b;
      };

      const sendKey = ({ key, ctrl = false, shift = false }) => {
        const upper = (key || "").toUpperCase();
        const code = /^[A-Z]$/.test(upper)
          ? `Key${upper}`
          : /^[0-9]$/.test(key)
            ? `Digit${key}`
            : `Key${upper}`;
        const base = {
          key,
          code,
          keyCode: upper.charCodeAt(0) || 0,
          which: upper.charCodeAt(0) || 0,
          ctrlKey: Boolean(ctrl),
          shiftKey: Boolean(shift),
          bubbles: true,
          cancelable: true,
        };
        window.dispatchEvent(new KeyboardEvent("keydown", base));
        document.dispatchEvent(new KeyboardEvent("keydown", base));
        window.dispatchEvent(new KeyboardEvent("keyup", base));
        document.dispatchEvent(new KeyboardEvent("keyup", base));
      };

      const isPaymentActive = () => {
        if (arePaymentButtonsVisible()) return true;
        const classSelector =
          ".payments, .v-card.selection .v-btn, .payment-container, .pos-payment-component";
        const paymentEl = document.querySelector(classSelector);
        if (paymentEl && paymentEl.offsetParent !== null) return true;
        const noteInput = document.querySelector(
          'input[placeholder*="Notas adicionales"], textarea[placeholder*="Notas adicionales"]'
        );
        return Boolean(noteInput && noteInput.offsetParent !== null);
      };

      bar.appendChild(
        mkBtn("F3 | Cancelar", "Cancelar (Ctrl+K)", () =>
          sendKey({ key: "k", ctrl: true })
        )
      );
      bar.appendChild(
        mkBtn("F4 | Eliminar ítem", "Eliminar ítem (Ctrl+D)", () =>
          sendKey({ key: "d", ctrl: true })
        )
      );
      bar.appendChild(
        mkBtn("F5 | Cantidad", "Cambiar cantidad (Ctrl+Shift+A)", () => {
          window.handleQuantityFocus(true);
        })
      );
      bar.appendChild(
        mkBtn("F9 | Validar + Imp", "Validar e imprimir (Ctrl+A)", () => {
          if (isPaymentActive()) {
            sendKey({ key: "a", ctrl: true });
          }
        })
      );
      bar.appendChild(
        mkBtn("F10 | Totalizar", "Totalizar (Ctrl+S)", () =>
          sendKey({ key: "s", ctrl: true })
        )
      );

      const toggle = mkBtn("▲", "Ocultar/mostrar barra", () => {
        const hide = bar.getAttribute("data-collapsed") === "1";
        const next = !hide;
        bar.setAttribute("data-collapsed", next ? "1" : "0");
        [...bar.children].forEach((c) => {
          if (c !== toggle) c.style.display = next ? "none" : "";
        });
        toggle.textContent = next ? "▼" : "▲";
      });
      toggle.style.marginLeft = "auto";
      toggle.style.minWidth = "26px";
      bar.appendChild(toggle);
      document.body.appendChild(bar);
    } catch (e) {
      console.error("LEAF: Error mounting shortcuts bar:", e);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountShortcutsBar);
  } else {
    mountShortcutsBar();
  }

  // ================================================
  // Strict prefix search helper
  // ================================================
  (() => {
    const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
    let handling = false;
    let panel = null;
    let panelList = [];
    let highlighted = -1;
    let searchInput = null;

    const ensurePanel = () => {
      if (panel && document.body.contains(panel)) return panel;
      panel = document.createElement("div");
      Object.assign(panel.style, {
        position: "absolute",
        maxHeight: "320px",
        overflowY: "auto",
        background: "#111",
        color: "#f3f3f3",
        border: "1px solid rgba(255,255,255,.2)",
        borderRadius: "8px",
        boxShadow: "0 8px 24px rgba(0,0,0,.35)",
        zIndex: 999999,
        fontFamily: "system-ui,-apple-system,Segoe UI,Roboto,Arial",
        fontSize: "12px",
      });
      document.body.appendChild(panel);
      return panel;
    };

    const placePanel = (anchor) => {
      const r = anchor.getBoundingClientRect();
      panel.style.left = `${r.left}px`;
      panel.style.top = `${r.bottom + 6 + window.scrollY}px`;
      panel.style.minWidth = `${Math.max(r.width, 280)}px`;
    };

    const clearPanel = () => {
      highlighted = -1;
      panelList = [];
      if (panel?.parentNode) panel.parentNode.removeChild(panel);
      panel = null;
    };

    const highlight = (idx) => {
      highlighted = idx;
      if (!panel) return;
      [...panel.children].forEach(
        (row, i) =>
          (row.style.background =
            i === idx ? "rgba(255,255,255,.10)" : "transparent")
      );
    };

    const renderPanel = (anchor, items, onPick) => {
      panelList = items.slice(0, 50);
      const p = ensurePanel();
      placePanel(anchor);
      p.innerHTML = "";
      if (!panelList.length) {
        const d = document.createElement("div");
        d.textContent = "Sin resultados por prefijo";
        d.style.padding = "10px";
        d.style.opacity = ".8";
        p.appendChild(d);
        return;
      }
      panelList.forEach((it, idx) => {
        const row = document.createElement("div");
        row.dataset.idx = String(idx);
        Object.assign(row.style, {
          padding: "10px 12px",
          cursor: "pointer",
          display: "grid",
          gridTemplateColumns: "120px 1fr",
          gap: "10px",
        });
        row.onmouseenter = () => highlight(idx);
        row.onclick = () => onPick(it);
        const code = document.createElement("div");
        code.textContent = it.item_code || it.name || "";
        code.style.fontWeight = "600";
        const name = document.createElement("div");
        name.textContent = it.item_name || it.description || "";
        name.style.opacity = ".9";
        row.appendChild(code);
        row.appendChild(name);
        p.appendChild(row);
      });
      highlight(-1);
    };

    const getStrictFlag = async () => {
      try {
        const contractProfile = window.leafPos?.getSnapshot?.()?.posProfile;
        const profile =
          contractProfile ||
          window.frappe?.defaults?.get_default?.("pos_profile");
        if (!profile || !window.frappe?.db?.get_value) return false;
        const r = await window.frappe.db.get_value("POS Profile", profile, [
          "strict_search",
        ]);
        return Boolean(r?.message?.strict_search);
      } catch {
        return false;
      }
    };

    const quickLookup = async (term) => {
      try {
        if (!window.frappe?.call) return {};
        const r = await window.frappe.call({
          method: "posawesome.api.search.quick_lookup",
          args: { term },
        });
        return r?.message || {};
      } catch {
        return {};
      }
    };

    const prefixSearch = async (term, limit = 30) => {
      try {
        if (!window.frappe?.call) return [];
        const r = await window.frappe.call({
          method: "posawesome.api.search.items_prefix",
          args: { term, limit },
        });
        return r?.message || [];
      } catch {
        return [];
      }
    };

    const addItemToCart = async (item_code) => {
      try {
        if (window.leafPos && typeof window.leafPos.addToCart === "function") {
          await window.leafPos.addToCart({ item_code });
          return true;
        }
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true })
        );
        document.dispatchEvent(
          new KeyboardEvent("keyup", { key: "a", ctrlKey: true, bubbles: true })
        );
        return true;
      } catch {
        return false;
      }
    };

    const bindToInput = (el) => {
      if (!el || el === searchInput) return;
      searchInput = el;

      document.addEventListener("click", (e) => {
        if (!panel) return;
        if (e.target === searchInput) return;
        if (panel.contains(e.target)) return;
        clearPanel();
      });

      const blockLive = async (e) => {
        const term = (searchInput.value || "").trim();
        const hasPercent = term.includes("%");
        const strict = hasPercent ? false : await getStrictFlag();
        if (strict) {
          e.stopImmediatePropagation();
          searchInput.setAttribute(
            "title",
            "Modo estricto: presiona Enter para buscar por prefijo"
          );
          if (!term) clearPanel();
        } else {
          searchInput.removeAttribute("title");
        }
      };

      searchInput.addEventListener("input", blockLive, { capture: true });
      searchInput.addEventListener(
        "keyup",
        async (e) => {
          if (e.key !== "Enter") await blockLive(e);
        },
        { capture: true }
      );
    };

    const mo = new MutationObserver(() => {
      const el = findSearchInput();
      if (el) bindToInput(el);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener(
      "keydown",
      async (ev) => {
        if (!searchInput || document.activeElement !== searchInput) return;

        if (panel) {
          if (ev.key === "ArrowDown") {
            ev.preventDefault();
            highlight(Math.min(highlighted + 1, panelList.length - 1));
            return;
          }
          if (ev.key === "ArrowUp") {
            ev.preventDefault();
            highlight(Math.max(highlighted - 1, -1));
            return;
          }
          if (ev.key === "Escape") {
            ev.preventDefault();
            clearPanel();
            return;
          }
          if (ev.key === "Enter" && highlighted >= 0) {
            ev.preventDefault();
            const pick = panelList[highlighted];
            clearPanel();
            await addItemToCart(pick.item_code || pick.name);
            searchInput.value = "";
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
            return;
          }
        }

        if (ev.key !== "Enter") return;
        if (handling) return;
        handling = true;

        try {
          let term = (searchInput.value || "").trim();
          if (!term) {
            handling = false;
            return;
          }

          const exact = await quickLookup(term);
          if (exact.item_code) {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            await addItemToCart(exact.item_code);
            searchInput.value = "";
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
            clearPanel();
            handling = false;
            return;
          }

          const forceClassic = term.includes("%");
          const strict = forceClassic ? false : await getStrictFlag();

          if (strict) {
            if (term.length < 3) {
              ev.preventDefault();
              ev.stopImmediatePropagation();
              window.frappe?.show_alert?.({
                message: "Escribe al menos 3 caracteres para búsqueda por prefijo.",
                indicator: "orange",
              });
              handling = false;
              return;
            }
            const list = await prefixSearch(term, 30);
            if (list.length > 0) {
              ev.preventDefault();
              ev.stopImmediatePropagation();
              renderPanel(searchInput, list, async (it) => {
                clearPanel();
                await addItemToCart(it.item_code || it.name);
                searchInput.value = "";
                searchInput.dispatchEvent(new Event("input", { bubbles: true }));
              });
              handling = false;
              return;
            }
            ev.preventDefault();
            ev.stopImmediatePropagation();
            term = `%${term}%`;
            searchInput.value = term;
            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
            handling = false;
            searchInput.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
            );
            return;
          }

          handling = false;
        } catch (err) {
          console.error("LEAF strict search error:", err);
          handling = false;
        }
      },
      { capture: true }
    );

    const tryBind = async () => {
      for (let i = 0; i < 50 && !searchInput; i++) {
        const el = findSearchInput();
        if (el) {
          bindToInput(el);
          break;
        }
        await SLEEP(20);
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", tryBind);
    } else {
      tryBind();
    }
  })();
})();
