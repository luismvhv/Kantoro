/* Kantoro — se ejecuta en el MUNDO PRINCIPAL de la página (world: MAIN) en Crunchyroll, antes que sus scripts.
 * Observa (sin modificar) las respuestas de su API para saber qué pistas de subtítulos ofrece cada episodio
 * —incluidas las que no están seleccionadas— y avisa al content script mediante postMessage.
 * No lee ni envía cookies, tokens ni ninguna otra información. */
(() => {
  'use strict';
  if (window.__kantoroHook) return;
  window.__kantoroHook = true;

  const SUB_EXT = /\.(ass|ssa|vtt|srt)(\?|$)/i;
  const INTERESTING = /play|stream|subtitle|caption|playback/i;

  // Busca objetos del tipo { "<locale>": { url, format } } bajo claves subtitles / captions
  function findTracks(obj, depth = 0, out = []) {
    if (!obj || typeof obj !== 'object' || depth > 6) return out;
    for (const [k, v] of Object.entries(obj)) {
      if (/^(subtitles|captions|closed_captions)$/i.test(k) && v && typeof v === 'object') {
        const entries = Array.isArray(v) ? v.map((x) => [x.locale || x.language || x.lang, x]) : Object.entries(v);
        for (const [loc, t] of entries) {
          if (t && typeof t === 'object' && typeof t.url === 'string' && t.url) {
            out.push({ kind: k.toLowerCase(), locale: String(t.language || t.locale || loc || ''), url: t.url, format: t.format || '' });
          }
        }
      } else if (v && typeof v === 'object') findTracks(v, depth + 1, out);
    }
    return out;
  }

  function report(tracks) {
    if (tracks.length) window.postMessage({ __kantoro: 'subs-index', tracks }, '*');
  }
  function inspectJSON(text) {
    if (!text || text.length > 5e6 || !/subtitles|captions/i.test(text)) return;
    try { report(findTracks(JSON.parse(text))); } catch (_) { /* no es JSON */ }
  }
  function inspectSub(url, text) {
    if (text && /[぀-ヿ一-鿿]/.test(text.slice(0, 20000))) window.postMessage({ __kantoro: 'subs-file', url, text }, '*');
  }
  function handle(url, ctype, getText) {
    try {
      url = String(url || '');
      if (SUB_EXT.test(url) || /x-ssa|x-ass|text\/vtt|subrip/i.test(ctype)) getText().then((t) => inspectSub(url, t), () => {});
      else if (/json/i.test(ctype) && INTERESTING.test(url)) getText().then(inspectJSON, () => {});
    } catch (_) { /* nunca romper la página */ }
  }

  const ofetch = window.fetch;
  if (ofetch) {
    window.fetch = function (...args) {
      const p = ofetch.apply(this, args);
      p.then((res) => {
        try { handle(res.url, res.headers.get('content-type') || '', () => res.clone().text()); } catch (_) { /* nada */ }
      }, () => {});
      return p;
    };
  }
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const open = XHR.open, send = XHR.send;
    XHR.open = function (m, u, ...r) { this.__rjUrl = u; return open.call(this, m, u, ...r); };
    XHR.send = function (...a) {
      this.addEventListener('load', () => {
        try {
          const rt = this.responseType;
          if (rt && rt !== 'text' && rt !== 'json') return;
          handle(this.responseURL || this.__rjUrl, this.getResponseHeader('content-type') || '',
            () => Promise.resolve(rt === 'json' ? JSON.stringify(this.response) : this.responseText));
        } catch (_) { /* nada */ }
      });
      return send.apply(this, a);
    };
  }
})();
