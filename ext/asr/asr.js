/* Kantoro — reconocimiento de voz en un marco invisible DENTRO de la pestaña (o en una ventana propia si la web
 * prohíbe la voz). El audio llega del offscreen como PCM 16 kHz y se convierte en una pista para
 * SpeechRecognition.start(pista).
 *
 * Dos motores, intercambiables: el modelo japonés instalado en el dispositivo (processLocally) y el servicio de
 * Google. En modo automático, si el elegido falla o no devuelve nada, se pasa al otro sin detener la transcripción.
 *
 * Garantías para no perder palabras:
 *  1. Lo que el reconocedor ya había entendido ("en curso") se confirma si la sesión se corta, si el reconocedor
 *     abandona esa hipótesis sin confirmarla, o si la deja vacía sin dar un resultado final.
 *  2. Al (re)iniciar una sesión se le reinyecta TODO el audio que no llegó a oír (desde el corte, o desde el último
 *     resultado si estaba "sordo"), hasta 5 s; el solapamiento con lo ya mostrado se elimina.
 *  3. Vigilante: frases que no se cierran → se cierran; sesiones "sordas" (hay voz y no sale nada) → se reinician.
 *  4. Lo provisional se compone con TODOS los tramos sin confirmar, no solo con el último que cambió.
 * Contexto para acertar la palabra:
 *  5. Entre las alternativas que ofrece el reconocedor se elige con el diccionario (menos palabras inexistentes)
 *     y con el vocabulario de la sesión (nombres y términos que ya han salido).
 *  6. En el motor local, ese vocabulario y el título de la página se pasan como frases de contexto (biasing).
 * Además se estima quién habla (RJDiarize) para colorear y separar los diálogos. */
'use strict';

const P = new URLSearchParams(location.hash.slice(1));
const tabId = +P.get('tab'), frameId = +P.get('frame') || 0;
let useLocal = P.get('local') === '1';
const AUTO = P.get('auto') === '1';
const minConf = +P.get('minConf') || 0.05;
const maxFails = +P.get('maxFails') || 3;
const IN_WINDOW = P.get('window') === '1';
if (IN_WINDOW) document.body.classList.add('win');
const JP = /[぀-ヿ㐀-䶿一-鿿]/;
const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
const send = (m) => chrome.runtime.sendMessage(Object.assign({ to: 'bg', tabId, frameId }, m)).catch(() => {});
const stats = {
  results: 0, sound: 0, speech: 0, starts: 0, ends: 0, error: null, chunks: 0, mode: '', forced: 0, deaf: 0, promoted: 0,
  preroll: 0, rescued: 0, rescored: 0, biased: 0, lat: 0, engine: useLocal ? 'local' : 'cloud', switched: false,
};

// ── Pista de audio generada a partir del PCM recibido ──
const RATE = 16000;
let track = null, writeRaw = null;
if (typeof MediaStreamTrackGenerator === 'function' && typeof AudioData === 'function') {
  const gen = new MediaStreamTrackGenerator({ kind: 'audio' });
  const writer = gen.writable.getWriter();
  let ts = 0;
  track = gen;
  stats.mode = 'generator';
  writeRaw = (f32) => {
    const ad = new AudioData({ format: 'f32', sampleRate: RATE, numberOfFrames: f32.length, numberOfChannels: 1, timestamp: ts, data: f32 });
    ts += Math.round((f32.length / RATE) * 1e6);
    writer.write(ad).catch(() => {});
  };
} else {
  const ctx = new AudioContext({ sampleRate: RATE });
  const dest = ctx.createMediaStreamDestination();
  let next = 0;
  track = dest.stream.getAudioTracks()[0];
  stats.mode = 'audiocontext';
  writeRaw = (f32) => {
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const buf = ctx.createBuffer(1, f32.length, RATE);
    buf.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(dest);
    next = Math.max(next, ctx.currentTime + 0.02);
    src.start(next); next += buf.duration;
  };
}

function decode(b64) {
  const bin = atob(b64), n = bin.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 32768;
  }
  return out;
}

