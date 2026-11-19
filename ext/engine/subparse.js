/* Kantoro — lectura de archivos de subtítulos ASS/SSA, WebVTT y SRT → [{start, end, text}] ordenados. */
(function (root) {
  'use strict';
  const JP = /[぀-ヿ㐀-䶿一-鿿豈-﫿々]/;

  function assTime(t) {
    const m = /(\d+):(\d+):(\d+)[.:](\d+)/.exec(t.trim());
    if (!m) return NaN;
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +('0.' + m[4]);
  }
  function vttTime(t) {
    const m = /(?:(\d+):)?(\d+):(\d+)[.,](\d+)/.exec(t.trim());
    if (!m) return NaN;
    return (+m[1] || 0) * 3600 + +m[2] * 60 + +m[3] + +('0.' + m[4]);
  }

  function parseASS(text) {
    const out = [];
    let fmt = null, inEvents = false;
    const signStyles = new Set();
    let styleFmt = null, inStyles = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (/^\[/.test(line)) { inEvents = /^\[events\]/i.test(line); inStyles = /^\[v4\+? styles\]/i.test(line); continue; }
      if (inStyles && /^format:/i.test(line)) styleFmt = line.slice(7).split(',').map((s) => s.trim().toLowerCase());
      if (inStyles && /^style:/i.test(line) && styleFmt) {
        const name = line.slice(6).split(',')[styleFmt.indexOf('name')];
        if (name && /sign|song|op|ed|kara|title|note/i.test(name.trim())) signStyles.add(name.trim());
      }
      if (!inEvents) continue;
      if (/^format:/i.test(line)) { fmt = line.slice(7).split(',').map((s) => s.trim().toLowerCase()); continue; }
      if (!/^dialogue:/i.test(line)) continue;
      const f = fmt || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
      const parts = line.slice(9).split(',');
      const head = parts.slice(0, f.length - 1);
      const body = parts.slice(f.length - 1).join(',');
      const get = (k) => (head[f.indexOf(k)] || '').trim();
      const tags = (body.match(/\{[^}]*\}/g) || []).join('');
      const t = body.replace(/\{[^}]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ').replace(/[ \t]+/g, ' ').trim();
      if (!t) continue;
      const style = get('style');
      // Carteles/letreros posicionados o con estilo de "signs": se marcan para poder distinguirlos del diálogo
      const sign = signStyles.has(style) || /\\pos\(|\\move\(|\\p[1-9]/.test(tags);
      out.push({ start: assTime(get('start')), end: assTime(get('end')), text: t, sign, style });
    }
    return out;
  }

  function parseVTT(text) {
    const out = [];
    const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
    for (const b of blocks) {
      const lines = b.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const [a, z] = lines[i].split('-->');
      const t = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
      if (!t) continue;
      out.push({ start: vttTime(a), end: vttTime(z.trim().split(/\s+/)[0]), text: t, sign: false });
    }
    return out;
  }

  function parse(text, hint = '') {
    const kind = /\[script info\]|\[events\]/i.test(text.slice(0, 4000)) || /ass|ssa/i.test(hint) ? 'ass' : 'vtt';
    const cues = (kind === 'ass' ? parseASS(text) : parseVTT(text))
      .filter((c) => isFinite(c.start) && isFinite(c.end) && c.end > c.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    return { kind, cues, japanese: cues.filter((c) => JP.test(c.text)).length, isJapanese: looksJapanese(cues) };
  }

  // ¿Es japonés o chino? El chino usa los mismos kanji, pero el diálogo japonés casi siempre lleva kana.
  const KANA = /[\u3041-\u3096\u30a1-\u30fa]/;
  const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
  function looksJapanese(cues) {
    const han = cues.filter((c) => HAN.test(c.text) || KANA.test(c.text));
    if (!han.length) return false;
    return han.filter((c) => KANA.test(c.text)).length / han.length >= 0.25;
  }

  /** Índices de los cues activos en t (búsqueda binaria + barrido corto hacia atrás) */
  function activeAt(cues, t, maxLen) {
    let lo = 0, hi = cues.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cues[m].start <= t) lo = m + 1; else hi = m; }
    const res = [];
    for (let i = lo - 1; i >= 0 && t - cues[i].start <= maxLen; i--) if (cues[i].end > t) res.unshift(i);
    return res;
  }

  const api = { parse, activeAt, looksJapanese };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RJSubs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
