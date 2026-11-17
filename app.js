/* Kantoro (web app) — escucha japonés por el micrófono y lo muestra en rōmaji, con diccionario al tocar.
 * Reconocimiento: Web Speech API del navegador (micrófono). Análisis: el motor de la extensión, en un Web Worker. */
'use strict';
const VERSION = '0.3.0';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ANDROID = /Android/i.test(navigator.userAgent);
const JP = /[぀-ヿ㐀-䶿一-鿿々]/;
const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々〆〇ヶ]/;

// ───────────── Ajustes (en este dispositivo) ─────────────
const DEFAULTS = {
  showOriginal: true, origScript: 'kanji', fontScale: 1, translate: false, target: 'es',
  longVowels: 'literal', particles: 'phonetic', n: 'n',
  continuous: !ANDROID,   // Chrome para Android repite resultados en sesión continua: allí, una frase por sesión
  keepAwake: true,
  rawMic: !ANDROID,       // micrófono sin cancelación de eco, entregado al reconocedor como pista (en Android, experimental)
  // Motor de voz: 'google' (reconocimiento del navegador, en la nube) | 'local' (Vosk, en el dispositivo).
  // En Android el de Google pausa los vídeos de otras apps en cada reinicio, así que allí se empieza con el local.
  engine: ANDROID ? 'local' : 'google',
  pipShape: 'strip',      // forma de la ventana flotante en el móvil: strip | wide | square | tall
};
let S = { ...DEFAULTS };
try { S = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('kantoro.settings') || '{}') }; } catch (_) { /* ajustes por defecto */ }
const save = () => { try { localStorage.setItem('kantoro.settings', JSON.stringify(S)); } catch (_) { /* modo privado */ } };
const engineOpts = () => ({ particles: S.particles, longVowels: S.longVowels, n: S.n });

function setStatus(text, cls) { const el = $('status'); el.textContent = text; el.className = cls || ''; }
let toastT = 0;
function toast(text, ms = 4500) { const t = $('toast'); t.textContent = text; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms); }

// ───────────── Motor (Web Worker) ─────────────
const worker = new Worker('engine-worker.js');
const waiting = new Map();
let rid = 0, engineReady = false;
worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.ev === 'ready') { engineReady = true; $('btnMic').disabled = false; setStatus(`Listo · diccionario cargado en ${(m.ms / 1000).toFixed(1)} s`, 'ok'); return; }
  if (m.ev === 'error') { setStatus('No se pudo cargar el diccionario: ' + m.error, 'err'); return; }
  const w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  if (m.err) w.reject(new Error(m.err)); else w.resolve(m.res);
};
worker.onerror = (e) => setStatus('Error del motor: ' + (e.message || 'desconocido'), 'err');
const engine = (msg) => new Promise((resolve, reject) => { const id = ++rid; waiting.set(id, { resolve, reject }); worker.postMessage({ id, ...msg }); });
const anCache = new Map();
function analyze(text) {
  const key = JSON.stringify(engineOpts()) + '\u0000' + text;
  let p = anCache.get(key);
  if (!p) {
    p = engine({ cmd: 'analyze', text, opts: engineOpts() });
    anCache.set(key, p); p.catch(() => anCache.delete(key));
    if (anCache.size > 400) anCache.delete(anCache.keys().next().value);
  }
  return p;
}

// ───────────── Traducción (Translator API del navegador; hoy solo en Chrome de escritorio) ─────────────
const HAS_TR = typeof self.Translator !== 'undefined';
const translators = new Map();
async function translate(text) {
  if (!HAS_TR) throw new Error('no-api');
  const target = S.target;
  if (!translators.has(target)) {
    const p = self.Translator.create({ sourceLanguage: 'ja', targetLanguage: target });
    translators.set(target, p); p.catch(() => translators.delete(target));
  }
  return (await translators.get(target)).translate(text);
}

// ───────────── Transcripción en pantalla ─────────────
const log = $('log');
const phrases = [];        // { text, words, el }
let live = null;           // frase provisional: { el, words }
let seq = 0, queue = Promise.resolve(), wkey = 0;

function jaOf(w) {
  if (S.origScript !== 'kana' || w.punct) return w.s;
  if (w.toks && w.toks.length) return w.toks.map((t) => (KANJI_RE.test(t.s) && t.k ? t.k : t.s)).join('');
  return KANJI_RE.test(w.s) && w.k ? w.k : w.s;
}
const jaLine = (words) => esc(words.map((w, i) => (S.origScript === 'kana' && i && !w.punct ? ' ' : '') + jaOf(w)).join(''));
function wordsHTML(words, pi) {
  return words.map((w, i) => {
    const sp = w.sp ? ' ' : '';
    if (w.punct) return sp + esc(w.r);
    return `${sp}<span class="w${w.amb ? ' amb' : ''}${w.guess ? ' guess' : ''}" data-p="${pi}" data-i="${i}">${esc(w.r)}</span>`;
  }).join('');
}
function paintPhrase(p, pi) {
  p.el.innerHTML = (S.translate && HAS_TR ? `<div class="tr">${p.tr ? esc(p.tr) : '&#8203;'}</div>` : '') +
    `<div class="ro">${wordsHTML(p.words, pi)}</div>` + (S.showOriginal ? `<div class="ja">${jaLine(p.words)}</div>` : '');
}
const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 140;
const toBottom = () => { log.scrollTop = log.scrollHeight; };