// ── Audio entrante: historial (para reinyectar), analizador de voces y detección de voz ──
const HISTORY_MS = 8000;
const history = []; // { t, f32 }
const diar = typeof RJDiarize !== 'undefined' ? new RJDiarize.Diarizer({ rate: RATE }) : null;
let loudMs = 0, voicedMs = 0;       // audio con nivel / con voz (tono detectado) desde el último resultado
let quietMs = 1000, onsetAt = 0;    // para medir el retraso voz → texto
const lats = [];
const port = chrome.runtime.connect({ name: 'rj-asr' });
port.postMessage({ hello: true, tabId });
port.onMessage.addListener((m) => {
  if (!m.pcm) return;
  stats.chunks++;
  const f32 = decode(m.pcm);
  const now = Date.now(), dur = (f32.length / RATE) * 1000, t0 = now - dur;
  history.push({ t: now, f32 });
  while (history.length && now - history[0].t > HISTORY_MS) history.shift();
  let e = 0; for (let i = 0; i < f32.length; i++) e += f32[i] * f32[i];
  const loud = Math.sqrt(e / f32.length) > 0.01;
  let voiced = loud;
  if (diar) {
    // Si el reloj del diarizador se ha separado del real (hubo un corte de audio), se vuelve a sincronizar
    if (diar.buf.length && Math.abs(diar.bufT + (diar.buf.length / RATE) * 1000 - t0) > 400) diar.buf = new Float32Array(0);
    diar.push(f32, t0);
    // ¿hay voz (tono) en las tramas de este trozo? La música de fondo se resta en el diarizador
    voiced = false;
    const made = Math.max(1, Math.round(f32.length / diar.hop)), len = diar.frames.length;
    for (let i = len - 1; i >= 0 && i >= len - made; i--) if (diar.frames[i].f0 > 0) { voiced = true; break; }
  }
  if (loud) loudMs += dur;
  if (voiced) {
    voicedMs += dur;
    if (quietMs >= 450 && !onsetAt) onsetAt = t0; // empieza a hablar alguien tras un silencio
    quietMs = 0;
  } else quietMs += dur;
  if (onsetAt && now - onsetAt > 4000) onsetAt = 0; // no era voz reconocible
  writeRaw(f32);
});
port.onDisconnect.addListener(() => { stopped = true; try { rec && rec.abort(); } catch (_) { /* nada */ } });

// Reinyectar al empezar una sesión el audio que el reconocedor no oyó: desde que se cortó la anterior (o desde su
// último resultado, si estaba sorda), con 0,4 s de margen. Mínimo 1 s, máximo 5 s.
let gapFrom = 0, gapOverride = 0;
function preroll() {
  const now = Date.now();
  if (!gapFrom) return; // primera sesión: nada que recuperar
  const span = Math.max(1000, Math.min(5000, now - gapFrom + 400));
  const chunks = history.filter((h) => now - h.t <= span);
  for (const c of chunks) writeRaw(c.f32);
  if (chunks.length) stats.preroll++;
}

// ── Texto ya mostrado: para no repetir palabras tras reinyectar audio ──
let shownTail = '';
function dedupe(text) {
  if (!text || !shownTail) return text;
  const max = Math.min(text.length, shownTail.length, 24);
  for (let k = max; k >= 3; k--) if (shownTail.endsWith(text.slice(0, k))) return text.slice(k);
  return text;
}

// ── Vocabulario de la sesión (contexto): nombres en katakana y términos en kanji que se repiten ──
const TERM = /[ァ-ヺー]{3,}|[一-鿿々]{2,}/g;
const vocab = new Map();
for (const w of (P.get('ctx') || '').match(TERM) || []) vocab.set(w, 3); // título de la página / serie
function learn(text) {
  for (const w of text.match(TERM) || []) vocab.set(w, (vocab.get(w) || 0) + 1);
  if (vocab.size > 400) { // olvidar lo que solo salió una vez
    for (const [w, n] of vocab) { if (n < 2) vocab.delete(w); if (vocab.size <= 300) break; }
  }
}
const known = () => [...vocab].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([w]) => w);

