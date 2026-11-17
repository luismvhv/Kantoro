/* Kantoro (web app) — escucha japonés por el micrófono y lo muestra en rōmaji, con diccionario al tocar.
 * Reconocimiento: Web Speech API del navegador (micrófono). Análisis: el motor de la extensión, en un Web Worker. */
'use strict';
const VERSION = '0.1.0';
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
  }).catch(() => {});
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
  'network': 'Sin conexión con el servicio de reconocimiento de voz.',
  'no-api': 'Este navegador no incluye reconocimiento de voz. Usa Chrome (Android o escritorio) o Safari reciente.',
};
const listener = {
  on: false, rec: null, fail: 0, interim: '', lastFinalAt: 0, starts: 0, results: 0,
  start() {
    const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
    if (!SR) { this.fatal('no-api'); return; }
    this.SR = SR; this.on = true; this.fail = 0; this.spawn();
    ui.listening(true);
  },
  stop() {
    this.on = false;
    try { this.rec && this.rec.stop(); } catch (_) { /* ya parado */ }
    ui.listening(false);
  },
  fatal(code) {
    this.on = false;
    try { this.rec && this.rec.abort(); } catch (_) { /* nada */ }
    ui.listening(false);
    setStatus(SR_ERR[code] || 'El reconocimiento de voz se ha detenido (' + code + ').', 'err');
  },
  spawn() {
    if (!this.on) return;
    const r = new this.SR();
    this.rec = r; this.starts++;
    r.lang = 'ja-JP'; r.continuous = !!S.continuous; r.interimResults = true; r.maxAlternatives = 1;
    let upTo = 0, lastFinal = '';
    this.interim = '';
    r.onresult = (e) => {
      this.fail = 0; this.results++;
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
    r.onerror = (e) => {
      if (!this.on || e.error === 'no-speech') return;
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(e.error)) { this.fatal(e.error); return; }
      if (++this.fail >= 5) this.fatal(e.error);
    };
    r.onend = () => {
      // lo que estaba "en curso" y no llegó a confirmarse no se pierde
      if (this.interim) { onSpeech('final', this.interim); this.interim = ''; }
      onSpeech('interim', '');
      if (this.on) setTimeout(() => this.spawn(), this.fail ? Math.min(2000, 400 * this.fail) : 0);
    };
    try { r.start(); }
    catch (err) { // p. ej. la sesión anterior aún no ha terminado de cerrarse
      if (++this.fail >= 5) this.fatal(String(err.name || err)); else setTimeout(() => this.spawn(), 300);
    }
  },
};
// Frases que no se cierran: se fuerza el cierre para que pasen a confirmadas (y se traduzcan)
setInterval(() => {
  if (listener.on && listener.rec && listener.interim.length > 60) { try { listener.rec.stop(); } catch (_) { /* nada */ } }
}, 500);

// ───────────── Interfaz ─────────────
let wakeLock = null;
const ui = {
  async listening(on) {
    $('btnMic').classList.toggle('on', on);
    $('btnMic').setAttribute('aria-label', on ? 'Detener' : 'Escuchar');
    if (on) setStatus('Escuchando… habla o acerca el móvil al sonido', 'live');
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
$('btnMic').addEventListener('click', () => { if (listener.on) listener.stop(); else listener.start(); });
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
  for (const id of ['showOriginal', 'translate', 'continuous', 'keepAwake']) $(id).checked = !!S[id];
  for (const id of ['origScript', 'target', 'longVowels', 'particles', 'fontScale']) $(id).value = S[id];
  $('fsOut').textContent = Math.round(S.fontScale * 100) + '%';
  $('origScript').closest('.row').classList.toggle('off', !S.showOriginal);
  $('target').closest('.row').classList.toggle('off', !S.translate || !HAS_TR);
  if (!HAS_TR) { $('translate').disabled = true; $('translate').checked = false; $('trStatus').textContent = 'Este navegador no incluye traductor integrado (hoy solo Chrome de escritorio). En el móvil la traducción no está disponible todavía.'; }
  $('ver').textContent = 'Kantoro web ' + VERSION;
}
$('btnSettings').addEventListener('click', () => { fillSettings(); $('settings').hidden = false; });
for (const id of ['showOriginal', 'translate', 'continuous', 'keepAwake']) {
  $(id).addEventListener('change', (e) => {
    S[id] = e.target.checked; save(); fillSettings(); repaintAll();
    if (id === 'translate' && S.translate && HAS_TR) translate('こんにちは').then(() => { $('trStatus').textContent = 'Traductor listo (en el dispositivo).'; }, (err) => { $('trStatus').textContent = 'No se pudo preparar el traductor: ' + err.message; });
    if (id === 'continuous' && listener.on) { listener.stop(); toast('Pulsa el sello para volver a escuchar con el nuevo modo.'); }
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
if (!ANDROID) $('privacy').textContent = 'El reconocimiento de voz lo hace el navegador; en Chrome usa el servicio de Google, así que el audio del micrófono sale del dispositivo mientras escucha.';
document.documentElement.style.setProperty('--fs', S.fontScale);