async function addFinal(text) {
  const res = await analyze(text).catch(() => null);
  if (!res) return;
  const words = res.lines.flatMap((l) => l.words);
  if (!words.length) return;
  const stick = nearBottom();
  $('empty').hidden = true;
  const el = document.createElement('div'); el.className = 'ph';
  const p = { text, words, el, tr: '' };
  const pi = phrases.push(p) - 1;
  paintPhrase(p, pi);
  if (live) { live.el.remove(); live = null; }
  log.appendChild(el);
  if (stick) toBottom();
  if (S.translate && HAS_TR) {
    translate(text).then((t) => { p.tr = t; const e = el.querySelector('.tr'); if (e) e.textContent = t; },
      () => { const e = el.querySelector('.tr'); if (e) { e.textContent = 'Traducción no disponible.'; e.classList.add('err'); } });
  }
  if (phrases.length > 300) { const old = phrases[phrases.length - 301]; if (old.el) { old.el.remove(); old.el = null; } }
}
async function setLive(text) {
  if (!text) { if (live) { live.el.remove(); live = null; } return; }
  const res = await analyze(text).catch(() => null);
  if (!res) return;
  const words = res.lines.flatMap((l) => l.words);
  const stick = nearBottom();
  $('empty').hidden = true;
  if (!live) { const el = document.createElement('div'); el.className = 'ph live'; live = { el, words: [] }; log.appendChild(el); }
  live.words = words;
  live.el.innerHTML = `<div class="ro" style="display:inline">${wordsHTML(words, -1)}</div>` + (S.showOriginal ? `<div class="ja">${jaLine(words)}</div>` : '');
  if (stick) toBottom();
}
// Cola en orden. Las frases confirmadas se procesan todas; de lo provisional solo importa la versión más reciente.
function onSpeech(kind, text) {
  const my = ++seq;
  queue = queue.then(() => {
    if (kind === 'interim' && my < seq) return null;
    return kind === 'final' ? addFinal(text) : setLive(text);
  }).then(() => pip.draw()).catch(() => {});
}
function repaintAll() {
  document.documentElement.style.setProperty('--fs', S.fontScale);
  anCache.clear();
  // el rōmaji depende de los ajustes: se vuelve a analizar cada frase visible
  phrases.forEach((p, pi) => { if (p.el) analyze(p.text).then((res) => { p.words = res.lines.flatMap((l) => l.words); paintPhrase(p, pi); }, () => {}); });
}