// Elegir entre las alternativas del reconocedor con el contexto: gana la primera salvo que otra tenga claramente
// menos palabras que no existen en el diccionario o contenga términos ya conocidos de la sesión.
async function pickAlt(alts) {
  const uniq = [];
  for (const a of alts) if (a.t && a.t.trim() && !uniq.some((u) => u.t === a.t)) uniq.push(a);
  if (uniq.length < 2) return uniq[0] || alts[0];
  const kn = known();
  const hits = (t) => kn.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
  let unk = null;
  try {
    const r = await Promise.race([
      chrome.runtime.sendMessage({ to: 'engine', cmd: 'score', texts: uniq.map((a) => a.t) }),
      new Promise((res) => setTimeout(res, 150)),
    ]);
    if (r && Array.isArray(r.unk)) unk = r.unk;
  } catch (_) { /* sin diccionario: solo vocabulario */ }
  const score = (a, i) => -0.25 * i + 0.6 * hits(a.t) - (unk ? 0.8 * (unk[i] || 0) : 0);
  const s0 = score(uniq[0], 0);
  let best = 0, bs = s0;
  for (let i = 1; i < uniq.length; i++) { const s = score(uniq[i], i); if (s >= s0 + 0.5 && s > bs) { bs = s; best = i; } }
  if (best) stats.rescored++;
  return uniq[best];
}

// ── Quién habla ──
let uttStart = 0;              // cuándo empezó la frase actual (primer resultado tras la anterior)
function speakerFor(finalize) {
  if (!diar) return -1;
  const now = Date.now();
  // El reconocedor entrega los resultados con retraso: la frase sonó aproximadamente entre
  // (primer resultado − 1 s) y (ahora − 0,2 s)
  const f = diar.features(uttStart - 1000, now - 200);
  return finalize ? diar.resolve(diar.assign(f)) : diar.peek(f);
}

// ── Reconocimiento ──
let safe = 0; // 0 = todo activo · 1 = sin frases de contexto · 2 = además sin alternativas (como la 1.5)
let rec = null, stopped = false, failStreak = 0, restarts = 0, switched = false, phrasesOk = typeof self.SpeechRecognitionPhrase === 'function';
let lastResultAt = Date.now(), lastFinalAt = Date.now(), forcing = false, deafStreak = 0, deafMul = 1;
let interimNow = '', interimSince = 0, lastSent = '', orphan = null, finalUpTo = 0;
// Cola de salida: todo lo que se emite pasa por aquí, en orden (elegir alternativa puede tardar unos ms)
let outQ = Promise.resolve();
const push = (fn) => { outQ = outQ.then(fn).catch(() => {}); };

function emitFinal(text, conf, promoted) {
  text = dedupe(text.trim());
  if (!JP.test(text)) return;
  const spk = speakerFor(true);
  shownTail = (shownTail + text).slice(-40);
  lastFinalAt = Date.now();
  learn(text);
  send({ cmd: 'asrPush', fin: text, conf, spk, promoted: !!promoted, t: Date.now() });
}
// El reconocedor ha cambiado de hipótesis por otra que no continúa la anterior (la abandonó sin confirmarla)
function abandoned(prev, cur) {
  return prev.length >= 4 && Date.now() - interimSince > 800 && cur.length <= prev.length * 0.5 &&
    prev[0] !== cur[0] && !prev.includes(cur.slice(0, 2));
}
function setInterim(raw, hadFinal) {
  let it = dedupe(raw.trim());
  if (!JP.test(it)) it = '';
  if (!hadFinal && interimNow && it && abandoned(interimNow, it)) {
    stats.rescued++; emitFinal(interimNow, 0, true); interimNow = '';
    it = dedupe(raw.trim()); if (!JP.test(it)) it = '';
  }
  if (!it && interimNow && !hadFinal) {
    // se quedó sin texto y sin resultado final: si el final no llega enseguida, se confirma lo que había
    orphan = { text: interimNow, at: Date.now() };
    interimNow = '';
    return; // la pantalla conserva lo provisional mientras tanto
  }
  if (it && !interimNow) interimSince = Date.now();
  if (it) orphan = null;
  interimNow = it;
  if (it === lastSent) return;
  lastSent = it;
  send({ cmd: 'asrPush', interim: it, spk: it ? speakerFor(false) : -1, t: Date.now() });
}
function flushPending() {
  if (interimNow) { stats.promoted++; emitFinal(interimNow, 0, true); interimNow = ''; }
  if (orphan) { stats.rescued++; emitFinal(orphan.text, 0, true); orphan = null; }
  if (lastSent) { lastSent = ''; send({ cmd: 'asrPush', interim: '', t: Date.now() }); }
}

