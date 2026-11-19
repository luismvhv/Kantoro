/* Kantoro — content script: detecta subtítulos/textos japoneses y dibuja el overlay en rōmaji. */
(() => {
  'use strict';
  // Si la extensión se recarga, el script antiguo queda huérfano: se desmonta y se sustituye
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  const prev = window.__kantoro;
  if (prev && prev.alive && prev.alive()) return;
  if (prev && prev.teardown) { try { prev.teardown(); } catch (_) { /* nada */ } }
  const AC = new AbortController();
  const cleanups = [];
  let dead = false;
  function teardown() {
    if (dead) return;
    dead = true;
    AC.abort();
    cleanups.forEach((f) => { try { f(); } catch (_) { /* nada */ } });
    document.querySelectorAll('kantoro-layer').forEach((h) => h.remove());
  }
  window.__kantoro = { alive, teardown };

  // ───────────────────────── Ajustes ─────────────────────────
  const DEFAULTS = {
    enabled: true,
    mode: 'romaji',          // 'romaji' | 'romaji+tr'
    target: 'es',
    trEngine: 'auto',        // 'auto' (integrado de Chrome si está listo; si no, en línea) | 'online' | 'local'
    position: 'above',       // 'above' | 'cover'
    pauseOnHover: true,
    resumeOnLeave: true,
    longVowels: 'literal',   // 'literal' (ou) | 'macron' (ō)
    particles: 'phonetic',   // 'phonetic' (wa, e, o) | 'literal' (ha, he, wo)
    n: 'n',
    markAmbiguous: true,
    showOriginal: false,
    selection: true,
    fontScale: 1,
    customSelectors: {},
    subFiles: true,          // usar archivos de subtítulos japoneses interceptados
    videoSource: 'ocr',      // 'ocr' | 'audio' cuando el vídeo no trae subtítulos de texto
    asrLocal: true,          // (versiones anteriores) reconocimiento de voz en el dispositivo
    asrEngine: 'auto',       // voz: 'auto' (dispositivo si está instalado; si no, Google) | 'local' | 'cloud'
    asrView: 'phrase',       // voz: 'phrase' (frase a frase) | 'ticker' (desplazamiento continuo)
    asrSpeakers: true,       // voz: distinguir personajes (colores y carriles)
    origScript: 'kanji',     // texto japonés bajo el rōmaji: 'kanji' (como se escribe) | 'kana' (hiragana + katakana)
    bubble: 'video',         // burbuja flotante: 'video' (solo con vídeo) | 'always' | 'never'
  };
  let S = { ...DEFAULTS };
  const JP = /[぀-ヿ㐀-䶿一-鿿豈-﫿々ｦ-ﾟ]/;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Selectores de subtítulos conocidos (se amplían con los elegidos por el usuario)
  const SITE_NAMES = {
    '.ytp-caption-window-container': 'YouTube', '.player-timedtext': 'Netflix', '.atvwebplayersdk-captions-text': 'Prime Video',
    '.dss-subtitle-renderer-cue-window': 'Disney+', '.hive-subtitle-renderer-cue-positioning-box': 'Disney+',
    '[data-testid="caption_renderer_overlay"]': 'Max', '.vjs-text-track-display': 'Video.js', '.jw-captions': 'JW Player',
    '.plyr__captions': 'Plyr', '.shaka-text-container': 'Shaka Player', '.bmpui-ui-subtitle-overlay': 'Bitmovin',
    '.art-subtitle': 'ArtPlayer', '.dplayer-subtitle': 'DPlayer',
  };
  const SITE_SELECTORS = [
    '.ytp-caption-window-container',                 // YouTube
    '.player-timedtext',                             // Netflix
    '.atvwebplayersdk-captions-text',                // Prime Video
    '.dss-subtitle-renderer-cue-window',             // Disney+
    '.hive-subtitle-renderer-cue-positioning-box',   // Disney+ (nuevo reproductor)
    '[data-testid="caption_renderer_overlay"]',      // Max
    '.vjs-text-track-display',                       // Video.js
    '.jw-captions',                                  // JW Player
    '.plyr__captions',                               // Plyr
    '.shaka-text-container',                         // Shaka Player
    '.bmpui-ui-subtitle-overlay',                    // Bitmovin
    '.art-subtitle',                                 // ArtPlayer
    '.dplayer-subtitle',                             // DPlayer
  ];

  // ───────────────────────── Motor ─────────────────────────
  let engineReady = null;
  function ensureEngine() {
    if (!engineReady) {
      engineReady = chrome.runtime.sendMessage({ to: 'bg', cmd: 'ensureEngine' }).then((r) => {
        if (!r || !r.ready) throw new Error((r && r.error) || 'engine');
        return r;
      });
      engineReady.catch(() => { engineReady = null; });
    }
    return engineReady;
  }
  async function engine(msg) {
    await ensureEngine();
    try {
      const r = await chrome.runtime.sendMessage({ to: 'engine', ...msg });
      if (r === undefined) throw new Error('no-receiver');
      return r;
    } catch (e) {
      engineReady = null;
      await ensureEngine();
      return chrome.runtime.sendMessage({ to: 'engine', ...msg });
    }
  }
  const engineOpts = () => ({ particles: S.particles, longVowels: S.longVowels, n: S.n });
  const anCache = new Map();
  function analyze(text) {
    const key = JSON.stringify(engineOpts()) + '\u0000' + text;
    let p = anCache.get(key);
    if (!p) {
      p = engine({ cmd: 'analyze', text, opts: engineOpts() });
      anCache.set(key, p);
      p.catch(() => anCache.delete(key));
      if (anCache.size > 600) anCache.delete(anCache.keys().next().value);
    }
    return p;
  }

  // ───────────────────────── Traducción ─────────────────────────
  const trCache = new Map();
  const pageTranslators = new Map();
  async function pageTranslate(text, target) {
    if (typeof Translator === 'undefined') throw new Error('no-api');
    if (!pageTranslators.has(target)) {
      const p = (async () => {
        const av = await Translator.availability({ sourceLanguage: 'ja', targetLanguage: target });
        if (av === 'unavailable') throw new Error('unsupported');
        if (av !== 'available') throw new Error('needs-download');
        return Translator.create({ sourceLanguage: 'ja', targetLanguage: target });
      })();
      pageTranslators.set(target, p);
      p.catch(() => pageTranslators.delete(target));
    }
    const tr = await pageTranslators.get(target);
    return tr.translate(text);
  }
  function translate(text) {
    const target = S.target, mode = S.trEngine || 'auto';
    const key = mode + '\u0000' + target + '\u0000' + text;
    if (trCache.has(key)) return trCache.get(key);
    const p = (async () => {
      // El motor intenta el traductor integrado y, si no está (o no tiene este idioma), el de en línea
      const r = await engine({ cmd: 'translate', text, target, mode }).catch((e) => ({ error: e.message }));
      if (r && r.text) return r.text;
      if (mode === 'online') throw new Error((r && r.error) || 'online-failed');
      try { return await pageTranslate(text, target); } catch (_) { /* siguiente opción */ }
      if (window !== window.top) {
        const rr = await chrome.runtime.sendMessage({ to: 'bg', cmd: 'translateViaTop', text, target }).catch(() => null);
        if (rr && rr.text) return rr.text;
      }
      throw new Error((r && r.error) || 'tr-failed');
    })();
    trCache.set(key, p);
    p.catch(() => trCache.delete(key));
    if (trCache.size > 600) trCache.delete(trCache.keys().next().value);
    return p;
  }
  const TR_ERR = {
    'needs-download': 'Abre Kantoro y pulsa «Descargar modelo», o elige el traductor «En línea».',
    'unsupported': 'El traductor integrado de Chrome no tiene este idioma: elige el traductor «En línea» o «Automático».',
    'no-api': 'Este Chrome no tiene traductor integrado: elige el traductor «En línea» o «Automático».',
    'online-failed': 'No se pudo traducir en línea (¿sin conexión?).',
  };

  // ───────────────────────── Control del reproductor ─────────────────────────
  const pausedByUs = new Map();
  function allVideos() { return [...document.querySelectorAll('video')]; }
  function mediaAction(action, token, relay = true) {
    if (action === 'pause') {
      const vids = allVideos().filter((v) => !v.paused && !v.ended);
      if (vids.length) { vids.forEach((v) => v.pause()); pausedByUs.set(token, vids); return; }
    } else {
      const vids = pausedByUs.get(token);
      if (vids) {
        pausedByUs.delete(token);
        vids.forEach((v) => { if (v.paused) v.play().catch(() => {}); });
        return;
      }
    }
    if (relay) chrome.runtime.sendMessage({ to: 'bg', cmd: 'media', action, token }).catch(() => {});
  }

  // ───────────────────────── Estilos (shadow DOM) ─────────────────────────
  // ── Estética Edo: papel washi, tinta sumi, bermellón de sello (shu), índigo (ai) y oro (kin) ──
  const F_SERIF = '"Palatino Linotype", "Book Antiqua", Palatino, Georgia, "Yu Mincho", "YuMincho", "Hiragino Mincho ProN", "Noto Serif JP", serif';
  // (si el equipo no tiene ninguna fuente mincho instalada, el japonés cae en Yu Gothic / Meiryo)
  const F_JP = '"Yu Mincho", "YuMincho", "Hiragino Mincho ProN", "Noto Serif JP", "BIZ UDPMincho", "MS PMincho", "Yu Gothic", "Meiryo", serif';
  const OVERLAY_CSS = `
    :host { all: initial; }
    .box { position: fixed; z-index: 2147483646; left: 0; top: 0; pointer-events: none; visibility: hidden;
      font-family: ${F_SERIF};
      text-align: center; color: #f7f0dc; padding: .14em .6em .2em; border-radius: .12em; box-sizing: border-box;
      background: rgba(24, 19, 14, .62); text-shadow: 0 0 3px #000, 0 1px 2px #000; line-height: 1.35;
      border-top: 1px solid rgba(201, 162, 74, .6); border-bottom: 1px solid rgba(201, 162, 74, .6);
      letter-spacing: .015em; -webkit-font-smoothing: antialiased; }
    .box.cover { background: rgba(24, 19, 14, .95); }
    .box.on { visibility: visible; }
    .tr { font-size: .8em; color: #f0cf87; font-weight: 500; margin-bottom: .08em; }
    .tr.err { color: #f2b3a4; font-size: .6em; }
    .ro { font-weight: 700; }
    .row { display: block; }
    .w { pointer-events: auto; cursor: help; border-radius: .1em; padding: 0 .05em; transition: background .06s; }
    .w:hover, .w.act { background: #c8402f; color: #fff; text-shadow: none; }
    .w.amb { text-decoration: underline dotted #e2b95a; text-decoration-thickness: .08em; text-underline-offset: .2em; }
    .w.guess { font-style: italic; color: #f3dca6; }
    .p { pointer-events: none; }
    .ja { font-size: .66em; opacity: .9; font-weight: 500; margin-top: .05em; font-family: ${F_JP}; }
    .tr.old { opacity: .5; }
    .live { opacity: .78; }
    .tk { overflow: hidden; white-space: nowrap; text-align: left; pointer-events: none;
      -webkit-mask-image: linear-gradient(to right, transparent 0, #000 9%, #000 100%); mask-image: linear-gradient(to right, transparent 0, #000 9%, #000 100%); }
    .rail { display: inline-block; white-space: nowrap; will-change: transform; padding-right: .3em; }
    .lane + .lane { margin-top: .12em; }
    .lane .ja { margin-top: 0; }
    .wd { display: inline-flex; flex-direction: column; align-items: center; vertical-align: top; }
    .jw { font-size: .6em; font-weight: 500; opacity: .9; line-height: 1.25; pointer-events: none;
      font-family: ${F_JP}; }
    .lane.tk { display: block; }
    .row2 { display: block; }
    .rail .w { pointer-events: auto; }
    .note { font-size: .55em; opacity: .8; font-weight: 400; }
    .x { pointer-events: auto; cursor: pointer; position: absolute; top: -.55em; right: -.55em; width: 1.2em; height: 1.2em;
      line-height: 1.15em; font-size: .6em; border-radius: 2px; background: #c8402f; color: #fff; text-shadow: none; display: none; }
    .sel .x { display: block; }`;

  // Ficha de diccionario: una hoja de washi colgada como un rollo (barras índigo arriba y abajo)
  const TIP_CSS = `
    :host { all: initial; }
    .tip { position: fixed; z-index: 2147483647; width: 380px; max-width: calc(100vw - 16px); max-height: min(62vh, 560px);
      overflow: auto; overscroll-behavior: contain; box-sizing: border-box; padding: 14px 16px 12px;
      background: linear-gradient(180deg, #f6eedc, #efe3c8); color: #2a231c; border: 1px solid #b9a680;
      border-top: 5px solid #1f3a5f; border-bottom: 5px solid #1f3a5f; border-radius: 3px;
      box-shadow: 0 18px 50px rgba(0,0,0,.55); font: 13.5px/1.5 ${F_SERIF};
      text-align: left; text-shadow: none; scrollbar-width: thin; scrollbar-color: #b9a680 transparent; }
    .hd { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding-bottom: 8px; border-bottom: 1px solid #c9b88f; }
    .big { font-size: 30px; line-height: 1.1; font-weight: 700; color: #1b1713; font-family: ${F_JP}; }
    .rd { color: #7a6a55; font-size: 14px; }
    .rm { color: #c8402f; font-size: 16px; font-weight: 700; }
    .warn { margin-top: 8px; padding: 6px 8px; border-radius: 2px; background: #f0dfb0; color: #6b4a12; font-size: 12.5px; border-left: 3px solid #c9a24a; }
    h4 { margin: 13px 0 6px; font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; color: #1f3a5f; font-weight: 700; }
    h4::before { content: "◆"; color: #c8402f; font-size: 8px; margin-right: 6px; vertical-align: 1px; }
    .ent { margin-bottom: 10px; }
    .ent-h { font-size: 14px; margin-bottom: 3px; }
    .ent-h b { font-family: ${F_JP}; font-weight: 700; }
    .chip { display: inline-block; font-size: 10.5px; padding: 1px 6px; margin: 0 4px 3px 0; border-radius: 2px; background: #e4d6b4; color: #5c4d38; }
    .chip.c { background: #d5dfc0; color: #4a6130; }
    .chip.m { background: #e6d2dc; color: #7a3d6a; }
    ol { margin: 2px 0 0; padding-left: 20px; }
    li { margin: 2px 0; }
    .es { margin-top: 4px; color: #1f3a5f; font-weight: 600; }
    .kj { display: grid; grid-template-columns: 52px 1fr; gap: 4px 10px; padding: 8px 0; border-top: 1px dashed #c9b88f; }
    .kj:first-of-type { border-top: 0; }
    .kc { font-size: 42px; line-height: 1; text-align: center; color: #1b1713; font-family: ${F_JP}; }
    .kmeta { font-size: 10.5px; color: #7a6a55; text-align: center; margin-top: 4px; }
    .lbl { color: #7a6a55; font-size: 11.5px; }
    .jp { font-family: ${F_JP}; }
    .kw { font-size: 12.5px; color: #4a3f30; }
    .gr { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; font-size: 12.5px; }
    .gr .jp { font-size: 14px; }
    .ft { margin-top: 10px; font-size: 10.5px; color: #9a8a70; }
    .ld { color: #7a6a55; padding: 6px 0; }`;

  function mkHost(css) {
    const host = document.createElement('kantoro-layer');
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    const st = document.createElement('style');
    st.textContent = css;
    root.appendChild(st);
    return { host, root };
  }
  function layerParent(anchorEl) {
    const fs = document.fullscreenElement;
    if (fs && fs.tagName !== 'IFRAME' && (!anchorEl || fs.contains(anchorEl))) return fs;
    return document.body || document.documentElement;
  }
  const isOurs = (e) => e.composedPath().some((n) => n && n.tagName === 'KANTORO-LAYER');

  // Texto japonés de una palabra analizada. 'kana': los kanji se sustituyen por su lectura en hiragana y lo que ya
  // es kana (katakana incluido, y partículas como は/へ/を) se deja tal cual se escribe.
  const KANJI_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005\u3006\u3007\u30f6]/;
  function jaOf(w) {
    if (S.origScript !== 'kana' || w.punct) return w.s;
    if (w.toks && w.toks.length) return w.toks.map((t) => (KANJI_RE.test(t.s) && t.k ? t.k : t.s)).join('');
    return KANJI_RE.test(w.s) && w.k ? w.k : w.s;
  }
  const jaLine = (words) => esc(words.map((w, i) => (S.origScript === 'kana' && i && !w.punct ? ' ' : '') + jaOf(w)).join(''));

  // ───────────────────────── Overlay ─────────────────────────
  class Overlay {
    constructor(anchor, opts = {}) {
      this.anchor = anchor;          // () => {rect, el, fontPx}
      this.opts = opts;
      const { host, root } = mkHost(OVERLAY_CSS);
      this.host = host;
      this.box = document.createElement('div');
      this.box.className = 'box' + (opts.selection ? ' sel' : '');
      root.appendChild(this.box);
      this.req = 0;
      this.visible = false;
      this.lastRect = '';
      this.loop = this.loop.bind(this);
      this.box.addEventListener('mouseover', (e) => this.onWord(e, true));
      this.box.addEventListener('mouseout', (e) => this.onWord(e, false));
      this.box.addEventListener('click', (e) => { if (e.target.classList.contains('x')) this.hide(); });
    }
    mount() {
      const a = this.anchor();
      const parent = layerParent(a && a.el);
      if (this.host.parentNode !== parent) parent.appendChild(this.host);
    }
    // Mientras el ratón está sobre este cuadro (sesión de hover), no se redibuja ni se oculta: la palabra bajo
    // el cursor no debe cambiar. La última actualización pendiente se aplica al salir.
    frozen(fn, args) {
      if (tip.session && tip.session.owner === this) { this.pending = () => fn.apply(this, args); return true; }
      return false;
    }
    flush() { const f = this.pending; this.pending = null; if (f) f(); }
    async render(text, t0 = performance.now()) {
      if (this.frozen(this.render, [text, t0])) return;
      const id = ++this.req;
      this.text = text;
      const slow = setTimeout(() => {
        if (id === this.req && !this.visible) this.draw(null, '<span class="note">Kantoro: cargando diccionario…</span>');
      }, 350);
      let res;
      try { res = await analyze(text); } catch (e) { clearTimeout(slow); return; }
      clearTimeout(slow);
      if (id !== this.req) return;
      this.res = res;
      this.trHTML = '';
      this.draw(res);
      this.host.dataset.latency = (performance.now() - t0).toFixed(1);
      this.host.dataset.engineMs = res.ms;
      if (S.mode === 'romaji+tr') {
        const flat = text.replace(/\s*\n\s*/g, ' ');
        translate(flat).then((tr) => {
          if (id !== this.req) return;
          this.setTr(esc(tr));
          this.host.dataset.trLatency = (performance.now() - t0).toFixed(1);
        }, (e) => { if (id === this.req) this.setTr(esc(TR_ERR[e.message] || 'Traducción no disponible.'), true); });
      }
    }
    draw(res, note) {
      if (this.frozen(this.draw, [res, note])) return;
      this.mount();
      const a = this.anchor();
      const fs = Math.max(13, Math.min(56, (a && a.fontPx ? a.fontPx * 0.9 : 22) * S.fontScale));
      this.box.style.fontSize = fs + 'px';
      this.box.classList.toggle('cover', S.position === 'cover' && !this.opts.selection && !this.opts.ocr);
      let html = '<span class="x" title="Cerrar">×</span>';
      if (S.mode === 'romaji+tr') html += `<div class="tr">${this.trHTML || '&#8203;'}</div>`;
      if (res) {
        this.words = [];
        html += '<div class="ro">' + res.lines.map((ln) => '<span class="row">' + ln.words.map((w) => {
          const i = this.words.push(w) - 1;
          const sp = w.sp ? ' ' : '';
          if (w.punct) return `${sp}<span class="p">${esc(w.r)}</span>`;
          return `${sp}<span class="w${S.markAmbiguous && w.amb ? ' amb' : ''}${w.guess ? ' guess' : ''}" data-i="${i}">${esc(w.r)}</span>`;
        }).join('') + '</span>').join('') + '</div>';
        if (S.showOriginal) html += `<div class="ja">${res.lines.map((ln) => jaLine(ln.words)).join('<br>')}</div>`;
      }
      if (note) html += `<div class="note">${note}</div>`;
      this.box.innerHTML = html;
      this.show();
    }
    // Pinta la voz por carriles (uno por personaje, uno encima del otro).
    // lanes: [{ id, color, words: [{...w, live}] , lead }]. ticker=true → cada carril es una cinta de ancho fijo
    // anclada a la DERECHA: las palabras entran por la derecha y salen por la izquierda.
    drawLanes(lanes, { ticker = false } = {}) {
      if (this.frozen(this.drawLanes, [lanes, { ticker }])) return;
      this.mount();
      const a = this.anchor();
      const fs = Math.max(13, Math.min(56, (a && a.fontPx ? a.fontPx * 0.9 : 22) * S.fontScale));
      this.box.style.fontSize = fs + 'px';
      this.box.classList.remove('cover');
      this.words = [];
      const orig = S.showOriginal;
      // En la cinta, cada palabra lleva su japonés justo debajo (se desplazan juntos)
      const stacked = ticker && orig;
      const wordsHTML = (ln) => ln.words.map((w, j) => {
        const i = this.words.push(w) - 1;
        const sp = j ? ' ' : '';
        const c = w.live ? ' live' : '';
        const inner = w.punct ? `<span class="p${c}">${esc(w.r)}</span>`
          : `<span class="w${c}${S.markAmbiguous && w.amb ? ' amb' : ''}${w.guess ? ' guess' : ''}" data-i="${i}" data-k="${w.key || ''}">${esc(w.r)}</span>`;
        if (!stacked) return (w.punct && !w.sp ? '' : sp) + inner;
        return `${sp}<span class="wd${c}" data-k="${w.key || ''}">${inner}<span class="jw">${esc(jaOf(w))}</span></span>`;
      }).join('');
      const wantTr = S.mode === 'romaji+tr';
      const sig = (ticker ? 't:' : 'p:') + lanes.map((l) => l.id).join(',') + (wantTr ? ':tr' : '') + (orig ? ':ja' : '');
      if (this.layout !== sig || !this.box.querySelector('.ro')) {
        this.layout = sig;
        this.box.innerHTML = '<span class="x" title="Cerrar">×</span>' + (wantTr ? `<div class="tr">${this.trHTML || '&#8203;'}</div>` : '') +
          '<div class="ro">' + lanes.map((l) => ticker ? `<div class="lane tk" data-l="${l.id}"><span class="rail"></span></div>` : `<div class="lane row2" data-l="${l.id}"></div>`).join('') + '</div>';
        this.shifts = {};
      }
      const width = Math.round(Math.min(innerWidth - 40, Math.max(320, (a && a.rect ? a.rect.width : innerWidth * 0.7))));
      for (const l of lanes) {
        const el = this.box.querySelector(`.lane[data-l="${l.id}"]`);
        if (!el) continue;
        el.style.color = l.color || '';
        if (!ticker) {
          el.innerHTML = '<div class="rl">' + (l.lead || '') + wordsHTML(l) + '</div>' +
            (orig ? `<div class="ja">${(l.lead ? '… ' : '') + jaLine(l.words)}</div>` : '');
          continue;
        }
        el.style.width = width + 'px';
        const rail = el.querySelector('.rail');
        // compensar las palabras antiguas recortadas por la izquierda para que lo visible no salte
        const firstKey = l.words[0] && l.words[0].key;
        const prev = this.shifts[l.id] || 0;
        let dx = 0;
        if (firstKey) { const old = rail.querySelector(`[data-k="${firstKey}"]`); if (old) dx = old.offsetLeft - rail.offsetLeft; }
        rail.innerHTML = wordsHTML(l);
        let cur = prev - dx;
        if (dx) { rail.style.transition = 'none'; rail.style.transform = `translateX(${cur}px)`; void rail.offsetWidth; }
        // anclada a la derecha: el final del texto siempre en el borde derecho
        const target = el.clientWidth - rail.scrollWidth;
        rail.style.transition = 'transform .45s cubic-bezier(.2,.7,.3,1)';
        rail.style.transform = `translateX(${target}px)`;
        this.shifts[l.id] = target;
      }
      this.show();
    }
    setTr(html, err) {
      this.trHTML = html;
      const el = this.box.querySelector('.tr');
      if (el) { el.innerHTML = html; el.classList.toggle('err', !!err); this.position(true); }
    }
    show() {
      this.visible = true;
      this.box.classList.add('on');
      this.position(true);
      if (!this.raf) this.raf = requestAnimationFrame(this.loop);
    }
    hide() {
      if (this.frozen(this.hide, [])) return;
      this.req++;
      this.visible = false;
      this.trHTML = '';
      this.box.classList.remove('on');
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
      if (tip.owner === this) tip.hideNow();
    }
    destroy() { if (tip.session && tip.session.owner === this) tip.endSession(); this.hide(); this.host.remove(); }
    hitEl() { return this.box; }
    loop() {
      this.raf = null;
      if (!this.visible) return;
      this.position(false);
      this.raf = requestAnimationFrame(this.loop);
    }
    position(force) {
      const a = this.anchor();
      if (!a || !a.rect || (a.rect.width === 0 && a.rect.height === 0)) { this.box.classList.remove('on'); return; }
      const r = a.rect;
      const key = `${r.left|0},${r.top|0},${r.width|0},${r.height|0},${innerWidth},${innerHeight}`;
      if (!force && key === this.lastRect) return;
      this.lastRect = key;
      this.box.classList.add('on');
      const maxW = Math.min(innerWidth - 16, Math.max(r.width + 40, innerWidth * 0.55));
      this.box.style.maxWidth = maxW + 'px';
      const bw = this.box.offsetWidth, bh = this.box.offsetHeight;
      const left = Math.max(8, Math.min(innerWidth - bw - 8, r.left + r.width / 2 - bw / 2));
      let top;
      if (S.position === 'cover' && !this.opts.selection && !this.opts.ocr) top = r.top + r.height / 2 - bh / 2;
      else {
        top = r.top - bh - 6;
        if (top < 4) top = r.bottom + 6;
      }
      top = Math.max(4, Math.min(innerHeight - bh - 4, top));
      this.box.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    }
    onWord(e, enter) {
      const el = e.target.closest && e.target.closest('.w');
      if (!el) return;
      const rel = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.w');
      if (rel === el) return;
      if (enter && el !== tip.el) tip.enter(this, el, this.words[+el.dataset.i]);
    }
  }

  // ───────────────────────── Tooltip con explicación ─────────────────────────
  const tip = {
    host: null, card: null, owner: null, token: null, hideT: null, req: 0, el: null,
    init() {
      if (this.host) return;
      const { host, root } = mkHost(TIP_CSS);
      this.host = host;
      this.card = document.createElement('div');
      this.card.className = 'tip';
      this.card.style.display = 'none';
      root.appendChild(this.card);
      // (la salida del cuadro/ficha la vigila la sesión de hover: ver track())
      this.card.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    },
    enter(owner, el, word) {
      this.init();
      clearTimeout(this.hideT);
      if (this.session && this.session.owner !== owner) this.endSession();
      if (!this.session) this.startSession(owner);
      if (this.el) this.el.classList.remove('act');
      this.owner = owner; this.el = el; el.classList.add('act');
      if (S.pauseOnHover && !this.token && !owner.opts.selection) {
        this.token = Math.random().toString(36).slice(2);
        mediaAction('pause', this.token);
      }
      const parent = layerParent(owner.anchor() && owner.anchor().el);
      if (this.host.parentNode !== parent) parent.appendChild(this.host);
      const id = ++this.req;
      this.card.style.display = 'block';
      this.card.innerHTML = this.header(word) + '<div class="ld">Buscando en el diccionario…</div>';
      this.place();
      engine({ cmd: 'explain', word, opts: engineOpts() }).then((ex) => {
        if (id !== this.req) return;
        this.card.innerHTML = this.header(word) + this.body(ex);
        this.card.scrollTop = 0;
        this.place();
      }).catch(() => {
        if (id === this.req) this.card.innerHTML = this.header(word) + '<div class="ld">No se pudo cargar la explicación.</div>';
      });
    },
    leave() { this.endSession(); },
    // Sesión de hover: empieza en la primera palabra y termina cuando el cursor sale del cuadro de subtítulos
    // (o de la ficha, o del pasillo entre ambos) durante más de 250 ms. Mientras dura, el vídeo sigue en pausa
    // y el cuadro no se redibuja. Se vigila con la posición real del ratón, no con eventos de entrada/salida,
    // así que no le afectan los espacios entre palabras ni los redibujados.
    startSession(owner) {
      const sess = { owner, outSince: 0 };
      this.session = sess;
      const inside = (x, y) => {
        const pad = 10;
        const inR = (r) => r && x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
        const hit = owner.hitEl && owner.hitEl();
        const b = hit && hit.getBoundingClientRect();
        const c = this.card && this.card.style.display !== 'none' ? this.card.getBoundingClientRect() : null;
        if (inR(b) || inR(c)) return true;
        // pasillo vertical entre el cuadro y la ficha
        if (b && c) {
          const top = Math.min(b.bottom, c.bottom), bot = Math.max(b.top, c.top);
          if (x >= c.left && x <= c.right && y >= Math.min(top, bot) - pad && y <= Math.max(top, bot) + pad) return true;
        }
        return false;
      };
      sess.move = (e) => {
        if (this.session !== sess) return;
        if (inside(e.clientX, e.clientY)) { sess.outSince = 0; return; }
        if (!sess.outSince) sess.outSince = performance.now();
      };
      sess.timer = setInterval(() => {
        if (this.session !== sess) return;
        if (sess.outSince && performance.now() - sess.outSince > 250) this.endSession();
      }, 60);
      addEventListener('pointermove', sess.move, { capture: true, passive: true });
      document.addEventListener('mouseleave', sess.leaveDoc = () => { if (!sess.outSince) sess.outSince = performance.now(); });
    },
    endSession() {
      const sess = this.session;
      if (!sess) return;
      this.session = null;
      clearInterval(sess.timer);
      removeEventListener('pointermove', sess.move, { capture: true });
      document.removeEventListener('mouseleave', sess.leaveDoc);
      this.hideNow();
      if (sess.owner && sess.owner.flush) sess.owner.flush(); // aplicar lo que llegó mientras estaba congelado
    },
    hideNow() {
      clearTimeout(this.hideT);
      if (this.session) { const s = this.session; this.session = null; clearInterval(s.timer); removeEventListener('pointermove', s.move, { capture: true }); document.removeEventListener('mouseleave', s.leaveDoc); if (s.owner && s.owner.flush) setTimeout(() => s.owner.flush(), 0); }
      this.req++;
      if (this.card) this.card.style.display = 'none';
      if (this.el) this.el.classList.remove('act');
      this.el = null; this.owner = null;
      if (this.token) {
        if (S.resumeOnLeave) mediaAction('resume', this.token);
        this.token = null;
      }
    },
    place() {
      if (!this.el) return;
      const r = this.el.getBoundingClientRect();
      const c = this.card;
      c.style.maxHeight = '';
      // Palabra dentro del panel de OCR: la ficha va a un lado del panel, sin taparlo
      if (this.owner === panel && panel.el) {
        const pr = panel.el.getBoundingClientRect();
        const w = c.offsetWidth;
        const left = pr.left - w - 10 >= 8 ? pr.left - w - 10 : Math.min(innerWidth - w - 8, pr.right + 10);
        c.style.maxHeight = (innerHeight - 16) + 'px';
        const h = c.offsetHeight;
        c.style.left = left + 'px';
        c.style.top = Math.max(8, Math.min(innerHeight - h - 8, r.top - 40)) + 'px';
        return;
      }
      const above = r.top - 16, below = innerHeight - r.bottom - 16;
      let h = c.offsetHeight;
      let top;
      if (h <= above) top = r.top - h - 8;
      else if (h <= below) top = r.bottom + 8;
      else if (above >= below) { c.style.maxHeight = above + 'px'; h = c.offsetHeight; top = r.top - h - 8; }
      else { c.style.maxHeight = below + 'px'; top = r.bottom + 8; }
      const w = c.offsetWidth;
      const left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
      c.style.left = left + 'px'; c.style.top = Math.max(8, top) + 'px';
    },
    header(w) {
      let h = `<div class="hd"><span class="big">${esc(w.s)}</span><span class="rd jp">${esc(w.k)}</span><span class="rm">${esc(w.r)}</span></div>`;
      if (w.guess) {
        h += '<div class="warn">⚠ Esta palabra no está en JMdict (suele ser un nombre propio). El rōmaji en cursiva es una <b>lectura estimada</b> carácter a carácter con KANJIDIC2: puede no ser la correcta.</div>';
      } else if (w.amb) {
        const alts = w.alt.map((a, i) => `<span class="jp">${esc(a)}</span> (${esc(w.ra[i] || '')})`).join(', ');
        h += `<div class="warn">⚠ Lectura dependiente del contexto. ${alts ? 'Otras lecturas registradas: ' + alts : 'La lectura no figura en JMdict; verifícala.'}</div>`;
      }
      return h;
    },
    body(ex) {
      let h = '';
      if (ex.entries.length) {
        h += '<h4>Significado</h4>';
        for (const e of ex.entries) {
          const forms = e.forms.length ? `<b>${esc(e.forms.slice(0, 3).join('・'))}</b> ` : '';
          const rd = e.readings.slice(0, 3).map((r) => `<span class="jp">${esc(r.kana)}</span> <i>${esc(r.romaji)}</i>`).join(' · ');
          h += `<div class="ent"><div class="ent-h">${forms}${rd} ${e.common ? '<span class="chip c">común</span>' : ''}</div>`;
          const es = e.es.length && S.target === 'es' ? `<div class="es">ES: ${esc(e.es.join('; '))}</div>` : '';
          if (es) h += es;
          h += '<ol>' + e.senses.map((s) => {
            const chips = s.pos.map((p) => `<span class="chip">${esc(p)}</span>`).join('') +
              s.misc.map((p) => `<span class="chip m">${esc(p)}</span>`).join('') +
              s.field.map((p) => `<span class="chip">${esc(p)}</span>`).join('');
            const info = s.info.length ? ` <span class="lbl">(${esc(s.info.join('; '))})</span>` : '';
            return `<li>${chips}<br>${esc(s.g.join('; '))}${info}</li>`;
          }).join('') + '</ol>';
          if (e.es.length && S.target !== 'es') h += `<div class="es">ES: ${esc(e.es.join('; '))}</div>`;
          h += '</div>';
        }
      } else h += '<h4>Significado</h4><div class="ld">Sin entrada en JMdict (puede ser un nombre propio o una forma muy coloquial).</div>';

      if (ex.kanji.length) {
        h += '<h4>Kanji que la componen</h4>';
        for (const k of ex.kanji) {
          if (!k.on) { h += `<div class="kj"><div class="kc">${esc(k.c)}</div><div class="ld">Sin datos en KANJIDIC2.</div></div>`; continue; }
          const meta = [k.strokes && `${k.strokes} trazos`, k.jlpt && `JLPT N${k.jlpt}`, k.grade && (k.grade <= 6 ? `${k.grade}º primaria` : k.grade === 8 ? 'secundaria' : 'jinmeiyō')].filter(Boolean).join('<br>');
          const mean = (S.target === 'es' && k.es.length ? k.es : k.en).join(', ');
          const on = k.on.map((x) => `<span class="jp">${esc(x.kana)}</span> ${esc(x.romaji)}`).join(' · ');
          const kun = k.kun.map((x) => `<span class="jp">${esc(x.kana)}</span> ${esc(x.romaji)}`).join(' · ');
          const words = k.words.map((x) => `<span class="jp">${esc(x.f)}</span> <i>${esc(x.romaji)}</i> — ${esc(x.g)}`).join('<br>');
          h += `<div class="kj"><div><div class="kc">${esc(k.c)}</div><div class="kmeta">${meta}</div></div><div>
            <div><b>${esc(mean)}</b></div>
            ${on ? `<div><span class="lbl">On'yomi:</span> ${on}</div>` : ''}
            ${kun ? `<div><span class="lbl">Kun'yomi:</span> ${kun}</div>` : ''}
            ${words ? `<div class="kw"><span class="lbl">Palabras frecuentes:</span><br>${words}</div>` : ''}
          </div></div>`;
        }
      }
      if (ex.grammar.length) {
        h += '<h4>Uso en esta frase</h4><div class="gr">' +
          ex.grammar.map((g) => `<span class="jp">${esc(g.s)}</span><span>${g.romaji ? `<i>${esc(g.romaji)}</i> — ` : ''}${esc(g.desc)}</span>`).join('') + '</div>';
      }
      h += '<div class="ft">JMdict / KANJIDIC2 © EDRDG (CC BY-SA 4.0) · análisis: kuromoji + IPADIC</div>';
      return h;
    },
  };

  // ───────────────────────── Fuentes de subtítulos (DOM) ─────────────────────────
  const tracked = new Map(); // elemento → {ov, mo, lastText}
  function selectorsForHere() {
    const custom = S.customSelectors && S.customSelectors[location.hostname];
    return custom ? SITE_SELECTORS.concat(custom) : SITE_SELECTORS;
  }
  function readText(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return '';
    return (el.innerText || '').replace(/ /g, ' ').trim();
  }
  function fontPxOf(el) {
    let t = el;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) if (n.nodeValue.trim()) { t = n.parentElement; break; }
    return parseFloat(getComputedStyle(t).fontSize) || 22;
  }
  function track(el) {
    if (tracked.has(el)) return;
    for (const other of tracked.keys()) if (other.contains(el)) return; // ya cubierto por un ancestro
    const entry = { el, lastText: null };
    entry.ov = new Overlay(() => ({ el, rect: textRect(el), fontPx: entry.fontPx }));
    entry.mo = new MutationObserver(() => update(entry));
    entry.mo.observe(el, { childList: true, subtree: true, characterData: true });
    tracked.set(el, entry);
    update(entry);
  }
  // Rectángulo del texto visible (no del contenedor completo, que suele ocupar todo el vídeo)
  function textRect(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) return el.getBoundingClientRect();
    const l = Math.min(...rects.map((r) => r.left)), t = Math.min(...rects.map((r) => r.top));
    const rr = Math.max(...rects.map((r) => r.right)), b = Math.max(...rects.map((r) => r.bottom));
    return { left: l, top: t, right: rr, bottom: b, width: rr - l, height: b - t };
  }
  function update(entry) {
    if (!alive()) return teardown();
    const t0 = performance.now();
    if (!S.enabled) { entry.ov.hide(); entry.lastText = null; return; }
    const text = readText(entry.el);
    if (text === entry.lastText) return;
    entry.lastText = text;
    if (!text || !JP.test(text)) { entry.ov.hide(); return; }
    entry.fontPx = fontPxOf(entry.el);
    entry.ov.render(text, t0);
  }
  let discoverQueued = false;
  function discover() {
    discoverQueued = false;
    if (dead) return;
    if (!alive()) return teardown();
    for (const [el, entry] of tracked) {
      if (!el.isConnected) { entry.mo.disconnect(); entry.ov.destroy(); tracked.delete(el); }
    }
    let els = [];
    try { els = document.querySelectorAll(selectorsForHere().join(',')); }
    catch (_) { els = document.querySelectorAll(SITE_SELECTORS.join(',')); }
    els.forEach(track);
    scanTracks();
    attachSubVideo();
    ensureBubble();
  }
  function queueDiscover() { if (!discoverQueued) { discoverQueued = true; queueMicrotask(discover); } }

  // ───────────────────────── Fuentes de subtítulos (TextTrack nativo) ─────────────────────────
  const trackEntries = new Map();
  function cueText(c) { return (c.text || '').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim(); }
  function scanTracks() {
    document.querySelectorAll('video').forEach((v) => {
      if (!v.__rjTracks) {
        v.__rjTracks = true;
        v.textTracks.addEventListener('addtrack', scanTracks);
        v.textTracks.addEventListener('change', scanTracks);
      }
      for (const tr of v.textTracks) {
        if (trackEntries.has(tr)) continue;
        const entry = { v, tr, lastText: null };
        entry.ov = new Overlay(() => {
          const r = v.getBoundingClientRect();
          return { el: v, fontPx: r.height * 0.05, rect: { left: r.left + r.width * 0.1, width: r.width * 0.8, top: r.bottom - r.height * 0.2, bottom: r.bottom - r.height * 0.06, height: r.height * 0.14, right: r.right - r.width * 0.1 } };
        });
        tr.addEventListener('cuechange', () => onCue(entry));
        trackEntries.set(tr, entry);
      }
    });
  }
  function onCue(entry) {
    const t0 = performance.now();
    const { tr, v } = entry;
    // Solo si el navegador pinta las pistas nativas; si el reproductor las pinta en DOM, las capta el MutationObserver
    if (!S.enabled || tr.mode !== 'showing') { entry.ov.hide(); entry.lastText = null; return; }
    const text = [...(tr.activeCues || [])].map(cueText).filter(Boolean).join('\n');
    if (text === entry.lastText) return;
    entry.lastText = text;
    if (!text || !JP.test(text)) { entry.ov.hide(); return; }
    entry.ov.render(text, t0);
    prefetch(tr, v);
  }
  // Las pistas nativas se conocen de antemano: precalcular las próximas ⇒ latencia ~0
  let prefetching = false;
  async function prefetch(tr, v) {
    if (prefetching || !tr.cues) return;
    prefetching = true;
    try {
      const now = v.currentTime;
      const next = [...tr.cues].filter((c) => c.startTime > now && c.startTime < now + 45).slice(0, 25);
      for (const c of next) {
        const t = cueText(c);
        if (!t || !JP.test(t)) continue;
        await analyze(t).catch(() => {});
        if (S.mode === 'romaji+tr') await translate(t.replace(/\s*\n\s*/g, ' ')).catch(() => {});
      }
    } finally { prefetching = false; }
  }


  // ───────────────────────── Archivos de subtítulos interceptados (Crunchyroll, .ass/.vtt/.srt) ─────────────────────────
  // El texto llega exacto y con sus tiempos: se sincroniza con el vídeo y el rōmaji se precalcula (latencia ≈ 0).
  const subFile = { cues: null, maxLen: 0, video: null, ov: null, last: null, raf: 0, url: null, locale: '', available: null };
  function bigVideos() {
    return [...document.querySelectorAll('video')]
      .map((v) => ({ v, r: v.getBoundingClientRect() }))
      .filter((x) => x.r.width > 200 && x.r.height > 120)
      .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  }
  function videoAnchor(v) {
    const r = v.getBoundingClientRect();
    return { el: v, fontPx: r.height * 0.05, rect: { left: r.left + r.width * 0.1, width: r.width * 0.8, top: r.bottom - r.height * 0.2, bottom: r.bottom - r.height * 0.06, height: r.height * 0.14, right: r.right - r.width * 0.1 } };
  }
  function loadSubFile(text, meta) {
    // Si el archivo es de una <track> de la página, ya lo gestiona la ruta nativa (TextTrack) con su vídeo correcto
    if (meta.url && [...document.querySelectorAll('track')].some((t) => t.src === meta.url)) return false;
    const p = RJSubs.parse(text, meta.format || meta.url || '');
    if (!p.isJapanese) return false; // p. ej. una pista en chino: mismos kanji, pero no es japonés
    const cues = p.cues.filter((c) => JP.test(c.text));
    if (!cues.length) return false;
    subFile.cues = cues;
    subFile.maxLen = Math.max(...cues.map((c) => c.end - c.start)) + 0.01;
    subFile.url = meta.url; subFile.locale = meta.locale || '';
    subFile.last = null;
    attachSubVideo();
    prefetchSubs();
    return true;
  }
  function attachSubVideo() {
    if (!subFile.cues) return;
    const best = bigVideos()[0];
    if (!best) return;
    const v = best.v;
    if (subFile.video === v) return;
    subFile.video = v;
    if (!subFile.ov) subFile.ov = new Overlay(() => subFile.video && videoAnchor(subFile.video));
    for (const ev of ['seeked', 'play', 'pause', 'timeupdate', 'ratechange']) v.addEventListener(ev, subTick, { signal: AC.signal });
    subLoop();
  }
  function subLoop() {
    cancelAnimationFrame(subFile.raf);
    const step = () => { subTick(); subFile.raf = requestAnimationFrame(step); };
    subFile.raf = requestAnimationFrame(step);
  }
  function subTick() {
    const v = subFile.video;
    if (!v || !subFile.cues || dead) return;
    if (!S.enabled || !S.subFiles) { if (subFile.last !== '') { subFile.last = ''; subFile.ov.hide(); } return; }
    const idx = RJSubs.activeAt(subFile.cues, v.currentTime, subFile.maxLen);
    const text = idx.map((i) => subFile.cues[i].text).join('\n');
    if (text === subFile.last) return;
    subFile.last = text;
    if (!text) subFile.ov.hide(); else subFile.ov.render(text);
  }
  // Precalcular rōmaji (y traducción) de todo el episodio, empezando por lo que viene a continuación
  let subPrefetchId = 0;
  async function prefetchSubs() {
    const id = ++subPrefetchId;
    const cues = subFile.cues;
    const t = subFile.video ? subFile.video.currentTime : 0;
    const order = cues.filter((c) => c.end >= t).concat(cues.filter((c) => c.end < t));
    for (const c of order) {
      if (id !== subPrefetchId || dead) return;
      await analyze(c.text).catch(() => {});
    }
    if (S.mode === 'romaji+tr') for (const c of order) {
      if (id !== subPrefetchId || dead) return;
      await translate(c.text.replace(/\s*\n\s*/g, ' ')).catch(() => {});
    }
  }
  cleanups.push(() => cancelAnimationFrame(subFile.raf));

  // Mensajes del script de la página (hook.js, mundo principal)
  addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data.__kantoro !== 'string') return;
    const d = e.data;
    if (d.__kantoro === 'subs-index' && Array.isArray(d.tracks)) {
      chrome.runtime.sendMessage({ to: 'bg', cmd: 'subsIndex', tracks: d.tracks.slice(0, 60).map((t) => ({ kind: String(t.kind), locale: String(t.locale), url: String(t.url), format: String(t.format) })) }).catch(() => {});
    } else if (d.__kantoro === 'subs-file' && typeof d.text === 'string') {
      chrome.runtime.sendMessage({ to: 'bg', cmd: 'subsText', url: String(d.url), text: d.text.slice(0, 4e6) }).catch(() => {});
    }
  }, { signal: AC.signal });

  // ───────────────────────── Texto seleccionado (cualquier página) ─────────────────────────
  let selRect = null;
  const selOverlay = new Overlay(() => selRect && { rect: selRect, fontPx: 20 }, { selection: true });
  document.addEventListener('mouseup', (e) => {
    if (!S.enabled || !S.selection || e.button !== 0 || isOurs(e)) return;
    setTimeout(() => {
      const sel = getSelection();
      const t = sel && sel.rangeCount ? sel.toString().trim() : '';
      if (!t || t.length > 500 || !JP.test(t)) return;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      selRect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      selOverlay.render(t);
    }, 0);
  }, { capture: true, signal: AC.signal });
  document.addEventListener('mousedown', (e) => { if (!isOurs(e) && selOverlay.visible) selOverlay.hide(); }, { capture: true, signal: AC.signal });
  document.addEventListener('scroll', () => { if (selOverlay.visible) selOverlay.hide(); }, { passive: true, capture: true, signal: AC.signal });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { tip.hideNow(); selOverlay.hide(); } }, { capture: true, signal: AC.signal });

  // ───────────────────────── Selector manual de subtítulos ─────────────────────────
  let picker = null;
  function cssPart(el) {
    if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id) && !/\d{3,}/.test(el.id)) return '#' + CSS.escape(el.id);
    const cls = [...el.classList].filter((c) => /^[a-zA-Z_-][\w-]*$/.test(c) && !/\d{4,}|^(active|visible|show|hidden|on|off)$/i.test(c)).slice(0, 2);
    return el.tagName.toLowerCase() + cls.map((c) => '.' + CSS.escape(c)).join('');
  }
  function cssPath(el) {
    const parts = [];
    for (let n = el, i = 0; n && n.nodeType === 1 && n !== document.body && i < 4; n = n.parentElement, i++) {
      const p = cssPart(n);
      parts.unshift(p);
      if (p.startsWith('#') || (p.includes('.') && document.querySelectorAll(parts.join(' > ')).length <= 3)) break;
    }
    return parts.join(' > ');
  }
  function blockAncestor(el) {
    let n = el;
    while (n.parentElement && n.parentElement !== document.body &&
      (getComputedStyle(n).display.startsWith('inline') || (n.parentElement.innerText || '').trim() === (n.innerText || '').trim())) n = n.parentElement;
    return n;
  }
  function startPicker() {
    if (picker) return;
    const { host, root } = mkHost(`:host{all:initial}
      .hl{position:fixed;z-index:2147483647;pointer-events:none;outline:2px solid #c8402f;background:rgba(200,64,47,.12);border-radius:2px;transition:all .05s}
      .bn{position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);background:#1b1713;color:#f3ead6;
        font:600 13px ${F_SERIF};padding:9px 14px;border-radius:3px;border:1px solid rgba(201,162,74,.6);box-shadow:0 6px 24px rgba(0,0,0,.5)}`);
    const hl = document.createElement('div'); hl.className = 'hl';
    const bn = document.createElement('div'); bn.className = 'bn';
    bn.textContent = 'Kantoro: haz clic sobre los subtítulos japoneses · Esc para cancelar';
    root.append(hl, bn);
    layerParent().appendChild(host);
    let cur = null;
    const move = (e) => {
      if (isOurs(e)) return;
      cur = blockAncestor(e.composedPath()[0].nodeType === 1 ? e.composedPath()[0] : e.target);
      const r = cur.getBoundingClientRect();
      Object.assign(hl.style, { left: r.left - 2 + 'px', top: r.top - 2 + 'px', width: r.width + 4 + 'px', height: r.height + 4 + 'px' });
    };
    const click = async (e) => {
      if (isOurs(e) || !cur) return;
      e.preventDefault(); e.stopPropagation();
      const sel = cssPath(cur);
      const { settings = {} } = await chrome.storage.sync.get('settings');
      settings.customSelectors = { ...(settings.customSelectors || {}), [location.hostname]: sel };
      settings.pickNonce = Date.now();
      await chrome.storage.sync.set({ settings });
      stopPicker();
    };
    const key = (e) => { if (e.key === 'Escape') stopPicker(); };
    addEventListener('mousemove', move, true);
    addEventListener('click', click, true);
    addEventListener('keydown', key, true);
    picker = { host, stop: () => { removeEventListener('mousemove', move, true); removeEventListener('click', click, true); removeEventListener('keydown', key, true); host.remove(); } };
  }
  function stopPicker() { if (picker) { picker.stop(); picker = null; } }


  // ───────────────────────── OCR: imágenes, canvas y subtítulos incrustados ─────────────────────────
  // El marco que "posee" la pantalla visible (el superior, o el iframe que está en pantalla completa)
  function ownsScreen() {
    const fs = document.fullscreenElement;
    if (fs) return fs.tagName !== 'IFRAME';
    return window === window.top;
  }
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const OCR_ERR = {
    capture: 'Chrome no ha permitido capturar esta pestaña. Si es un archivo local, activa «Permitir acceso a URLs de archivo» en chrome://extensions → Kantoro → Detalles.',
  };

  const REGION_CSS = `:host{all:initial}
    .shade{position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.28)}
    .rect{position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #c8402f;border-radius:2px;background:rgba(200,64,47,.08);display:none}
    .bar{position:fixed;z-index:2147483647;top:14px;left:50%;transform:translateX(-50%);display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:center;
      max-width:calc(100vw - 24px);background:#1b1713;color:#f3ead6;font:500 13px/1.3 ${F_SERIF};padding:8px 10px 8px 14px;
      border-radius:3px;border:1px solid rgba(201,162,74,.6);box-shadow:0 8px 30px rgba(0,0,0,.55);cursor:default}
    .bar b{font-weight:700;color:#f0cf87}
    .m{display:flex;background:#2e261e;border-radius:3px;padding:2px}
    .m button{all:unset;cursor:pointer;padding:5px 10px;border-radius:2px;color:#cdbf9f;font-weight:600;font-size:12px}
    .m button.on{background:#c8402f;color:#fff}
    .esc{all:unset;cursor:pointer;color:#cdbf9f;font-size:12px;padding:5px 8px;border-radius:2px;border:1px solid #4a3f30}`;

  let regionSel = null;
  function startRegion(stream = false) {
    if (!ownsScreen() || regionSel) return;
    stopPicker();
    tip.hideNow();
    const { host, root } = mkHost(REGION_CSS);
    const hasVideo = !!document.querySelector('video, iframe');
    let mode = hasVideo ? 'subs' : 'page';
    const shade = document.createElement('div'); shade.className = 'shade';
    const rect = document.createElement('div'); rect.className = 'rect';
    const bar = document.createElement('div'); bar.className = 'bar';
    bar.innerHTML = '<span><b>Kantoro OCR</b> · arrastra para marcar la zona con texto japonés</span>' +
      '<span class="m"><button data-m="page">Imagen / texto fijo</button><button data-m="subs">Subtítulos de vídeo (continuo)</button></span>' +
      '<button class="esc">Cancelar (Esc)</button>';
    const paint = () => bar.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    paint();
    bar.addEventListener('mousedown', (e) => e.stopPropagation());
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.m) { mode = b.dataset.m; paint(); } else { stop(); if (stream) chrome.runtime.sendMessage({ to: 'bg', cmd: 'capStop' }).catch(() => {}); }
    });
    root.append(shade, rect, bar);
    layerParent().appendChild(host);
    let start = null, cur = null;
    shade.addEventListener('mousedown', (e) => { e.preventDefault(); start = { x: e.clientX, y: e.clientY }; cur = null; });
    shade.addEventListener('mousemove', (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
      cur = { x, y, w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) };
      Object.assign(rect.style, { display: 'block', left: x + 'px', top: y + 'px', width: cur.w + 'px', height: cur.h + 'px' });
    });
    shade.addEventListener('mouseup', async () => {
      const r = cur; start = null;
      if (!r || r.w < 12 || r.h < 10) { rect.style.display = 'none'; return; }
      stop();
      await nextFrame(); // que la capa no salga en la captura
      if (mode === 'subs') startContinuous(r, stream);
      else { if (stream) chrome.runtime.sendMessage({ to: 'bg', cmd: 'capStop' }).catch(() => {}); runOcrOnce(r); }
    });
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); stop(); if (stream) chrome.runtime.sendMessage({ to: 'bg', cmd: 'capStop' }).catch(() => {}); } };
    addEventListener('keydown', key, { capture: true, signal: AC.signal });
    function stop() { removeEventListener('keydown', key, true); host.remove(); regionSel = null; }
    regionSel = { stop };
  }

  async function runOcrOnce(r0) {
    // Margen automático: una zona que corta los caracteres por el borde empeora mucho el OCR
    const P = 8;
    const r = { x: Math.max(0, r0.x - P), y: Math.max(0, r0.y - P) };
    r.w = Math.min(innerWidth, r0.x + r0.w + P) - r.x;
    r.h = Math.min(innerHeight, r0.y + r0.h + P) - r.y;
    panel.loading('Leyendo el texto de la zona…', r);
    await nextFrame();
    const sx = scrollX, sy = scrollY;
    const res = await chrome.runtime.sendMessage({ to: 'bg', cmd: 'ocrCapture', rect: r, viewW: innerWidth, kind: 'page' })
      .catch((e) => ({ error: String(e.message || e) }));
    if (!res || res.error) { panel.error(OCR_ERR[res && res.error] || 'No se pudo leer la zona: ' + ((res && (res.detail || res.error)) || '')); return; }
    panel.show(res, (b) => ({ left: b.x - (scrollX - sx), top: b.y - (scrollY - sy), width: b.w, height: b.h }), r);
  }

  function findImg(src) {
    return [...document.images].find((i) => i.currentSrc === src || i.src === src) || null;
  }
  function imgMapper(img, res) {
    return (b) => {
      const r = img.getBoundingClientRect();
      const fx = r.width / res.imgW, fy = r.height / res.imgH;
      return { left: r.left + b.x * fx, top: r.top + b.y * fy, width: b.w * fx, height: b.h * fy };
    };
  }

  // Panel lateral con las líneas reconocidas
  const PANEL_CSS = `:host{all:initial}
    .pn{position:fixed;z-index:2147483646;top:12px;width:420px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;
      box-sizing:border-box;background:#f3ead6;color:#2a231c;border:1px solid #b9a680;border-top:5px solid #1f3a5f;border-bottom:5px solid #1f3a5f;
      border-radius:3px;box-shadow:0 18px 50px rgba(0,0,0,.55);
      font:14px/1.5 ${F_SERIF};scrollbar-width:thin;scrollbar-color:#b9a680 transparent}
    .hd{position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:11px 12px 10px 14px;background:#efe3c8;border-bottom:1px solid #c9b88f}
    .hd b{flex:1;font-size:13px;color:#1f3a5f}.hd small{color:#7a6a55;font-weight:400}
    .bt{all:unset;cursor:pointer;font-size:12px;color:#4a3f30;border:1px solid #b9a680;border-radius:2px;padding:3px 8px}
    .bt:hover{border-color:#c8402f;color:#c8402f}
    .nt{padding:8px 14px 2px;font-size:11.5px;color:#7a6a55}
    .ln{padding:9px 14px;border-bottom:1px solid #dccfae}
    .ln:hover{background:#ece0c2}
    .tr{color:#1f3a5f;font-size:13px;margin-bottom:2px}
    .tr.err{color:#9e2b20;font-size:11.5px}
    .ro{font-weight:700;font-size:16px;color:#1b1713}
    .w{cursor:help;border-radius:2px;padding:0 1px}
    .w:hover,.w.act{background:#c8402f;color:#fff}
    .w.amb{text-decoration:underline dotted #a07a1f;text-underline-offset:3px}
    .ja{font-family:${F_JP};color:#5c4d38;font-size:14px;margin-top:2px}
    .ja u{text-decoration:underline wavy #c8402f;text-underline-offset:3px}
    .ld{padding:16px 14px;color:#7a6a55}
    .er{padding:14px;color:#9e2b20}
    .hl{position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #c8402f;border-radius:2px;background:rgba(200,64,47,.10);display:none}`;
  const panel = {
    opts: { selection: true }, words: [], host: null,
    anchor() { return { el: null }; },
    hitEl() { return this.el; },
    init() {
      if (this.host) { layerParent().appendChild(this.host); return; }
      const { host, root } = mkHost(PANEL_CSS);
      this.host = host;
      this.el = document.createElement('div'); this.el.className = 'pn';
      this.hl = document.createElement('div'); this.hl.className = 'hl';
      root.append(this.hl, this.el);
      this.el.addEventListener('mouseover', (e) => {
        const w = e.target.closest('.w');
        const rel = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.w');
        if (w && rel !== w && w !== tip.el) tip.enter(this, w, this.words[+w.dataset.i]);
        const ln = e.target.closest('.ln');
        if (ln && this.mapper && this.lines[+ln.dataset.l]) {
          const b = this.mapper(this.lines[+ln.dataset.l].box);
          Object.assign(this.hl.style, { display: 'block', left: b.left - 3 + 'px', top: b.top - 3 + 'px', width: b.width + 6 + 'px', height: b.height + 6 + 'px' });
        }
      });
      this.el.addEventListener('mouseout', (e) => {
        const w = e.target.closest('.w');
        const rel = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.w');
        if (!e.relatedTarget || !this.el.contains(e.relatedTarget)) this.hl.style.display = 'none';
      });
      this.el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (!b) return;
        if (b.dataset.a === 'x') this.close();
        if (b.dataset.a === 'copy') navigator.clipboard.writeText(this.lines.map((l) => l.text + '\n' + (l.romaji || '')).join('\n\n')).catch(() => {});
        if (b.dataset.a === 'again') startRegion();
      });
      layerParent().appendChild(host);
    },
    side(near) {
      const leftSide = near && (near.x ?? near.left) + (near.w ?? near.width) / 2 > innerWidth / 2;
      this.el.style.left = leftSide ? '12px' : '';
      this.el.style.right = leftSide ? '' : '12px';
    },
    head(title, extra = '') {
      return `<div class="hd"><b>${title}${extra}</b><button class="bt" data-a="again" title="Leer otra zona">Otra zona</button>` +
        '<button class="bt" data-a="copy">Copiar</button><button class="bt" data-a="x" title="Cerrar">✕</button></div>';
    },
    loading(msg, near) {
      this.init(); this.side(near); this.el.style.display = 'block'; this.hl.style.display = 'none';
      this.lines = []; this.mapper = null;
      this.el.innerHTML = this.head('Texto reconocido') + `<div class="ld">${esc(msg)} <br><small>La primera vez el OCR tarda unos segundos en cargar.</small></div>`;
    },
    error(msg) { this.init(); this.el.style.display = 'block'; this.el.innerHTML = this.head('Texto reconocido') + `<div class="er">${esc(msg)}</div>`; },
    close() { if (this.el) this.el.style.display = 'none'; if (this.hl) this.hl.style.display = 'none'; tip.hideNow(); },
    async show(res, mapper, near) {
      this.init(); if (near) this.side(near);
      this.el.style.display = 'block';
      this.mapper = mapper; this.words = [];
      if (!res.lines.length) { this.lines = []; this.el.innerHTML = this.head('Texto reconocido') + '<div class="er">No he encontrado texto japonés en esa zona. Prueba a marcar solo el texto, un poco más ajustado.</div>'; return; }
      // En los libros las líneas se cortan a mitad de palabra: agrupar hasta el final de frase
      const groups = [];
      let cur = null;
      for (const l of res.lines) {
        if (!cur) { cur = { text: '', parts: [], box: null }; groups.push(cur); }
        cur.parts.push(l);
        cur.text += l.text;
        const b = l.box;
        cur.box = cur.box ? (() => { const x = Math.min(cur.box.x, b.x), y = Math.min(cur.box.y, b.y);
          return { x, y, w: Math.max(cur.box.x + cur.box.w, b.x + b.w) - x, h: Math.max(cur.box.y + cur.box.h, b.y + b.h) - y }; })() : { ...b };
        if (/[。！？!?」』…]$/.test(l.text) || cur.text.length > 160) cur = null;
      }
      this.lines = groups;
      const tr = S.mode === 'romaji+tr';
      const nl = res.lines.length;
      this.el.innerHTML = this.head('Texto reconocido', ` <small>· ${nl} línea${nl > 1 ? 's' : ''} · ${(res.ms / 1000).toFixed(1)} s</small>`) +
        '<div class="nt">El OCR puede equivocarse: los caracteres con subrayado rojo ondulado son dudosos. Pasa el ratón por el rōmaji para ver el diccionario.</div>' +
        groups.map((g, i) => {
          const ja = g.parts.map((l) => { const low = new Set(l.low); return [...l.text].map((c, j) => (low.has(j) ? `<u>${esc(c)}</u>` : esc(c))).join(''); }).join('<br>');
          return `<div class="ln" data-l="${i}">${tr ? '<div class="tr">&#8203;</div>' : ''}<div class="ro">…</div><div class="ja">${ja}</div></div>`;
        }).join('');
      const rows = this.el.querySelectorAll('.ln');
      await Promise.all(groups.map(async (g, i) => {
        const a = await analyze(g.text).catch(() => null);
        if (!a) return;
        g.romaji = a.romaji;
        rows[i].querySelector('.ro').innerHTML = a.lines.map((ln) => ln.words.map((w) => {
          const k = this.words.push(w) - 1;
          return (w.sp ? ' ' : '') + (w.punct ? esc(w.r) : `<span class="w${S.markAmbiguous && w.amb ? ' amb' : ''}" data-i="${k}">${esc(w.r)}</span>`);
        }).join('')).join('<br>');
        if (tr) translate(g.text).then((t) => { rows[i].querySelector('.tr').textContent = t; },
          (e) => { const el = rows[i].querySelector('.tr'); el.textContent = TR_ERR[e.message] || 'Traducción no disponible.'; el.classList.add('err'); });
      }));
    },
  };

  // Modo continuo: relee la franja de subtítulos y dibuja el rōmaji encima
  let cont = null;
  const PILL_CSS = `:host{all:initial}.p{position:fixed;z-index:2147483646;display:flex;gap:6px;align-items:center;background:rgba(27,23,19,.93);
    color:#f3ead6;font:600 11.5px ${F_SERIF};padding:3px 4px 3px 9px;border-radius:3px;border:1px solid rgba(201,162,74,.5);box-shadow:0 3px 12px rgba(0,0,0,.4)}
    .d{width:8px;height:8px;border-radius:1px;background:#c8402f;animation:b 1.2s infinite}@keyframes b{50%{opacity:.25}}
    .lbl{white-space:nowrap}
    .st{font-weight:500;color:#cdbf9f;max-width:380px}.st:empty{display:none}.st.w{color:#f3bd5c}
    button{all:unset;cursor:pointer;width:18px;height:18px;text-align:center;line-height:18px;border-radius:2px;background:#3a3026}
    button:hover{background:#c8402f}
    .f{position:fixed;z-index:2147483645;pointer-events:none;border:1px dashed rgba(200,64,47,.6);border-radius:2px}`;
  function pillUI(label, anchorRect, onStop) {
    const { host, root } = mkHost(PILL_CSS);
    const pill = document.createElement('div'); pill.className = 'p';
    pill.innerHTML = `<span class="d"></span><span class="lbl">${esc(label)}</span><span class="st"></span><button title="Detener (Alt+O)">✕</button>`;
    const frame = document.createElement('div'); frame.className = 'f';
    const r = anchorRect;
    Object.assign(frame.style, { left: r.x - 2 + 'px', top: r.y - 2 + 'px', width: r.w + 4 + 'px', height: r.h + 4 + 'px', display: 'none' });
    root.append(frame, pill);
    layerParent().appendChild(host);
    // alineada por la derecha con la zona: así el monitor (texto de longitud variable) nunca se sale de la pantalla
    Object.assign(pill.style, { right: Math.max(8, Math.min(innerWidth - 200, innerWidth - (r.x + r.w))) + 'px', maxWidth: 'calc(100vw - 16px)', top: Math.max(8, Math.min(innerHeight - 30, r.y + r.h + 6)) + 'px' });
    pill.querySelector('button').addEventListener('click', onStop);
    pill.addEventListener('mouseenter', () => { frame.style.display = 'block'; });
    pill.addEventListener('mouseleave', () => { frame.style.display = 'none'; });
    return host;
  }

  // stream = true → OCR por fotogramas de la captura de pestaña (rápido, no se salta frases)
  function startContinuous(r, stream) {
    stopContinuous(false);
    const key = Math.random().toString(36).slice(2);
    const host = pillUI(stream ? 'Kantoro OCR · en vivo' : 'Kantoro OCR', r, () => stopContinuous(true));
    const ov = new Overlay(() => ({ el: null, rect: { left: r.x, top: r.y, width: r.w, height: r.h, right: r.x + r.w, bottom: r.y + r.h }, fontPx: cont && cont.fontPx }), { ocr: true });
    cont = { r, key, ov, host, busy: false, last: null, fontPx: 24, stream, seq: 0 };
    const show = (c, lines) => {
      const text = lines.map((l) => l.text).join('\n');
      if (lines.length) c.fontPx = Math.max(16, Math.min(44, lines.reduce((a, l) => a + l.box.h, 0) / lines.length * 0.75));
      if (text === c.last) return;
      c.last = text;
      if (!text) c.ov.hide(); else c.ov.render(text);
    };
    cont.show = show;
    if (stream) {
      chrome.runtime.sendMessage({ to: 'bg', cmd: 'ocrStreamRegion', rect: r, viewW: innerWidth, viewH: innerHeight, kind: 'subs' }).then((res) => {
        if (res && res.ok) return;
        // sin captura de pestaña: volver al modo de capturas de pantalla
        if (cont && cont.key === key) { const rr = cont.r; stopContinuous(false); startContinuous(rr, false); }
      }).catch(() => {});
      return;
    }
    const tick = async () => {
      const c = cont;
      if (!c || c.busy || document.hidden || tip.el || !S.enabled) return;
      c.busy = true;
      try {
        const res = await chrome.runtime.sendMessage({ to: 'bg', cmd: 'ocrCapture', rect: r, viewW: innerWidth, kind: 'subs', key });
        if (cont !== c || !res || res.same) return;
        if (res.error) { if (res.error === 'capture') { stopContinuous(true); panel.error(OCR_ERR.capture); } return; }
        show(c, res.lines);
      } catch (_) { /* reintento en el siguiente ciclo */ } finally { c.busy = false; }
    };
    cont.iv = setInterval(tick, 250);
    tick();
  }
  function stopContinuous(tellBg = true) {
    if (!cont) return;
    clearInterval(cont.iv);
    cont.ov.destroy();
    cont.host.remove();
    const wasStream = cont.stream;
    cont = null;
    if (tellBg && wasStream) chrome.runtime.sendMessage({ to: 'bg', cmd: 'capStop' }).catch(() => {});
  }

  // ───────────────────────── Audio: transcripción en vivo ─────────────────────────
  let asrUI = null;
  const ASR_ERR = {
    'network': 'Sin conexión con el servicio de reconocimiento de voz.',
    'not-allowed': 'Chrome no ha permitido el reconocimiento de voz.',
    'service-not-allowed': 'Chrome no ha permitido el reconocimiento de voz.',
    'language-not-supported': 'Este Chrome no reconoce japonés.',
    'audio-capture': 'No se pudo leer el audio de la pestaña.',
    'aborted': 'Chrome ha cortado el reconocimiento de voz varias veces seguidas (error «aborted») con los dos motores o con el único permitido. Prueba el otro motor en Kantoro → «Motor de voz».',
  };
  function startAsrUI(cfg) {
    const local = !!cfg.local;
    stopAsrUI(false);
    const v = bigVideos()[0];
    const anchor = () => {
      const vv = bigVideos()[0];
      if (vv) return videoAnchor(vv.v);
      return { el: null, fontPx: 26, rect: { left: innerWidth * 0.15, width: innerWidth * 0.7, top: innerHeight * 0.82, bottom: innerHeight * 0.9, height: innerHeight * 0.08, right: innerWidth * 0.85 } };
    };
    const vr = v ? v.r : { left: innerWidth * 0.1, top: innerHeight * 0.1, width: innerWidth * 0.8, height: innerHeight * 0.8 };
    const host = pillUI(asrLabel(local), { x: vr.left, y: vr.top, w: vr.width, h: Math.min(vr.height, innerHeight - vr.top - 40) }, () => stopAsrUI(true));
    asrUI = { host, ov: new Overlay(anchor), lanes: {}, lastSpk: -1, queue: Promise.resolve(), clearT: null, level: null, rec: null, seq: 0, local, paintMs: 0 };
    if (cfg.host) asrHostFrame(cfg);
  }
  const asrLabel = (local) => `Kantoro · escuchando (${local ? 'dispositivo' : 'Google'})`;
  // ── Voz: palabras por personaje ──
  // Colores de época: blanco de washi, azul asagi, oro yamabuki y lila fuji
  const SPK_COLORS = ['#f7f0dc', '#8fd0dc', '#f3bd5c', '#cdb0e2'];
  let asrKey = 0;
  // prev: palabras que ya estaban en pantalla en esa posición. Si una palabra no ha cambiado conserva su clave,
  // así la cinta no salta ni se reanima cada vez que el reconocedor alarga la frase.
  async function asrWords(text, live, prev) {
    const res = await analyze(text).catch(() => null);
    if (!res) return [];
    return res.lines.flatMap((l) => l.words).map((w, j) => {
      const old = prev && prev[j];
      return Object.assign({}, w, { key: old && old.s === w.s ? old.key : 'k' + (++asrKey), live });
    });
  }
  function laneOf(a, spk) {
    if (!S.asrSpeakers || spk < 0) spk = spk < 0 && a.lastSpk >= 0 && S.asrSpeakers ? a.lastSpk : 0;
    const id = S.asrSpeakers ? spk % 2 : 0;
    if (!a.lanes[id]) a.lanes[id] = { id, committed: [], fins: [], interim: [], color: '#fff', active: 0 };
    const L = a.lanes[id];
    L.color = S.asrSpeakers ? SPK_COLORS[spk % SPK_COLORS.length] : '#fff';
    return L;
  }
  function onAsr(msg) {
    const a = asrUI;
    if (!a) return;
    if (msg.status) { a.level = msg.status; asrMonitor(a); return; }
    if (msg.recStatus) { a.rec = msg.recStatus; asrMonitor(a); return; }
    if (msg.error) {
      a.ov.layout = null;
      a.ov.draw(null, `<span class="note">Kantoro: ${esc(ASR_ERR[msg.error] || msg.error)}${msg.fatal ? ' Transcripción detenida.' : ''}</span>`);
      if (msg.fatal) setTimeout(() => stopAsrUI(false), 6000);
      return;
    }
    if (msg.engine) { // el reconocedor ha cambiado de motor (modo automático)
      a.local = msg.engine === 'local';
      const lb = a.host.shadowRoot && a.host.shadowRoot.querySelector('.lbl');
      if (lb) lb.textContent = asrLabel(a.local);
      toast(`el reconocimiento ${a.local ? 'de Google no respondía: ahora se usa la voz japonesa del dispositivo' : 'en el dispositivo no respondía: ahora se usa el servicio de Google'}.`);
      return;
    }
    // Cola en orden: cada frase confirmada se procesa entera (análisis incluido) antes de la siguiente → nunca se
    // salta nada. Lo provisional solo importa en su versión más reciente: si mientras esperaba ha llegado algo
    // posterior, se descarta sin analizar (así la pantalla nunca va por detrás del reconocedor).
    const seq = ++a.seq;
    a.queue = a.queue.then(async () => {
      if (!msg.fin && seq < a.seq) return;
      if (msg.fin) {
        const L = laneOf(a, msg.spk);
        const words = await asrWords(msg.fin, false, L.interim);
        L.committed.push(...words);
        if (L.committed.length > 80) L.committed.splice(0, L.committed.length - 60);
        L.fins.push({ words, at: Date.now() });
        if (L.fins.length > 3) L.fins.shift();
        L.interim = []; L.active = Date.now();
        if (msg.spk >= 0) a.lastSpk = msg.spk;
        if (S.mode === 'romaji+tr') {
          const ov = a.ov, color = L.color;
          translate(msg.fin).then((t) => { if (asrUI === a) { ov.setTr(`<span style="color:${color}">${esc(t)}</span>`); } }, () => {});
        }
      }
      if (msg.interim !== undefined) {
        // lo provisional se muestra en el carril de quien parece estar hablando
        const tgt = msg.interim ? laneOf(a, msg.spk) : null;
        const prev = tgt ? tgt.interim : null;
        for (const L of Object.values(a.lanes)) L.interim = [];
        if (tgt) { tgt.interim = await asrWords(msg.interim, true, prev); tgt.active = Date.now(); }
      }
      paintAsr(a);
      if (msg.t) a.paintMs = Math.round(a.paintMs * 0.8 + (Date.now() - msg.t) * 0.2); // del reconocedor a la pantalla
    }).catch(() => {});
  }
  function paintAsr(a) {
    clearTimeout(a.clearT);
    const now = Date.now();
    const ticker = S.asrView === 'ticker';
    const lanes = [];
    const r = a.ov.anchor();
    const width = r && r.rect ? r.rect.width : innerWidth * 0.7;
    const fs = Math.max(13, Math.min(56, (r && r.fontPx ? r.fontPx * 0.9 : 22) * S.fontScale));
    const perLine = Math.max(20, Math.floor(width / (fs * 0.56)));
    for (const L of Object.values(a.lanes).sort((x, y) => x.id - y.id)) {
      if (now - L.active > (ticker ? 7000 : 4500)) continue; // carril inactivo: se oculta
      let words;
      if (ticker) words = L.committed.concat(L.interim);
      else {
        // Frase a frase: frases confirmadas recientes (cada una visible ≥ 2,5 s, para que dé tiempo a leerla)
        // + lo que se está oyendo. Si se acumula, se muestran las últimas palabras (máx. 2 renglones por carril).
        const recent = L.fins.filter((f) => now - f.at < 2500 || f === L.fins[L.fins.length - 1] && !L.interim.length && now - f.at < 4500);
        words = recent.flatMap((f) => f.words).concat(L.interim);
      }
      if (!words.length) continue;
      let lead = '';
      if (!ticker) {
        let total = 0, from = words.length;
        while (from > 0 && total + words[from - 1].r.length + 1 <= perLine * 2) { from--; total += words[from].r.length + 1; }
        if (from > 0) lead = '<span class="p">… </span>';
        words = words.slice(from);
      } else if (words.length > 70) words = words.slice(-70);
      lanes.push({ id: L.id, color: L.color, words, lead });
    }
    if (!lanes.length) { a.ov.layout = null; a.ov.hide(); return; }
    a.ov.drawLanes(lanes, { ticker });
    a.clearT = setTimeout(() => { if (asrUI === a) paintAsr(a); }, 800);
  }
  // Monitor en vivo: nivel de audio que llega, si el reconocedor oye voz y si devuelve texto
  function asrMonitor(a) {
    const el = a.host.shadowRoot && a.host.shadowRoot.querySelector('.st');
    if (!el) return;
    const st = a.level || { level: 0, maxLevel: 0, elapsed: 0 };
    const rc = a.rec || {};
    const bars = st.level > 0.06 ? '▮▮▮▮' : st.level > 0.02 ? '▮▮▮▯' : st.level > 0.006 ? '▮▮▯▯' : st.level > 0.0015 ? '▮▯▯▯' : '▯▯▯▯';
    // retraso medido: desde que empieza a sonar una voz hasta que su primer texto está en pantalla
    const lat = rc.lat ? ` · retraso ≈ ${((rc.lat + (a.paintMs || 0)) / 1000).toFixed(2).replace('.', ',')} s` : '';
    let txt = `audio ${bars} · ${rc.results ? rc.results + ' resultados' : rc.speech ? 'voz detectada' : rc.sound ? 'sonido detectado' : 'esperando voz'}${lat}${S.asrSpeakers && rc.voices ? ' · ' + rc.voices + (rc.voices > 1 ? ' voces' : ' voz') : ''}`;
    let warn = false;
    if (st.elapsed > 6 && st.maxLevel < 0.0015) {
      txt = 'No llega sonido de la pestaña: el vídeo está en pausa/silencio o su audio está protegido (DRM) y Chrome lo entrega mudo.';
      warn = true;
    } else if (!a.rec && st.elapsed > 5) {
      txt = `Llega audio ${bars}, pero el reconocedor no ha arrancado (la página puede estar bloqueando el marco de Kantoro).`;
      warn = true;
    } else if (st.elapsed > 15 && !rc.results && st.maxLevel >= 0.0015) {
      txt = `Llega audio ${bars}, pero el reconocedor no devuelve texto${rc.error ? ' (error: ' + rc.error + ')' : ''}` +
        `${rc.chunks === 0 ? ' — no le llega el audio' : ''}. ` + (a.local ? 'Prueba el motor «Servicio de Google» en Kantoro.' : 'Comprueba la conexión o prueba el motor «En el dispositivo».');
      warn = true;
    }
    el.textContent = txt;
    el.title = JSON.stringify({ nivel: st, reconocedor: rc, pintadoMs: a.paintMs });
    el.classList.toggle('w', warn);
  }

  // Marco invisible con el reconocedor, SIEMPRE en la página principal (visible y sin restricciones heredadas
  // del marco del reproductor). Se cuelga del <html> y no se mueve nunca (mover un iframe lo recarga).
  let asrFrameEl = null;
  function asrHostFrame(cfg) {
    removeAsrFrame();
    const f = document.createElement('iframe');
    f.src = chrome.runtime.getURL('asr/asr.html') + `#tab=${cfg.tabId}&frame=${cfg.uiFrame || 0}&local=${cfg.local ? 1 : 0}&auto=${cfg.auto ? 1 : 0}` +
      `&ctx=${encodeURIComponent(cfg.ctx || document.title || '')}&minConf=${cfg.minConf || 0.05}&maxFails=${cfg.maxFails || 3}`;
    f.allow = 'microphone; autoplay; on-device-speech-recognition';
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'all:initial;position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;border:0;pointer-events:none;z-index:-1;';
    document.documentElement.appendChild(f);
    asrFrameEl = f;
  }
  function removeAsrFrame() { if (asrFrameEl) { asrFrameEl.remove(); asrFrameEl = null; } }
  cleanups.push(removeAsrFrame);

  function stopAsrUI(tellBg = true) {
    if (!asrUI) return;
    clearTimeout(asrUI.clearT);
    removeAsrFrame();
    asrUI.ov.destroy();
    asrUI.host.remove();
    asrUI = null;
    if (tellBg) chrome.runtime.sendMessage({ to: 'bg', cmd: 'capStop' }).catch(() => {});
  }
  cleanups.push(() => stopAsrUI(false));

  // Avisos breves (errores al iniciar con el atajo, etc.)
  const NOTICE = {
    'no-stream': 'Chrome no ha permitido capturar esta pestaña. Ábrela, haz clic en ella y vuelve a pulsar Alt+O.',
    'no-api': 'Este Chrome no incluye reconocimiento de voz.',
    'asr-window': 'Esta web prohíbe usar funciones de voz dentro de su página. Kantoro ha abierto una ventanita propia para el reconocimiento: no la cierres (puedes dejarla detrás).',
    'asr-policy': 'Esta web prohíbe usar funciones de voz dentro de su página y no se pudo abrir la ventana auxiliar.',
    'local-downloadable': 'Falta la voz japonesa local: abre Kantoro y pulsa «Descargar voz japonesa» (o usa el servicio de Google).',
    'local-downloading': 'La voz japonesa se está descargando; prueba en un momento.',
    'local-unavailable': 'Este equipo no admite reconocimiento de japonés local: en Kantoro elige el motor «Automático» o «Servicio de Google».',
    'local-no-local-api': 'Este Chrome no admite reconocimiento local (Chrome 139+): en Kantoro elige el motor «Automático» o «Servicio de Google».',
  };
  function toast(text) {
    const { host, root } = mkHost(PILL_CSS + '.t{position:fixed;z-index:2147483647;left:50%;top:18px;transform:translateX(-50%);max-width:min(560px,90vw);background:#f3ead6;color:#2a231c;font:500 13px/1.45 ' + F_SERIF + ';padding:10px 14px;border-radius:3px;box-shadow:0 8px 30px rgba(0,0,0,.5);border:1px solid #b9a680;border-left:4px solid #c8402f}');
    const t = document.createElement('div'); t.className = 't'; t.textContent = 'Kantoro: ' + text;
    root.appendChild(t); layerParent().appendChild(host);
    setTimeout(() => host.remove(), 7000);
  }
  addEventListener('resize', () => { if (cont) stopContinuous(); }, { signal: AC.signal });


  // ───────────────────────── Burbuja flotante (abre Kantoro también en pantalla completa) ─────────────────────────
  // El popup de Chrome no puede abrirse en pantalla completa: la burbuja abre el mismo panel dentro de la página.
  const BUBBLE_CSS = `:host{all:initial}
    .b{position:fixed;z-index:2147483647;width:42px;height:42px;border-radius:6px;background:#c8402f;
      box-shadow:inset 0 0 0 2px #c8402f,inset 0 0 0 3.5px rgba(247,240,220,.85),0 4px 16px rgba(0,0,0,.45);
      cursor:pointer;display:grid;place-items:center;opacity:.34;transition:opacity .15s,transform .15s;user-select:none;touch-action:none}
    .b:hover,.b.open{opacity:1;transform:scale(1.06) rotate(-3deg)}
    .b span{font:700 23px/1 ${F_JP};color:#f7f0dc;pointer-events:none}
    .pn{position:fixed;z-index:2147483647;width:360px;height:min(600px,calc(100vh - 80px));border-radius:4px;overflow:hidden;
      box-shadow:0 18px 50px rgba(0,0,0,.6);border:1px solid #b9a680;background:#f3ead6;display:none}
    .pn.on{display:block}
    iframe{border:0;width:100%;height:100%;display:block;color-scheme:light}`;
  const bubble = { host: null, b: null, pn: null, frame: null, pos: null };
  function bubbleWanted() {
    if (!S.enabled || S.bubble === 'never' || !ownsScreen()) return false;
    if (S.bubble === 'always') return true;
    if (bigVideos().length || document.fullscreenElement) return true;
    // reproductor dentro de un iframe (p. ej. algunos servicios de streaming)
    return [...document.querySelectorAll('iframe')].some((f) => { const r = f.getBoundingClientRect(); return r.width >= 400 && r.height >= 225; });
  }
  function placeBubble() {
    const p = bubble.pos || { right: 18, bottom: 96 };
    const x = Math.max(6, Math.min(innerWidth - 48, innerWidth - 42 - p.right));
    const y = Math.max(6, Math.min(innerHeight - 48, innerHeight - 42 - p.bottom));
    Object.assign(bubble.b.style, { left: x + 'px', top: y + 'px' });
    // panel junto a la burbuja, hacia dentro de la pantalla
    const pw = 360, ph = Math.min(600, innerHeight - 80);
    let px = x + 21 > innerWidth / 2 ? Math.max(8, x - pw + 42) : Math.min(innerWidth - pw - 8, x);
    let py = y + 21 > innerHeight / 2 ? Math.max(8, y - ph - 10) : Math.min(innerHeight - ph - 8, y + 52);
    // Si no cabe encima/debajo sin tapar la burbuja, ponerlo a su lado
    const overlap = px < x + 42 + 6 && px + pw > x - 6 && py < y + 42 + 6 && py + ph > y - 6;
    if (overlap) {
      px = x + 21 > innerWidth / 2 ? Math.max(8, x - pw - 10) : Math.min(innerWidth - pw - 8, x + 52);
      py = Math.max(8, Math.min(innerHeight - ph - 8, y + 21 - ph / 2));
    }
    Object.assign(bubble.pn.style, { left: px + 'px', top: py + 'px' });
  }
  function ensureBubble() {
    const want = bubbleWanted();
    if (!want) { if (bubble.host) { bubble.host.remove(); } return; }
    if (!bubble.host) {
      const { host, root } = mkHost(BUBBLE_CSS);
      bubble.host = host;
      bubble.b = document.createElement('div'); bubble.b.className = 'b'; bubble.b.title = 'Kantoro'; bubble.b.innerHTML = '<span>読</span>'; // sello hanko: 読 = leer
      bubble.pn = document.createElement('div'); bubble.pn.className = 'pn';
      root.append(bubble.pn, bubble.b);
      try { bubble.pos = JSON.parse(localStorage.getItem('kantoroBubble') || 'null'); } catch (_) { bubble.pos = null; }
      // Arrastrar para moverla; clic para abrir/cerrar el panel
      let drag = null;
      bubble.b.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; bubble.b.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); });
      bubble.b.addEventListener('pointermove', (e) => {
        if (!drag) return;
        if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) drag.moved = true;
        if (!drag.moved) return;
        bubble.pos = { right: innerWidth - e.clientX - 21, bottom: innerHeight - e.clientY - 21 };
        placeBubble();
      });
      bubble.b.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        const moved = drag && drag.moved; drag = null;
        if (moved) { try { localStorage.setItem('kantoroBubble', JSON.stringify(bubble.pos)); } catch (_) { /* nada */ } return; }
        toggleBubblePanel();
      });
      bubble.b.addEventListener('click', (e) => e.stopPropagation());
    }
    const parent = layerParent();
    if (bubble.host.parentNode !== parent) parent.appendChild(bubble.host);
    placeBubble();
  }
  function toggleBubblePanel(force) {
    const open = force !== undefined ? force : !bubble.pn.classList.contains('on');
    if (open) {
      // se recarga cada vez para que el diagnóstico de la página esté al día
      bubble.pn.innerHTML = '';
      const f = document.createElement('iframe');
      f.src = chrome.runtime.getURL('popup/popup.html');
      f.allow = 'clipboard-write';
      bubble.frame = f;
      bubble.pn.appendChild(f);
    } else bubble.frame = null;
    bubble.pn.classList.toggle('on', open);
    bubble.b.classList.toggle('open', open);
    placeBubble();
  }
  addEventListener('message', (e) => {
    if (bubble.frame && e.source === bubble.frame.contentWindow && e.data && e.data.__kantoroPanel === 'close') toggleBubblePanel(false);
  }, { signal: AC.signal });
  document.addEventListener('mousedown', (e) => {
    if (bubble.pn && bubble.pn.classList.contains('on') && !isOurs(e)) toggleBubblePanel(false);
  }, { capture: true, signal: AC.signal });
  addEventListener('resize', () => { if (bubble.host && bubble.host.isConnected) placeBubble(); }, { signal: AC.signal });
  cleanups.push(() => { if (bubble.host) bubble.host.remove(); });

  // ───────────────────────── Mensajes y ciclo de vida ─────────────────────────
  function onMsg(msg, _s, sendResponse) {
    if (dead) return false;
    switch (msg.cmd) {
      case 'subFile':
        sendResponse({ ok: loadSubFile(msg.text, msg) && !!subFile.video });
        return false;
      case 'ocrStart':
        startRegion(!!msg.stream);
        return false;
      case 'ocrPush':
        if (cont && cont.stream && msg.seq > cont.seq) { cont.seq = msg.seq; cont.show(cont, msg.lines || []); }
        return false;
      case 'asrStart':
        startAsrUI(msg);
        return false;
      case 'asrHost':
        asrHostFrame(msg);
        return false;
      case 'asrPush':
        onAsr(msg);
        return false;
      case 'notice':
        if (ownsScreen()) toast(NOTICE[msg.code] || msg.code);
        return false;
      case 'capStopped':
        stopContinuous(false); stopAsrUI(false); removeAsrFrame();
        return false;
      case 'ocrBusy': {
        const img = findImg(msg.src);
        panel.loading('Leyendo el texto de la imagen…', img && img.getBoundingClientRect());
        return false;
      }
      case 'ocrImageResult': {
        const img = findImg(msg.src);
        panel.show(msg.res, img ? imgMapper(img, msg.res) : null);
        return false;
      }
      case 'ocrImageFallback': {
        const img = findImg(msg.src);
        if (img && ownsScreen()) {
          const r = img.getBoundingClientRect();
          const x = Math.max(0, r.left), y = Math.max(0, r.top);
          runOcrOnce({ x, y, w: Math.min(innerWidth, r.right) - x, h: Math.min(innerHeight, r.bottom) - y });
        } else startRegion();
        return false;
      }
      case 'translate':
        pageTranslate(msg.text, msg.target).then((text) => sendResponse({ text }), (e) => sendResponse({ error: e.message }));
        return true;
      case 'media':
        mediaAction(msg.action, msg.token, false);
        return false;
      case 'pick':
        startPicker();
        return false;
    }
    return false;
  }
  chrome.runtime.onMessage.addListener(onMsg);
  cleanups.push(() => chrome.runtime.onMessage.removeListener(onMsg));

  // Diagnóstico para el popup (se llama con chrome.scripting.executeScript en todos los marcos)
  window.__kantoroProbe = () => {
    const sources = [...tracked.values()].map((e) => ({
      site: Object.keys(SITE_NAMES).find((sel) => { try { return e.el.matches(sel); } catch (_) { return false; } }) ? SITE_NAMES[Object.keys(SITE_NAMES).find((sel) => e.el.matches(sel))] : 'selector propio',
      text: e.lastText || '', jp: JP.test(e.lastText || ''),
    }));
    const tracks = [...trackEntries.values()].map((e) => ({ mode: e.tr.mode, lang: e.tr.language, text: e.lastText || '', jp: JP.test(e.lastText || '') }));
    const big = (el) => { const r = el.getBoundingClientRect(); return r.width > 200 && r.height > 120; };
    return {
      top: window === window.top, host: location.hostname, enabled: S.enabled, sources, tracks,
      videos: [...document.querySelectorAll('video')].filter(big).length,
      canvases: [...document.querySelectorAll('canvas')].filter(big).length,
      images: [...document.querySelectorAll('img')].filter(big).length,
      jpText: JP.test((document.body && document.body.innerText || '').slice(0, 20000)),
      ocr: !!cont, asr: !!asrUI,
      subFile: subFile.cues ? { locale: subFile.locale, cues: subFile.cues.length, synced: !!subFile.video, text: subFile.last || '' } : null,
    };
  };
  cleanups.push(() => { delete window.__kantoroProbe; });

  function refreshAll() {
    for (const e of tracked.values()) { e.lastText = null; update(e); }
    for (const e of trackEntries.values()) { e.lastText = null; onCue(e); }
    subFile.last = null; // los subtítulos interceptados se redibujan con los ajustes nuevos
    if (asrUI) { asrUI.ov.layout = null; paintAsr(asrUI); }
    if (selOverlay.visible && selOverlay.text) selOverlay.render(selOverlay.text);
  }

  function onStore(ch, area) {
    if (dead || area !== 'sync' || !ch.settings) return;
    const old = S;
    S = { ...DEFAULTS, ...(ch.settings.newValue || {}) };
    if (S.pickNonce !== old.pickNonce) stopPicker();
    if (S.target !== old.target || S.mode !== old.mode || S.trEngine !== old.trEngine) trCache.clear();
    if (!S.enabled) tip.hideNow();
    discover();
    refreshAll();
  }
  chrome.storage.onChanged.addListener(onStore);
  cleanups.push(() => chrome.storage.onChanged.removeListener(onStore));

  document.addEventListener('fullscreenchange', () => {
    stopContinuous();
    if (asrUI) layerParent().appendChild(asrUI.host);
    ensureBubble();
    for (const e of tracked.values()) if (e.ov.visible) e.ov.draw(e.ov.res);
    for (const e of trackEntries.values()) if (e.ov.visible) e.ov.draw(e.ov.res);
    tip.hideNow();
  }, { signal: AC.signal });

  chrome.storage.sync.get('settings').then(({ settings }) => {
    S = { ...DEFAULTS, ...(settings || {}) };
    discover();
    if (dead) return;
    const gmo = new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && n.tagName !== 'KANTORO-LAYER') { queueDiscover(); return; }
    });
    gmo.observe(document.documentElement, { childList: true, subtree: true });
    const iv = setInterval(discover, 1500);
    cleanups.push(() => gmo.disconnect(), () => clearInterval(iv), () => stopContinuous(),
      () => { for (const e of tracked.values()) e.mo.disconnect(); });
    // Precargar el motor si la página contiene japonés
    if (JP.test((document.title || '') + (document.body ? document.body.innerText.slice(0, 3000) : ''))) ensureEngine().catch(() => {});
  });
})();