// ───────────── Micrófono: reconocimiento de voz del navegador ─────────────
const SR_ERR = {
  'not-allowed': 'El navegador no tiene permiso para usar el micrófono. Permítelo en el candado de la barra de direcciones y vuelve a pulsar el sello.',
  'service-not-allowed': 'El navegador no permite el reconocimiento de voz en esta página (hace falta HTTPS y, en Android, la app de Google activa).',
  'audio-capture': 'No se encuentra ningún micrófono.',
  'language-not-supported': 'Este navegador no reconoce japonés.',
  'network': 'No hay acceso al servicio de reconocimiento de voz de Google desde este navegador o esta red (pasa en Edge, Brave, Opera y con algunos bloqueadores). Cambia el motor a «Local».',
  'local-load': 'No se pudo cargar el reconocedor local: la primera vez hace falta conexión para descargar el modelo (50 MB) y memoria libre en el dispositivo.',
  'no-api': 'Este navegador no incluye reconocimiento de voz. Usa Chrome (Android o escritorio) o Safari reciente.',
};
const listener = {
  on: false, rec: null, fail: 0, interim: '', lastFinalAt: 0, starts: 0, results: 0,
  mode: 'mic', stream: null, track: null, level: -1, noSpeech: 0, heard: '', lastErr: '',
  // mode 'mic': micrófono. mode 'tab': audio de una pestaña o del sistema (solo escritorio).
  // Con S.rawMic el micrófono se abre SIN cancelación de eco ni supresión de ruido y se entrega al reconocedor
  // como pista: si no, el navegador elimina precisamente el sonido que sale por el altavoz del propio equipo.
  async start(mode = 'mic') {
    this.engine = S.engine === 'local' ? 'local' : 'google';
    if (this.engine === 'google') {
      const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
      if (!SR) { this.fatal('no-api'); toast('Este navegador no tiene el reconocimiento de Google: usa el motor «Local».', 7000); return; }
      this.SR = SR;
    }
    this.mode = mode; this.stream = null; this.track = null;
    this.level = -1; this.noSpeech = 0; this.results = 0; this.heard = ''; this.lastErr = '';
    const md = navigator.mediaDevices;
    try {
      if (mode === 'tab') {
        const st = await md.getDisplayMedia({ video: true, audio: true });
        const at = st.getAudioTracks()[0];
        if (!at) { st.getTracks().forEach((t) => t.stop()); toast('No se ha compartido el audio: elige una pestaña y marca «Compartir también el audio de la pestaña».', 8000); return; }
        this.stream = st; this.track = at;
        at.addEventListener('ended', () => { if (this.on) this.stop(); });
      } else if ((this.engine === 'local' || S.rawMic) && md && md.getUserMedia) {
        // sin cancelación de eco: si no, se elimina el sonido que sale por el altavoz del propio equipo
        this.stream = await md.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: this.engine === 'local', channelCount: 1 } });
        this.track = this.stream.getAudioTracks()[0] || null;
      }
    } catch (e) {
      if (mode === 'tab') { toast('No se ha compartido nada.'); return; }
      if (e && e.name === 'NotAllowedError') { this.fatal('not-allowed'); return; }
      if (this.engine === 'local') { this.fatal('audio-capture'); return; }
      this.stream = null; this.track = null; // sin acceso directo: micrófono normal del reconocedor
    }
    this.on = true; this.fail = 0; this.netRetry = false;
    ui.listening(true);
    if (this.engine === 'local') { localEng.start(this.track); return; }
    this.meterStart();
    this.spawn();
  },
  release() {
    localEng.stop();
    clearInterval(this.meterIv); this.meterIv = 0;
    if (this.actx) { this.actx.close().catch(() => {}); this.actx = null; }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    this.track = null;
  },
  stop() {
    this.on = false;
    try { this.rec && this.rec.stop(); } catch (_) { /* ya parado */ }
    this.release();
    ui.listening(false);
  },
  fatal(code) {
    this.on = false;
    try { this.rec && this.rec.abort(); } catch (_) { /* nada */ }
    this.release();
    ui.listening(false);
    setStatus(SR_ERR[code] || 'El reconocimiento de voz se ha detenido (' + code + ').', 'err');
  },
  // Nivel del sonido que llega (solo cuando la app tiene la pista de audio): sirve para ver si el fallo es de entrada
  meterStart() {
    if (!this.stream) return;
    try {
      const AC = self.AudioContext || self.webkitAudioContext;
      this.actx = new AC();
      const an = this.actx.createAnalyser(); an.fftSize = 2048;
      this.actx.createMediaStreamSource(new MediaStream([this.track])).connect(an);
      const buf = new Float32Array(an.fftSize);
      this.meterIv = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let e = 0; for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
        this.level = Math.sqrt(e / buf.length);
        this.paint();
      }, 400);
    } catch (_) { this.level = -1; }
  },
  // Estado en la cabecera: origen, nivel, qué oye el reconocedor y cuántas frases lleva
  paint() {
    if (!this.on) return;
    const l = this.level;
    const bars = l < 0 ? '' : ' · nivel ' + (l > 0.06 ? '▮▮▮▮' : l > 0.02 ? '▮▮▮▯' : l > 0.006 ? '▮▮▯▯' : l > 0.0015 ? '▮▯▯▯' : '▯▯▯▯');
    let txt = `${this.engine === 'local' ? 'Local' : 'Google'} · ${this.mode === 'tab' ? 'pestaña' : 'micrófono'}${bars} · ${this.results ? this.results + ' resultados' : this.heard || 'esperando voz'}`;
    let cls = 'live';
    if (!this.results && l >= 0 && l < 0.0015 && this.starts > 1) { txt = this.mode === 'tab' ? 'No llega sonido de lo compartido: ¿marcaste «Compartir también el audio»?' : 'El micrófono no capta sonido: revisa cuál es el micrófono del equipo y su volumen.'; cls = 'err'; }
    else if (!this.results && this.noSpeech >= 2) { txt += ' — el reconocedor no distingue voz' + (this.mode === 'mic' && !this.track ? ': sube el volumen o acerca el micrófono al altavoz' : ''); }
    if (this.lastErr && !this.results) txt += ` (${this.lastErr})`;
    setStatus(txt, cls);
  },
  spawn() {
    if (!this.on) return;
    const r = new this.SR();
    this.rec = r; this.starts++;
    r.lang = 'ja-JP'; r.continuous = !!S.continuous; r.interimResults = true; r.maxAlternatives = 1;
    let upTo = 0, lastFinal = '';
    this.interim = '';
    r.onresult = (e) => {
      this.fail = 0; this.results++; this.paint();
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        let t = (res[0] && res[0].transcript || '').trim();
        if (res.isFinal) {
          if (i < upTo) continue;
          upTo = i + 1;
          // Chrome para Android, en sesión continua, entrega cada final con todo lo anterior repetido delante
          if (ANDROID && lastFinal && t.startsWith(lastFinal)) { const cut = t.slice(lastFinal.length).trim(); lastFinal = t; t = cut; } else lastFinal = t;
          if (t) { this.lastFinalAt = Date.now(); onSpeech('final', t); }
        } else if (i >= upTo) interim += res[0].transcript;
      }
      interim = interim.trim();
      if (ANDROID && lastFinal && interim.startsWith(lastFinal)) interim = interim.slice(lastFinal.length).trim();
      this.interim = interim;
      onSpeech('interim', interim);
    };
    r.onaudiostart = () => { if (!this.heard) this.heard = 'micrófono abierto'; this.paint(); };
    r.onsoundstart = () => { this.heard = 'sonido detectado'; this.paint(); };
    r.onspeechstart = () => { this.heard = 'voz detectada'; this.paint(); };
    r.onerror = (e) => {
      if (!this.on) return;
      this.lastErr = e.error;
      if (e.error === 'no-speech') { this.noSpeech++; this.paint(); return; }
      // Sin acceso a Google con la pista propia: se prueba una vez con el micrófono normal del reconocedor
      if (e.error === 'network' && this.track && this.mode === 'mic' && !this.results && !this.netRetry) { this.netRetry = true; this.release(); this.level = -1; return; }
      if (e.error === 'network' && !this.results) { this.fatal('network'); return; }
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(e.error)) { this.fatal(e.error); return; }
      if (++this.fail >= 5) this.fatal(e.error);
    };
    r.onend = () => {
      // lo que estaba "en curso" y no llegó a confirmarse no se pierde
      if (this.interim) { onSpeech('final', this.interim); this.interim = ''; }
      onSpeech('interim', '');
      if (this.on) setTimeout(() => this.spawn(), this.fail ? Math.min(2000, 400 * this.fail) : 0);
    };
    try { if (this.track) r.start(this.track); else r.start(); }
    catch (err) {
      // este navegador no admite reconocer una pista de audio: se vuelve al micrófono normal del reconocedor
      if (this.track && this.mode === 'mic') { this.release(); this.level = -1; setTimeout(() => this.spawn(), 50); return; }
      // p. ej. la sesión anterior aún no ha terminado de cerrarse
      if (++this.fail >= 5) this.fatal(String(err.name || err)); else setTimeout(() => this.spawn(), 300);
    }
  },
};
// ───────────── Motor local: Vosk (Kaldi en WebAssembly) con el modelo japonés pequeño ─────────────
// No usa el reconocedor del navegador ni el de Android: el audio del micrófono se procesa en la propia página,
// sin conexión (salvo la primera descarga del modelo, que queda guardado) y sin pedir el foco de audio del sistema.
const VOSK_MODEL = 'models/vosk-model-small-ja-0.22.tar.gz';
// Vosk separa las palabras con espacios: se quitan entre caracteres no latinos (el japonés no los lleva)
const cleanJa = (s) => String(s || '').replace(/\s+/g, ' ').replace(/([^\x00-\x7f]) (?=[^\x00-\x7f])/g, '$1').trim();
const localEng = {
  model: null, loading: null, rec: null, ctx: null, proc: null, src: null, partial: '', since: 0, lastPaint: 0,
  load() {
    if (this.model) return Promise.resolve(this.model);
    if (!this.loading) {
      this.loading = new Promise((res, rej) => {
        if (self.Vosk) { res(); return; }
        const s = document.createElement('script');
        s.src = 'lib/vosk/vosk.js'; s.onload = () => res(); s.onerror = () => rej(new Error('vosk.js'));
        document.head.appendChild(s);
      }).then(() => Promise.race([
        self.Vosk.createModel(new URL(VOSK_MODEL, document.baseURI).href),
        // si la descarga falla, vosk-browser no avisa: se da por fallida a los 4 minutos
        new Promise((_, rej) => setTimeout(() => rej(new Error("tiempo agotado")), 240000)),
      ]))
        .then((m) => { this.model = m; return m; });
      this.loading.catch(() => { this.loading = null; });
    }
    return this.loading;
  },
  async start(track) {
    const t0 = Date.now();
    const iv = setInterval(() => setStatus(`Preparando el reconocedor local… ${Math.round((Date.now() - t0) / 1000)} s (la primera vez descarga 50 MB)`, 'live'), 500);
    let model;
    try { model = await this.load(); } catch (_) { clearInterval(iv); listener.fatal('local-load'); return; }
    clearInterval(iv);
    if (!listener.on || !track) return;
    const AC = self.AudioContext || self.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
    const rate = this.ctx.sampleRate;
    const rec = new model.KaldiRecognizer(rate);
    this.rec = rec; this.partial = '';
    rec.on('partialresult', (m) => {
      const p = cleanJa(m.result.partial);
      if (p === this.partial) return;
      if (p && !this.partial) this.since = Date.now();
      this.partial = p;
      if (p) { listener.results++; listener.heard = 'voz detectada'; }
      onSpeech('interim', p);
    });
    rec.on('result', (m) => {
      const t = cleanJa(m.result.text);
      this.partial = '';
      if (t) { listener.results++; onSpeech('final', t); }
      onSpeech('interim', '');
      listener.paint();
    });
    this.src = this.ctx.createMediaStreamSource(new MediaStream([track]));
    this.proc = this.ctx.createScriptProcessor(4096, 1, 1);
    this.proc.onaudioprocess = (ev) => {
      const d = ev.inputBuffer.getChannelData(0);
      if (this.rec === rec) rec.acceptWaveformFloat(d, rate);
      let e = 0; for (let i = 0; i < d.length; i += 4) e += d[i] * d[i];
      listener.level = Math.sqrt(e / (d.length / 4));
      const now = Date.now();
      if (now - this.lastPaint > 400) { this.lastPaint = now; listener.paint(); }
    };
    // Se conecta a un destino de flujo (no a los altavoces): procesa el audio sin reproducir nada
    this.src.connect(this.proc); this.proc.connect(this.ctx.createMediaStreamDestination());
    listener.heard = 'reconocedor local listo'; listener.paint();
  },
  // Frases que no se cierran (música de fondo sin silencios): se cierran a la fuerza
  tick() {
    if (this.rec && this.partial && (this.partial.length > 40 || Date.now() - this.since > 8000)) { this.since = Date.now(); this.rec.retrieveFinalResult(); }
  },
  stop() {
    if (this.proc) { this.proc.onaudioprocess = null; try { this.proc.disconnect(); this.src.disconnect(); } catch (_) { /* nada */ } this.proc = null; }
    if (this.rec) { const r = this.rec; this.rec = null; try { r.retrieveFinalResult(); } catch (_) { /* nada */ } setTimeout(() => { try { r.remove(); } catch (_) { /* nada */ } }, 2000); }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
    this.partial = '';
  },
};