function switchEngine(reason) {
  switched = true; useLocal = !useLocal; failStreak = 0; deafStreak = 0; deafMul = 1;
  stats.engine = useLocal ? 'local' : 'cloud'; stats.switched = true; stats.error = null;
  send({ cmd: 'asrPush', engine: stats.engine, reason: String(reason || '') });
}

function make() {
  const r = new SR();
  r.lang = 'ja-JP';
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = safe >= 2 ? 1 : 3;
  if ('processLocally' in r) r.processLocally = useLocal;
  stats.biased = 0;
  if (useLocal && phrasesOk && safe < 1 && 'phrases' in r) {
    const list = known();
    if (list.length) {
      try { r.phrases = list.map((w) => new self.SpeechRecognitionPhrase(w, 2.0)); stats.biased = list.length; }
      catch (_) { phrasesOk = false; }
    }
  }
  finalUpTo = 0;
  r.onaudiostart = preroll;
  r.onsoundstart = () => { stats.sound++; };
  r.onspeechstart = () => { stats.speech++; };
  r.onresult = (e) => {
    const now = Date.now();
    stats.results++; failStreak = 0; deafStreak = 0; deafMul = 1; lastResultAt = now; loudMs = 0; voicedMs = 0;
    // Finales nuevos (cada uno con sus alternativas) y TODO lo que sigue sin confirmar
    const finals = [];
    let interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) {
        if (i < finalUpTo) continue;
        finalUpTo = i + 1;
        const alts = [];
        for (let k = 0; k < res.length; k++) alts.push({ t: res[k].transcript, c: res[k].confidence });
        const a0 = alts[0];
        if (!a0 || (a0.c > 0 && a0.c < minConf && a0.t.trim().length <= 2)) continue;
        finals.push(alts);
      } else if (i >= finalUpTo) interim += res[0].transcript;
    }
    // Retraso medido: desde que empezó a sonar la voz hasta el primer texto
    if (onsetAt && (finals.length || JP.test(interim))) {
      const d = now - onsetAt; onsetAt = 0;
      if (d > 0 && d < 4000) {
        lats.push(d); if (lats.length > 15) lats.shift();
        stats.lat = lats.slice().sort((p, q) => p - q)[lats.length >> 1];
      }
    }
    push(async () => {
      if (!interimNow) uttStart = now;
      for (const alts of finals) {
        const a = alts.length > 1 ? await pickAlt(alts) : alts[0];
        orphan = null;
        emitFinal(a.t, a.c || 1, false);
        interimNow = ''; uttStart = Date.now();
      }
      setInterim(interim, finals.length > 0);
    });
  };
  r.onerror = (e) => {
    if (e.error === 'no-speech') return;
    if (e.error === 'phrases-not-supported') { phrasesOk = false; return; } // se reinicia sin frases de contexto
    stats.error = e.error;
    if (e.error === 'aborted') {
      // Chrome ha cortado la sesión. Antes de rendirse: (1) quitar los extras de la 1.6 (frases de contexto y
      // alternativas), por si el motor de este Chrome no los admite; (2) en modo automático, pasar al otro motor.
      failStreak++; stats.aborted = (stats.aborted || 0) + 1;
      if (failStreak % 2 === 0 && safe < 2) { safe++; stats.safe = safe; }
      if (failStreak >= 4 && AUTO && !switched) { switchEngine('aborted'); return; }
      if (failStreak >= maxFails * 3) stopped = true;
      return;
    }
    const hard = ['not-allowed', 'service-not-allowed', 'language-not-supported', 'audio-capture'].includes(e.error);
    if (++failStreak >= maxFails || hard) {
      // Modo automático: antes de rendirse, probar con el otro motor (dispositivo ↔ Google)
      if (AUTO && !switched && e.error !== 'audio-capture') { switchEngine(e.error); return; }
      stopped = true;
    }
    send({ cmd: 'asrPush', error: e.error || 'error', fatal: stopped });
  };
  r.onend = () => {
    stats.ends++; forcing = false;
    gapFrom = gapOverride || Date.now(); gapOverride = 0;
    // Garantía 1: lo que estaba "en curso" y no llegó a confirmarse NO se pierde
    push(flushPending);
    if (stopped) { push(() => send({ cmd: 'asrPush', error: stats.error || 'aborted', fatal: true })); return; }
    if (++restarts > 5000) return;
    // al instante: cada milisegundo sin reconocedor es audio perdido (tras errores, con una espera creciente)
    if (failStreak) setTimeout(start, Math.min(1500, 300 * failStreak)); else start();
  };
  return r;
}
function start() {
  if (stopped) return;
  try { rec = make(); stats.starts++; rec.start(track); }
  catch (err) {
    stats.error = String(err.message || err);
    // La web prohíbe la voz (Permissions Policy) → ventana propia de la extensión
    if (!IN_WINDOW && (err.name === 'NotAllowedError' || /permission policy/i.test(stats.error))) {
      stopped = true;
      stats.error = 'policy';
      chrome.runtime.sendMessage({ to: 'bg', cmd: 'asrPolicyBlocked' }).catch(() => {});
      port.disconnect();
      return;
    }
    if (AUTO && !switched) { switchEngine(stats.error); setTimeout(start, 50); return; }
    stopped = true;
    send({ cmd: 'asrPush', error: stats.error, fatal: true });
  }
}

