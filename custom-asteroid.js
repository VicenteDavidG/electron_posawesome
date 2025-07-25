console.log("custom-asteroid.js cargado");

if (window.asteroid) {
  window.asteroid.onKeyEvent((tecla) => {
    console.log(`🔥 ${tecla} PRESIONADA`);

    if (tecla === 'tecla-eliminar-producto') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'd', ctrlKey: true })
      );
    }

    if (tecla === 'tecla-cancelar-factura') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })
      );
    }

    if (tecla === 'tecla-cambiar-cantidad') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'w', ctrlKey: true })
      );
    }

    if (tecla === 'tecla-totalizar') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 's', ctrlKey: true })
      );
    }

    if (tecla === 'tecla-validar-factura') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'x', ctrlKey: true })
      );
    }

    if (tecla === 'tecla-validar-imprimir') {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', ctrlKey: true })
      );
    }
  });
} else {
  console.warn("asteroid API no disponible");
}