// Frases que no se cierran: se fuerza el cierre para que pasen a confirmadas (y se traduzcan)
setInterval(() => {
  if (listener.on && listener.rec && listener.engine === 'google' && listener.interim.length > 60) { try { listener.rec.stop(); } catch (_) { /* nada */ } }
  if (listener.on && listener.engine === 'local') localEng.tick();
}, 500);

// ───────────── Ventana flotante (imagen en imagen) ─────────────
// Una web app no puede dibujar encima de otras apps, salvo con una ventana de vídeo «imagen en imagen»: los
// subtítulos se pintan en un lienzo, el lienzo se convierte en vídeo y ese vídeo se saca a la ventana flotante
// del sistema, que queda por encima de cualquier app (Crunchyroll, YouTube…).
// En el ordenador (Chrome/Edge de escritorio) se usa en su lugar una ventana flotante de documento, que se puede
// estirar libremente a lo ancho y a lo alto. En el móvil la ventana de vídeo mantiene la proporción del vídeo:
// la forma se elige (S.pipShape) y el tamaño se cambia pellizcándola.
const PIP_SHAPES = { strip: [956, 400], wide: [960, 540], square: [720, 720], tall: [600, 800] }; // Android: proporción máx. 2,39:1
const DOC_PIP = 'documentPictureInPicture' in self;
const PIP_CSS = `html,body{margin:0;height:100%;background:#1b1713;overflow:hidden}
  body{display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;box-sizing:border-box;
    border-top:4px solid #c9a24a;border-bottom:4px solid #c9a24a;padding:6px 14px;font-family:"Palatino Linotype","Book Antiqua",Georgia,serif}
  .b{margin:.12em 0}.r{font-weight:700;color:#f7f0dc;line-height:1.18}.j{font-family:"Yu Mincho","Yu Gothic","Noto Sans JP",sans-serif;font-size:.52em;color:#8c7f66;line-height:1.3}
  .dim .r{color:#a89a7c}.live .r{color:#f3bd5c}.live .j{color:#cfa85a}.idle{color:#cdbf9f;font-size:.6em}`;
