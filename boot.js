// Script clásico de arranque: muestra un mensaje claro si el módulo principal no puede iniciar.
(() => {
  const loading = document.querySelector('#map-loading');
  const status = document.querySelector('#data-status');
  const error = document.querySelector('#map-error');
  function fail(message) {
    loading.hidden = true;
    status.textContent = 'Carga interrumpida';
    error.hidden = false;
    error.replaceChildren(document.createTextNode(message + ' '));
    const b = document.createElement('button');
    b.className = 'text-button'; b.textContent = 'Volver a intentar'; b.onclick = () => location.reload();
    error.append(b);
  }
  if (location.protocol === 'file:') {
    fail('Abre el atlas desde su enlace web o ejecuta INICIAR.cmd. Un archivo HTML abierto con doble clic no puede cargar los datos del mapa.');
    return;
  }
  if (!window.pmtiles) { fail('No se pudo cargar la librería de teselas (vendor/pmtiles.js).'); return; }
  const timer = setTimeout(() => {
    if (!document.body.dataset.atlasReady) fail('El atlas está tardando en iniciar. Comprueba la conexión y vuelve a intentar.');
  }, 20000);
  window.addEventListener('atlas-ready', () => clearTimeout(timer), {once: true});
  import('./app.mjs?v=2.0.5').catch(e => { clearTimeout(timer); console.error(e); fail('No se pudo iniciar el mapa: ' + e.message); });
})();
