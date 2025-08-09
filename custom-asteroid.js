console.log("✅ custom-asteroid.js cargado");

window.addEventListener('load', () => {
  const carrito = localStorage.getItem('pos_invoice_items');

  if (carrito && carrito !== '[]') {
    alert('⚠️ Hay productos pendientes del cierre anterior. Se generará un vale de recuperación.');
    // Aquí podrías redirigir o manejar una recuperación automática si así lo deseas.
  }
});

if (window.asteroid) {
  window.asteroid.onKeyEvent((tecla) => {
    console.log(`🔥 ${tecla} PRESIONADA`);

    // F3 → Ctrl + K → Cancelar factura
    if (tecla === 'tecla-cancelar-factura') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })
      );
    }

    // F4 → Ctrl + D → Eliminar ítem
    if (tecla === 'tecla-eliminar-producto') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'd', ctrlKey: true })
      );
    }

    // F5 → Ctrl + W → Cambiar cantidad
    if (tecla === 'tecla-cambiar-cantidad') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'w', ctrlKey: true })
      );
    }

    // F10 → Ctrl + S → Totalizar
    if (tecla === 'tecla-totalizar') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true })
      );
    }

    // F8 → Ctrl + X → Validar en pantalla de pagos
    if (tecla === 'tecla-validar-factura') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'x', ctrlKey: true })
      );
    }

    // F9 → Ctrl + A → Validar e Imprimir en pantalla de pagos
    if (tecla === 'tecla-validar-imprimir') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', ctrlKey: true })
      );
    }
  });
} else {
  console.warn("⚠️ asteroid API no disponible");
}