const pip = {
  on: false, canvas: null, g: null, video: null, iv: 0, dw: null,
  supported: DOC_PIP || !!(document.pictureInPictureEnabled && HTMLCanvasElement.prototype.captureStream),
  // ventana de documento (escritorio): HTML real, el texto se ajusta al tamaño que le dé el usuario
  drawDoc() {
    const d = this.dw.document, items = this.lines();
    d.body.innerHTML = items.length ? items.map((it) => `<div class="b ${it.live ? 'live' : it.dim ? 'dim' : ''}"><div class="r">${esc(it.r)}</div><div class="j">${esc(it.ja)}</div></div>`).join('')
      : `<div class="idle">${listener.on ? 'Kantoro · escuchando…' : 'Kantoro · en pausa'}</div>`;
    const W = this.dw.innerWidth, H = this.dw.innerHeight;
    let fs = Math.min(72, Math.max(14, H / 2.4));
    d.body.style.fontSize = fs + 'px';
    while (fs > 12 && (d.body.scrollHeight > H + 1 || d.body.scrollWidth > W + 1)) { fs -= 2; d.body.style.fontSize = fs + 'px'; }
  },
  setShape(shape) {
    S.pipShape = PIP_SHAPES[shape] ? shape : 'strip'; save();
    if (!this.canvas) return;
    const [w, h] = PIP_SHAPES[S.pipShape];
    this.canvas.width = w; this.canvas.height = h; this.draw();
  },
  lines() { // lo último confirmado (tenue) y lo que se está oyendo (vivo)
    const out = [];
    const last = phrases[phrases.length - 1];
    const text = (ws) => ws.map((w) => (w.sp ? ' ' : '') + w.r).join('');
    if (last && (!live || !live.words.length)) { const prev = phrases[phrases.length - 2]; if (prev) out.push({ r: text(prev.words), ja: prev.text, dim: true }); }
    if (last) out.push({ r: text(last.words), ja: last.text, dim: !!(live && live.words.length) });
    if (live && live.words.length) out.push({ r: text(live.words), ja: live.words.map((w) => w.s).join(''), live: true });
    return out.slice(-2);
  },
  draw() {
    if (!this.on) return;
    if (this.dw) { this.drawDoc(); return; }
    const g = this.g, W = this.canvas.width, H = this.canvas.height;
    const maxRows = H > W ? 5 : H / W > 0.5 ? 3 : 2;
    g.fillStyle = '#1b1713'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#c9a24a'; g.fillRect(0, 0, W, 4); g.fillRect(0, H - 4, W, 4);
    const items = this.lines();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (!items.length) {
      g.fillStyle = '#cdbf9f'; g.font = '600 34px Georgia, serif';
      g.fillText(listener.on ? 'Kantoro · escuchando…' : 'Kantoro · en pausa', W / 2, H / 2);
      return;
    }
    // ajustar el tamaño para que todo quepa: cada frase es rōmaji (1–2 renglones) + japonés
    const wrap = (txt, font, max) => {
      g.font = font; const words = txt.split(' '), rows = []; let cur = '';
      for (const w of words) { const t = cur ? cur + ' ' + w : w; if (g.measureText(t).width > max && cur) { rows.push(cur); cur = w; } else cur = t; }
      if (cur) rows.push(cur); return rows;
    };
    let fs = Math.round(Math.min(W, H * 2.4) / 15), blocks, total;
    for (; fs >= 20; fs -= 3) {
      blocks = items.map((it) => ({ it, rows: wrap(it.r, `700 ${fs}px Georgia, serif`, W - 48).slice(-maxRows) }));
      total = blocks.reduce((n, b) => n + b.rows.length * fs * 1.2 + fs * 0.75, 0) + (blocks.length - 1) * fs * 0.3;
      if (total <= H - 24) break;
    }
    let y = (H - total) / 2;
    for (const b of blocks) {
      g.font = `700 ${fs}px Georgia, serif`; g.fillStyle = b.it.live ? '#f3bd5c' : b.it.dim ? '#a89a7c' : '#f7f0dc';
      for (const row of b.rows) { g.fillText(row, W / 2, y + fs * 0.6); y += fs * 1.2; }
      g.font = `500 ${Math.round(fs * 0.5)}px "Yu Gothic", "Noto Sans JP", "Noto Sans CJK JP", sans-serif`; g.fillStyle = b.it.live ? '#cfa85a' : '#8c7f66';
      let ja = b.it.ja; while (ja.length > 4 && g.measureText(ja).width > W - 48) ja = '…' + ja.slice(3);
      g.fillText(ja, W / 2, y + fs * 0.3); y += fs * 0.75 + fs * 0.3;
    }
  },
  async openDoc() {
    const w = await self.documentPictureInPicture.requestWindow({ width: S.pipW || 760, height: S.pipH || 210 });
    const st = w.document.createElement('style'); st.textContent = PIP_CSS; w.document.head.appendChild(st);
    w.document.title = 'Kantoro';
    this.dw = w; this.on = true;
    w.addEventListener('resize', () => { S.pipW = w.innerWidth; S.pipH = w.innerHeight; save(); this.draw(); });
    w.addEventListener('pagehide', () => { this.on = false; this.dw = null; $('btnPip').classList.remove('act'); });
    $('btnPip').classList.add('act');
    this.draw();
    toast('Ventana flotante abierta: estírala por los bordes al ancho y alto que quieras.', 6000);
  },
  async toggle() {
    if (this.on) {
      if (this.dw) { this.dw.close(); return; }
      try { await document.exitPictureInPicture(); } catch (_) { /* ya cerrada */ } return;
    }
    if (DOC_PIP) { try { await this.openDoc(); return; } catch (_) { /* se prueba con la ventana de vídeo */ } }
    if (ANDROID && listener.on && listener.engine === 'google') toast('Aviso: en Android el reconocimiento de Google pausa los vídeos de otras apps cada vez que se reinicia. Para ver anime en este móvil usa el motor «Local».', 9000);
    try {
      if (!this.canvas) {
        this.canvas = document.createElement('canvas');
        [this.canvas.width, this.canvas.height] = PIP_SHAPES[S.pipShape] || PIP_SHAPES.strip;
        this.g = this.canvas.getContext('2d');
        this.video = document.createElement('video'); this.video.muted = true; this.video.playsInline = true;
        this.video.srcObject = this.canvas.captureStream(12);
        this.video.addEventListener('leavepictureinpicture', () => { this.on = false; clearInterval(this.iv); $('btnPip').classList.remove('act'); });
      }
      this.on = true; this.draw();
      await this.video.play();
      await this.video.requestPictureInPicture();
      $('btnPip').classList.add('act');
      // el vídeo necesita fotogramas nuevos aunque el texto no cambie
      clearInterval(this.iv); this.iv = setInterval(() => this.draw(), 400);
      if (!(ANDROID && listener.engine === 'google')) toast('Ventana flotante abierta. Pellízcala para cambiar su tamaño; la forma se elige en Ajustes.', 7000);
    } catch (e) {
      this.on = false;
      toast('Este navegador no ha permitido abrir la ventana flotante (' + (e && e.name || 'error') + ').', 7000);
    }
  },
};

