/* Kantoro — envoltorio del worker de Tesseract: silencia los avisos "Parameter not found: …" que imprime al cargar
 * el modelo japonés (parámetros del motor antiguo que la versión LSTM no usa; son inofensivos). */
(() => {
  const quiet = (orig) => function (...a) {
    if (typeof a[0] === 'string' && /Parameter not found|^Warning: Parameter/.test(a[0])) return;
    return orig.apply(this, a);
  };
  console.log = quiet(console.log);
  console.warn = quiet(console.warn);
  console.error = quiet(console.error);
})();
importScripts('worker.min.js');