// ── Vigilante anti-atascos ──
setInterval(() => {
  if (stopped || !rec) return;
  const now = Date.now();
  // Provisional que se quedó huérfano (sin texto y sin final): se confirma
  if (orphan && now - orphan.at > 600) push(() => { if (orphan) { stats.rescued++; emitFinal(orphan.text, 0, true); orphan = null; lastSent = ''; send({ cmd: 'asrPush', interim: '', t: Date.now() }); } });
  if (forcing) return;
  const longInterim = interimNow && (interimNow.length > 48 || (now - lastFinalAt > 7000 && interimNow.length > 20));
  // "Sordo": lleva un rato entrando VOZ (no solo música) y no sale ningún resultado. El plazo crece si los
  // reinicios no lo arreglan (p. ej. una canción), para no reiniciar sin parar.
  // Red de seguridad: si el detector de tono no capta la voz (susurros, voz bajo música fuerte), basta con que
  // haya sonido durante el doble de tiempo.
  const since = now - lastResultAt;
  const deaf = (since > 2200 * deafMul && loudMs > 1500 && (!diar || voicedMs > 600)) || (since > 4400 * deafMul && loudMs > 3000);
  if (longInterim || deaf) {
    forcing = true;
    if (longInterim) stats.forced++;
    else {
      stats.deaf++; deafStreak++; deafMul = Math.min(4, deafMul * 1.6);
      gapOverride = lastResultAt; // al reiniciar se le vuelve a dar todo lo que no transcribió
      // Modo automático: el motor no ha dado NI UN resultado tras varios intentos → probar el otro
      if (AUTO && !switched && !stats.results && deafStreak >= 3) switchEngine('sin resultados');
    }
    lastResultAt = now; loudMs = 0; voicedMs = 0;
    try { rec.stop(); } catch (_) { forcing = false; }
  }
}, 200);

if (!SR) send({ cmd: 'asrPush', error: 'no-api', fatal: true });
else start();

setInterval(() => send({ cmd: 'asrPush', recStatus: Object.assign({ visible: document.visibilityState, voices: diar ? diar.speakers.filter((s) => !s.dead).length : 0, vocab: known().length }, stats) }), 1000);