// ───────────── Interfaz ─────────────
let wakeLock = null;
const ui = {
  async listening(on) {
    $('btnMic').classList.toggle('on', on);
    $('btnMic').setAttribute('aria-label', on ? 'Detener' : 'Escuchar');
    if (on) listener.paint();
    else if ($('status').className !== 'err') setStatus('En pausa · pulsa el sello para escuchar', 'ok');
    try {
      if (on && S.keepAwake && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (_) { /* sin bloqueo de pantalla */ }
  },
};
document.addEventListener('visibilitychange', () => {
  // al volver a la app se recupera el bloqueo de pantalla; al salir, el navegador corta el micrófono
  if (document.visibilityState === 'visible' && listener.on && S.keepAwake && navigator.wakeLock) navigator.wakeLock.request('screen').then((w) => { wakeLock = w; }, () => {});
});
$('btnMic').addEventListener('click', () => { if (listener.on) listener.stop(); else listener.start('mic'); });
// Audio de una pestaña o del sistema (solo navegadores de escritorio): sonido limpio, sin pasar por el micrófono
if (!ANDROID && navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
  $('btnTab').hidden = false;
  $('btnTab').addEventListener('click', () => { if (listener.on) listener.stop(); listener.start('tab'); });
}
if (pip.supported) { $('btnPip').hidden = false; $('btnPip').addEventListener('click', () => pip.toggle()); }
$('btnClear').addEventListener('click', () => {
  phrases.length = 0; live = null; seq++;
  log.querySelectorAll('.ph').forEach((e) => e.remove());
  $('empty').hidden = false;
});
$('btnCopy').addEventListener('click', async () => {
  const text = phrases.map((p) => p.words.map((w) => (w.sp ? ' ' : '') + w.r).join('') + '\n' + p.text + (p.tr ? '\n' + p.tr : '')).join('\n\n');
  if (!text) { toast('Todavía no hay nada que copiar.'); return; }
  try { await navigator.clipboard.writeText(text); toast('Transcripción copiada.'); } catch (_) { toast('El navegador no ha permitido copiar.'); }
});

// Ficha de diccionario al tocar una palabra
let actEl = null;
log.addEventListener('click', (e) => {
  const el = e.target.closest('.w');
  if (!el) return;
  const pi = +el.dataset.p, word = pi < 0 ? live && live.words[+el.dataset.i] : phrases[pi] && phrases[pi].words[+el.dataset.i];
  if (!word) return;
  if (actEl) actEl.classList.remove('act');
  actEl = el; el.classList.add('act');
  openWord(word);
});
function header(w) {
  let h = `<div class="hd"><span class="bigw">${esc(w.s)}</span><span class="rd">${esc(w.k)}</span><span class="rm">${esc(w.r)}</span></div>`;
  if (w.guess) h += '<div class="warn">⚠ Esta palabra no está en el diccionario (suele ser un nombre propio). El rōmaji en cursiva es una <b>lectura estimada</b> carácter a carácter: puede no ser la correcta.</div>';
  else if (w.amb) {
    const alts = (w.alt || []).map((a, i) => `<span class="jp">${esc(a)}</span> (${esc((w.ra || [])[i] || '')})`).join(', ');
    h += `<div class="warn">⚠ Lectura dependiente del contexto. ${alts ? 'Otras lecturas registradas: ' + alts : 'Verifícala.'}</div>`;
  }
  return h;
}
function body(ex) {
  let h = '<h4>Significado</h4>';
  if (ex.entries.length) {
    for (const e of ex.entries) {
      const forms = e.forms.length ? `<b>${esc(e.forms.slice(0, 3).join('・'))}</b> ` : '';
      const rd = e.readings.slice(0, 3).map((r) => `<span class="jp">${esc(r.kana)}</span> <i>${esc(r.romaji)}</i>`).join(' · ');
      h += `<div class="ent"><div class="ent-h">${forms}${rd} ${e.common ? '<span class="chip c">común</span>' : ''}</div>`;
      if (e.es.length) h += `<div class="es">ES: ${esc(e.es.join('; '))}</div>`;
      h += '<ol>' + e.senses.map((s) => {
        const chips = s.pos.map((p) => `<span class="chip">${esc(p)}</span>`).join('') + s.misc.map((p) => `<span class="chip m">${esc(p)}</span>`).join('') +
          s.field.map((p) => `<span class="chip">${esc(p)}</span>`).join('');
        return `<li>${chips}${chips ? '<br>' : ''}${esc(s.g.join('; '))}${s.info.length ? ` <span class="lbl">(${esc(s.info.join('; '))})</span>` : ''}</li>`;
      }).join('') + '</ol></div>';
    }
  } else h += '<div class="ld">Sin entrada en el diccionario (puede ser un nombre propio o una forma muy coloquial).</div>';
  if (ex.kanji.length) {
    h += '<h4>Kanji que la componen</h4>';
    for (const k of ex.kanji) {
      if (!k.on) { h += `<div class="kj"><div class="kc">${esc(k.c)}</div><div class="ld">Sin datos.</div></div>`; continue; }
      const meta = [k.strokes && `${k.strokes} trazos`, k.jlpt && `JLPT N${k.jlpt}`, k.grade && (k.grade <= 6 ? `${k.grade}º primaria` : k.grade === 8 ? 'secundaria' : 'jinmeiyō')].filter(Boolean).join('<br>');
      const mean = (k.es.length ? k.es : k.en).join(', ');
      const on = k.on.map((x) => `<span class="jp">${esc(x.kana)}</span> ${esc(x.romaji)}`).join(' · ');
      const kun = k.kun.map((x) => `<span class="jp">${esc(x.kana)}</span> ${esc(x.romaji)}`).join(' · ');
      const words = k.words.map((x) => `<span class="jp">${esc(x.f)}</span> <i>${esc(x.romaji)}</i> — ${esc(x.g)}`).join('<br>');
      h += `<div class="kj"><div><div class="kc">${esc(k.c)}</div><div class="kmeta">${meta}</div></div><div><div><b>${esc(mean)}</b></div>` +
        (on ? `<div><span class="lbl">On'yomi:</span> ${on}</div>` : '') + (kun ? `<div><span class="lbl">Kun'yomi:</span> ${kun}</div>` : '') +
        (words ? `<div class="kw"><span class="lbl">Palabras frecuentes:</span><br>${words}</div>` : '') + '</div></div>';
    }
  }
  if (ex.grammar.length) {
    h += '<h4>Uso en esta frase</h4><div class="gr">' +
      ex.grammar.map((g) => `<span class="jp">${esc(g.s)}</span><span>${g.romaji ? `<i>${esc(g.romaji)}</i> — ` : ''}${esc(g.desc)}</span>`).join('') + '</div>';
  }
  return h;
}
let exReq = 0;
function openWord(word) {
  const id = ++exReq;
  $('sheetBody').innerHTML = header(word) + '<div class="ld">Buscando en el diccionario…</div>';
  $('sheet').hidden = false;
  engine({ cmd: 'explain', word, opts: engineOpts() }).then((ex) => { if (id === exReq) $('sheetBody').innerHTML = header(word) + body(ex); },
    () => { if (id === exReq) $('sheetBody').innerHTML = header(word) + '<div class="ld">No se pudo cargar la explicación.</div>'; });
}
for (const sh of document.querySelectorAll('.sheet')) {
  sh.addEventListener('click', (e) => { if (e.target.dataset.close) { sh.hidden = true; if (actEl) { actEl.classList.remove('act'); actEl = null; } } });
}

// Ajustes
function fillSettings() {
  for (const id of ['showOriginal', 'translate', 'continuous', 'keepAwake', 'rawMic']) $(id).checked = !!S[id];
  for (const id of ['origScript', 'target', 'longVowels', 'particles', 'fontScale']) $(id).value = S[id];
  $('fsOut').textContent = Math.round(S.fontScale * 100) + '%';
  $('origScript').closest('.row').classList.toggle('off', !S.showOriginal);
  $('target').closest('.row').classList.toggle('off', !S.translate || !HAS_TR);
  if (!HAS_TR) { $('translate').disabled = true; $('translate').checked = false; $('trStatus').textContent = 'Este navegador no incluye traductor integrado (hoy solo Chrome de escritorio). En el móvil la traducción no está disponible todavía.'; }
  $('ver').textContent = 'Kantoro web ' + VERSION;
  $('engine').value = S.engine; $('pipShape').value = S.pipShape;
  $('shapeRow').hidden = DOC_PIP; // en el ordenador la ventana se estira libremente
  $('engineNote').textContent = S.engine === 'local'
    ? 'Local: reconoce en el propio dispositivo con Vosk (modelo japonés de 50 MB que se descarga la primera vez y queda guardado). Funciona sin conexión y no interrumpe otras apps, pero acierta menos que Google, sobre todo con música de fondo.'
    : 'Google: más preciso, pero envía el audio a Google y necesita conexión. En Android pausa los vídeos de otras apps cada vez que se reinicia.';
  paintEngine();
}
function paintEngine() {
  $('privacy').textContent = S.engine === 'local' ? 'Motor local: el audio se reconoce en este dispositivo y no sale de él. La primera vez descarga el modelo de voz (50 MB).' : 'Motor Google: el audio del micrófono se envía al servicio de Google mientras escucha.';
  document.querySelectorAll('.engbar button').forEach((b) => b.classList.toggle('on', b.dataset.e === S.engine)); }
function setEngine(e) {
  if (e === S.engine) return;
  S.engine = e; save(); paintEngine();
  if (e === 'local') localEng.load().catch(() => {}); // empieza a descargar el modelo ya
  if (listener.on) { const m = listener.mode; listener.stop(); listener.start(m); }
}
document.querySelectorAll('.engbar button').forEach((b) => b.addEventListener('click', () => setEngine(b.dataset.e)));
$('engine').addEventListener('change', (e) => { setEngine(e.target.value); fillSettings(); });
$('pipShape').addEventListener('change', (e) => pip.setShape(e.target.value));
paintEngine();
$('btnSettings').addEventListener('click', () => { fillSettings(); $('settings').hidden = false; });
for (const id of ['showOriginal', 'translate', 'continuous', 'keepAwake', 'rawMic']) {
  $(id).addEventListener('change', (e) => {
    S[id] = e.target.checked; save(); fillSettings(); repaintAll();
    if (id === 'translate' && S.translate && HAS_TR) translate('こんにちは').then(() => { $('trStatus').textContent = 'Traductor listo (en el dispositivo).'; }, (err) => { $('trStatus').textContent = 'No se pudo preparar el traductor: ' + err.message; });
    if ((id === 'continuous' || id === 'rawMic') && listener.on) { listener.stop(); toast('Pulsa el sello para volver a escuchar con el nuevo modo.'); }
  });
}
for (const id of ['origScript', 'target', 'longVowels', 'particles']) $(id).addEventListener('change', (e) => { S[id] = e.target.value; save(); repaintAll(); });
$('fontScale').addEventListener('input', (e) => { S.fontScale = +e.target.value; $('fsOut').textContent = Math.round(S.fontScale * 100) + '%'; document.documentElement.style.setProperty('--fs', S.fontScale); });
$('fontScale').addEventListener('change', save);
$('btnTyped').addEventListener('click', () => {
  const t = $('typed').value.trim();
  if (!t) return;
  if (!JP.test(t)) { toast('Ese texto no contiene japonés.'); return; }
  t.split(/\n+/).forEach((line) => onSpeech('final', line.trim()));
  $('typed').value = ''; $('settings').hidden = true;
});

// Instalación como app (Chrome: menú ⋮ → «Instalar aplicación», o este botón cuando el navegador lo ofrece)
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('btnInstall').hidden = false; });
$('btnInstall').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; $('btnInstall').hidden = true; });
addEventListener('appinstalled', () => { $('btnInstall').hidden = true; toast('Kantoro instalada.'); });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (!self.isSecureContext) setStatus('Esta página no es segura (HTTP): el micrófono solo funciona por HTTPS o en localhost.', 'err');
// (la nota de privacidad de la pantalla inicial depende del motor elegido: ver paintEngine)
document.documentElement.style.setProperty('--fs', S.fontScale);
