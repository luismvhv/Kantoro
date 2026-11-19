/* Kantoro — OCR japonés (Tesseract LSTM, modelo jpn best_int) para imágenes, canvas y subtítulos incrustados.
 * Se ejecuta en el documento offscreen.
 *  - 'page': texto impreso (libros, cómics, capturas). Se borran las franjas de furigana ANTES del OCR y se elige
 *            la escala según la altura real de las líneas; una sola pasada sobre la imagen en grises.
 *  - 'subs': subtítulos de vídeo (relleno claro + contorno oscuro). Se aísla el texto por su contorno, lo que
 *            elimina el fondo del vídeo, y se reconoce cada línea por separado.
 * Nota: en documentos ocultos Chrome estrangula OffscreenCanvas.convertToBlob (~1 s). Por eso las imágenes se pasan
 * a Tesseract como PGM generado a mano. */
(function (root) {
  'use strict';
  const JP = /[぀-ヿ㐀-䶿一-鿿豈-﫿々〆〇]/;
  const KANA = /[ぁ-ゖァ-ヺ]/;
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

  const simdOK = () => {
    try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); }
    catch (_) { return false; }
  };
  let workerP = null;
  function getWorker() {
    if (!workerP) {
      workerP = Tesseract.createWorker('jpn', 1, {
        workerPath: chrome.runtime.getURL('ocr/worker-quiet.js'),
        // Variante SIMD estándar: la «relaxed SIMD» usa aritmética aproximada y empeora el reconocimiento
        corePath: chrome.runtime.getURL(simdOK() ? 'ocr/core/tesseract-core-simd-lstm.wasm.js' : 'ocr/core/tesseract-core-lstm.wasm.js'),
        langPath: chrome.runtime.getURL('ocr/lang/'),
        workerBlobURL: false,
        gzip: true,
        cacheMethod: 'none',
      }).then(async (w) => {
        await w.setParameters({ preserve_interword_spaces: '1' });
        return w;
      });
      workerP.catch(() => { workerP = null; });
    }
    return workerP;
  }
  let queue = Promise.resolve();
  function serial(fn) { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; }

  async function bitmapFrom(src) {
    const blob = src instanceof Blob ? src : await (await fetch(src)).blob();
    return createImageBitmap(blob);
  }
  function pixels(bmp, crop) {
    const c = new OffscreenCanvas(crop.w, crop.h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
    return g.getImageData(0, 0, crop.w, crop.h);
  }

  // ── Utilidades de imagen en escala de grises ──
  function scaleGray(gray, w, h, s) {
    if (s === 1) return { gray, w, h };
    const src = new OffscreenCanvas(w, h);
    const sg = src.getContext('2d');
    const id = sg.createImageData(w, h);
    for (let p = 0; p < w * h; p++) { const o = p * 4; id.data[o] = id.data[o + 1] = id.data[o + 2] = gray[p]; id.data[o + 3] = 255; }
    sg.putImageData(id, 0, 0);
    const W = Math.round(w * s), H = Math.round(h * s);
    const dst = new OffscreenCanvas(W, H);
    const dg = dst.getContext('2d', { willReadFrequently: true });
    dg.imageSmoothingQuality = 'high';
    dg.drawImage(src, 0, 0, W, H);
    const d = dg.getImageData(0, 0, W, H).data;
    const out = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) out[p] = d[p * 4];
    return { gray: out, w: W, h: H };
  }
  function toPGM(gray, w, h) {
    const head = new TextEncoder().encode(`P5\n${w} ${h}\n255\n`);
    const out = new Uint8Array(head.length + w * h);
    out.set(head, 0);
    out.set(gray, head.length);
    return out;
  }
  function dilate(mask, w, h, r) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let run = -1e9;
      for (let x = 0; x < w; x++) { if (mask[y * w + x]) run = x; tmp[y * w + x] = x - run <= r ? 1 : 0; }
      run = 1e9;
      for (let x = w - 1; x >= 0; x--) { if (mask[y * w + x]) run = x; if (run - x <= r) tmp[y * w + x] = 1; }
    }
    for (let x = 0; x < w; x++) {
      let run = -1e9;
      for (let y = 0; y < h; y++) { if (tmp[y * w + x]) run = y; out[y * w + x] = y - run <= r ? 1 : 0; }
      run = 1e9;
      for (let y = h - 1; y >= 0; y--) { if (tmp[y * w + x]) run = y; if (run - y <= r) out[y * w + x] = 1; }
    }
    return out;
  }
  function bands(ink, w, h, minFrac) {
    const rows = new Float32Array(h);
    let max = 0;
    for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) s += ink[y * w + x]; rows[y] = s; if (s > max) max = s; }
    const thr = Math.max(1, max * minFrac);
    const out = [];
    for (let y = 0; y < h; y++) if (rows[y] >= thr) { const s = y; while (y < h && rows[y] >= thr) y++; out.push([s, y]); }
    return out;
  }

  // ── Limpieza del texto reconocido ──
  function fixText(t) {
    return t.replace(/\s+(?=[^\x00-\x7f])|(?<=[^\x00-\x7f])\s+/g, '')
      .replace(/ー/g, (m, i, s) => (i > 0 && KANA.test(s[i - 1]) ? 'ー' : '一')) // ー solo tras kana; si no, es 一
      .replace(/^[|\]\[_\-—~.・,:;'"`]+|[|\]\[_\-—~・`'"]+$/g, '')
      .trim();
  }
  // Símbolos de una línea → texto (sin restos de furigana) + índices dudosos
  function lineText(syms) {
    if (!syms.length) return { text: '', low: [] };
    const H = Math.max(...syms.map((s) => s.bbox.y1 - s.bbox.y0));
    const big = syms.filter((s) => s.bbox.y1 - s.bbox.y0 >= 0.7 * H);
    const top = med(big.map((s) => s.bbox.y0)), bot = med(big.map((s) => s.bbox.y1));
    const bh = Math.max(1, bot - top);
    const kept = syms.filter((s) => !(s.bbox.y1 - s.bbox.y0 < 0.65 * bh && s.bbox.y1 < top + 0.35 * bh));
    const raw = kept.map((s) => s.text).join('');
    const text = fixText(raw);
    const low = [];
    if (text.length === raw.replace(/\s/g, '').length) {
      let i = 0;
      for (const s of kept) for (const ch of s.text) { if (/\s/.test(ch)) continue; if (s.confidence < 60) low.push(i); i++; }
    }
    return { text, low };
  }

  async function recognize(gray, w, h, psm) {
    const worker = await getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(toPGM(gray, w, h), {}, { blocks: true, text: true });
    return (data.blocks || []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  }

  // ── Subtítulos de vídeo ──
  function subsMask(id) {
    const { width: w, height: h, data: d } = id;
    const white = new Uint8Array(w * h), dark = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      white[p] = lum > 185 && sat < 60 ? 1 : 0;
      dark[p] = lum < 70 ? 1 : 0;
    }
    const near = dilate(dark, w, h, 3);
    const ink = new Uint8Array(w * h);
    let count = 0, darkCount = 0;
    for (let p = 0; p < w * h; p++) { if (white[p] && near[p]) { ink[p] = 1; count++; } darkCount += dark[p]; }
    // Texto oscuro sobre fondo claro (sin contorno): usar los píxeles oscuros
    if (count < w * h * 0.002 && darkCount > w * h * 0.002 && darkCount < w * h * 0.35) for (let p = 0; p < w * h; p++) ink[p] = dark[p];
    return ink;
  }
  async function ocrSubs(id, crop) {
    const { width: w, height: h } = id;
    const ink = subsMask(id);
    const bs = bands(ink, w, h, 0.06).filter(([a, b]) => b - a >= 8);
    const merged = [];
    for (const b of bs) { const l = merged[merged.length - 1]; if (l && b[0] - l[1] < 4) l[1] = b[1]; else merged.push([...b]); }
    const m = med(merged.map(([a, b]) => b - a)) || 1;
    const scale = m < 28 ? Math.min(3, 40 / m) : 1;
    const out = [];
    for (const [y0, y1] of merged) {
      if (y1 - y0 < Math.max(8, m * 0.45)) continue;
      let x0 = w, x1 = 0;
      for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) if (ink[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
      const pad = Math.round((y1 - y0) * 0.4) + 4;
      const bw = x1 - x0 + 1 + 2 * pad, bh = y1 - y0 + 2 * pad;
      const g = new Uint8Array(bw * bh).fill(255);
      for (let y = y0; y < y1; y++) for (let x = x0; x <= x1; x++) if (ink[y * w + x]) g[(y - y0 + pad) * bw + (x - x0 + pad)] = 0;
      const sc = scaleGray(g, bw, bh, scale);
      const lines = await recognize(sc.gray, sc.w, sc.h, '7');
      const syms = lines.flatMap((l) => l.words.flatMap((wd) => wd.symbols));
      const conf = lines.length ? lines.reduce((a, l) => a + l.confidence, 0) / lines.length : 0;
      const { text, low } = lineText(syms);
      if (!JP.test(text) || conf < 35) continue;
      out.push({ text, low, conf, box: { x: crop.x + x0, y: crop.y + y0, w: x1 - x0 + 1, h: y1 - y0 } });
    }
    return out;
  }

  // ── Texto impreso ──
  async function ocrPage(id, crop) {
    const { width: w, height: h, data: d } = id;
    const gray = new Uint8Array(w * h);
    let lo = 255, hi = 0, sum = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const v = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      gray[p] = v; sum += v; if (v < lo) lo = v; if (v > hi) hi = v;
    }
    const darkBg = sum / (w * h) < 110;
    const span = Math.max(1, hi - lo);
    const ink = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      let v = ((gray[p] - lo) * 255) / span;
      if (darkBg) v = 255 - v;
      gray[p] = v;
      ink[p] = v < 140 ? 1 : 0;
    }
    // Borrar furigana: franjas finas justo encima de una línea normal
    const bs = bands(ink, w, h, 0.004);
    const m = med(bs.map(([a, b]) => b - a));
    bs.forEach(([s, e], i) => {
      const nx = bs[i + 1];
      // furigana: franja fina (pero no un simple trazo suelto), separada por un hueco real de la línea de debajo
      if (e - s < 0.6 * m && e - s >= 0.25 * m && nx && nx[1] - nx[0] >= 0.6 * m && nx[0] - e >= 2 && nx[0] - e < 0.7 * m) gray.fill(255, s * w, e * w);
    });
    const scale = !m || m >= 34 ? 1 : m >= 17 ? 2 : 3; // escalas enteras: el reescalado fraccionario degrada el OCR
    const sc = scaleGray(gray, w, h, scale);
    const lines = await recognize(sc.gray, sc.w, sc.h, '6');
    const mh = med(lines.map((l) => l.bbox.y1 - l.bbox.y0));
    const out = [];
    for (const l of lines) {
      if (l.bbox.y1 - l.bbox.y0 < 0.5 * mh || l.confidence < 35) continue;
      const { text, low } = lineText(l.words.flatMap((wd) => wd.symbols));
      if (!JP.test(text)) continue;
      out.push({
        text, low, conf: l.confidence,
        box: { x: crop.x + l.bbox.x0 / scale, y: crop.y + l.bbox.y0 / scale, w: (l.bbox.x1 - l.bbox.x0) / scale, h: (l.bbox.y1 - l.bbox.y0) / scale },
      });
    }
    return out;
  }

  // Huella de la máscara de texto: ignora el movimiento del vídeo de fondo
  function fingerprint(ink, w, h) {
    const W = 64, H = 16, f = new Uint16Array(W * H);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink[y * w + x]) f[((y * H / h) | 0) * W + ((x * W / w) | 0)]++;
    return f;
  }
  function differs(a, b) {
    if (!a || !b) return true;
    let s = 0, t = 0;
    for (let i = 0; i < a.length; i++) { s += Math.abs(a[i] - b[i]); t += a[i] + b[i]; }
    return t > 0 && s / t > 0.06;
  }

  const lastPrint = new Map();
  /**
   * msg: { src (dataURL/URL), crop?: {x,y,w,h}, viewW?: anchura CSS del viewport (crop y cajas en px CSS),
   *        kind: 'page'|'subs', key?: id del modo continuo }
   * → { same } | { lines:[{text, low, conf, box}], imgW, imgH, ms }
   */
  function ocr(msg) {
    return serial(async () => {
      const t0 = performance.now();
      const bmp = await bitmapFrom(msg.src);
      const f = msg.viewW ? bmp.width / msg.viewW : 1;
      const c0 = msg.crop ? { x: msg.crop.x * f, y: msg.crop.y * f, w: msg.crop.w * f, h: msg.crop.h * f } : { x: 0, y: 0, w: bmp.width, h: bmp.height };
      const crop = { x: Math.max(0, Math.round(c0.x)), y: Math.max(0, Math.round(c0.y)) };
      crop.w = Math.max(0, Math.min(bmp.width - crop.x, Math.round(c0.w)));
      crop.h = Math.max(0, Math.min(bmp.height - crop.y, Math.round(c0.h)));
      const base = { imgW: bmp.width / f, imgH: bmp.height / f };
      if (crop.w < 8 || crop.h < 8) return Object.assign({ lines: [], ms: 0 }, base);
      const id = pixels(bmp, crop);
      let lines;
      if (msg.kind === 'subs') {
        if (msg.key) {
          const fp = fingerprint(subsMask(id), id.width, id.height);
          const prev = lastPrint.get(msg.key);
          lastPrint.set(msg.key, fp);
          if (!differs(fp, prev)) return { same: true };
        }
        lines = await ocrSubs(id, crop);
      } else lines = await ocrPage(id, crop);
      if (f !== 1) for (const l of lines) l.box = { x: l.box.x / f, y: l.box.y / f, w: l.box.w / f, h: l.box.h / f };
      return Object.assign({ lines, ms: Math.round(performance.now() - t0) }, base);
    });
  }

  root.RJOcr = {
    ocr, warm: () => getWorker(), subsMask, fingerprint, differs,
    // Reconoce una ImageData ya recortada (cajas relativas al recorte, en px de la imagen)
    recognizeImage: (id, kind) => serial(() => (kind === 'subs' ? ocrSubs(id, { x: 0, y: 0 }) : ocrPage(id, { x: 0, y: 0 }))),
  };
})(globalThis);
