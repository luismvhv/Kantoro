/* Kantoro — captura de la pestaña (chrome.tabCapture) en el documento offscreen.
 *  · Vídeo → OCR de una zona, fotograma a fotograma (hasta 30 fps, sin el límite de 2 capturas/s de
 *    captureVisibleTab ni la codificación PNG). Solo se reconoce cuando el texto de la zona cambia y se estabiliza.
 *  · Audio → reconocimiento de voz japonés (Web Speech API con pista de audio), resultados parciales en vivo.
 * Los resultados se envían al service worker, que los reenvía al marco de la pestaña que los muestra. */
(function (root) {
  'use strict';
  const JP = /[぀-ヿ㐀-䶿一-鿿]/;
  const sessions = new Map(); // tabId → { stream, ctx, ocr, asr }
  const send = (msg) => chrome.runtime.sendMessage(Object.assign({ to: 'bg' }, msg)).catch(() => {});

  async function start({ tabId, streamId, video, audio, width, height }) {
    stop(tabId);
    const src = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audio ? src : false,
      video: video ? { mandatory: Object.assign(
        // Tamaño exacto de la pestaña: si no, Chrome reescala y añade bandas negras
        width && height ? { minWidth: width, maxWidth: width, minHeight: height, maxHeight: height, maxFrameRate: 30 } : { maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30 },
        src.mandatory) } : false,
    });
    const s = { stream, ctx: null, ocr: null, asr: null };
    if (audio) {
      // Capturar una pestaña la silencia: se devuelve el audio a los altavoces
      s.ctx = new AudioContext({ latencyHint: 'interactive' });
      s.ctx.resume().catch(() => {});
      s.ctx.createMediaStreamSource(stream).connect(s.ctx.destination);
    }
    stream.getTracks().forEach((t) => t.addEventListener('ended', () => { if (sessions.get(tabId) === s) { stop(tabId); send({ cmd: 'capEnded', tabId }); } }));
    sessions.set(tabId, s);
    return { ok: true, video: !!video, audio: !!audio };
  }

  function stop(tabId) {
    const s = sessions.get(tabId);
    if (!s) return;
    sessions.delete(tabId);
    if (s.ocr) s.ocr.stop();
    if (s.asr) s.asr.stop();
    s.stream.getTracks().forEach((t) => t.stop());
    if (s.ctx) s.ctx.close().catch(() => {});
  }

  // ───────────── OCR continuo sobre el vídeo de la pestaña ─────────────
  function ocr({ tabId, frameId, rect, viewW, viewH, kind }) {
    const s = sessions.get(tabId);
    const track = s && s.stream.getVideoTracks()[0];
    if (!track) return { error: 'no-capture' };
    if (s.ocr) s.ocr.stop();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    let stopped = false, busy = false, lastT = 0, stableFp = null, pendingFp = null, seq = 0;
    let canvas = null, g = null;
    const stats = { frames: 0, samples: 0, ocr: 0, pushes: 0, err: null, fw: 0, fh: 0, viewW, rect };
    s.ocr = { stats, stop() { stopped = true; reader.cancel().catch(() => {}); } };
    (async () => {
      while (!stopped) {
        const { value: frame, done } = await reader.read().catch(() => ({ done: true }));
        if (done || stopped) { if (frame) frame.close(); break; }
        stats.frames++; stats.fw = frame.displayWidth; stats.fh = frame.displayHeight;
        const now = performance.now();
        // ~20 muestras/s; mientras Tesseract trabaja se descartan fotogramas (se compara con el siguiente)
        if (busy || now - lastT < 45) { frame.close(); continue; }
        lastT = now; stats.samples++;
        // Correspondencia viewport → fotograma, contemplando bandas negras si las proporciones no coinciden
        const fw = frame.displayWidth, fh = frame.displayHeight;
        const f = viewH ? Math.min(fw / viewW, fh / viewH) : fw / viewW;
        const ox = viewH ? (fw - viewW * f) / 2 : 0, oy = viewH ? (fh - viewH * f) / 2 : 0;
        const cx = Math.max(0, Math.round(ox + rect.x * f)), cy = Math.max(0, Math.round(oy + rect.y * f));
        const cw = Math.min(frame.displayWidth - cx, Math.round(rect.w * f)), ch = Math.min(frame.displayHeight - cy, Math.round(rect.h * f));
        if (cw < 8 || ch < 8) { frame.close(); continue; }
        if (!canvas || canvas.width !== cw || canvas.height !== ch) { canvas = new OffscreenCanvas(cw, ch); g = canvas.getContext('2d', { willReadFrequently: true }); }
        g.drawImage(frame, cx, cy, cw, ch, 0, 0, cw, ch);
        frame.close();
        const id = g.getImageData(0, 0, cw, ch);
        const mask = kind === 'subs' ? RJOcr.subsMask(id) : null;
        const fp = mask ? RJOcr.fingerprint(mask, cw, ch) : grayPrint(id);
        if (stableFp && !RJOcr.differs(fp, stableFp)) { pendingFp = null; continue; } // nada nuevo
        // Esperar a que el cambio se estabilice (fundidos de entrada/salida) antes de reconocer
        if (!pendingFp || RJOcr.differs(fp, pendingFp)) { pendingFp = fp; continue; }
        stableFp = fp; pendingFp = null;
        const my = ++seq, t0 = now;
        let empty = true;
        if (mask) { for (let i = 0; i < mask.length; i += 7) if (mask[i]) { empty = false; break; } } else empty = false;
        if (empty) { send({ cmd: 'ocrPush', tabId, frameId, lines: [], ms: 0, seq: my }); continue; }
        busy = true; stats.ocr++;
        RJOcr.recognizeImage(id, kind).then((lines) => {
          stats.pushes++; stats.last = lines.map((l) => l.text).join('|');
          if (stopped) return;
          for (const l of lines) l.box = { x: (cx + l.box.x - ox) / f, y: (cy + l.box.y - oy) / f, w: l.box.w / f, h: l.box.h / f };
          send({ cmd: 'ocrPush', tabId, frameId, lines, ms: Math.round(performance.now() - t0), seq: my });
        }).catch((e) => { stats.err = String(e && e.message || e); }).finally(() => { busy = false; });
      }
    })().catch((e) => { stats.err = 'loop: ' + String(e && e.message || e); });
    return { ok: true };
  }
  function grayPrint(id) {
    const W = 64, H = 16, f = new Uint16Array(W * H);
    const { width: w, height: h, data: d } = id;
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
      const o = (y * w + x) * 4;
      f[((y * H / h) | 0) * W + ((x * W / w) | 0)] += (d[o] + d[o + 1] + d[o + 2]) >> 6;
    }
    return f;
  }

  // ───────────── Reconocimiento de voz del audio de la pestaña ─────────────
  const SR = root.SpeechRecognition || root.webkitSpeechRecognition;

  async function asrStatus(local) {
    if (!SR) return { av: 'no-api' };
    if (!SR.available) return { av: local ? 'no-local-api' : 'available' };
    try { return { av: await SR.available({ langs: ['ja-JP'], processLocally: !!local }) }; }
    catch (e) { return { av: 'error', error: String(e.message || e) }; }
  }

  // El reconocimiento de voz NO se hace aquí: Chrome lo aborta en documentos ocultos. Se envía el audio
  // (PCM 16 kHz) al marco invisible asr/asr.html que la página inserta, y aquí solo se mide el nivel.
  const ports = new Map(); // tabId → Set(port)
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'rj-asr') return;
    let tab = null;
    port.onMessage.addListener((m) => {
      if (m.hello) { tab = m.tabId; if (!ports.has(tab)) ports.set(tab, new Set()); ports.get(tab).add(port); }
    });
    port.onDisconnect.addListener(() => { if (tab !== null && ports.has(tab)) ports.get(tab).delete(port); });
  });

  function pump({ tabId, frameId }) {
    const s = sessions.get(tabId);
    if (!s || !s.ctx) return { error: 'no-capture' };
    if (s.asr) s.asr.stop();
    const stats = { maxLevel: 0, t0: Date.now(), sent: 0 };
    const src = s.ctx.createMediaStreamSource(s.stream);
    // Limpieza del audio SOLO para el reconocedor (lo que oyes no cambia):
    //  · paso alto 90 Hz: quita bajos de música, golpes y retumbe, que tapan la voz
    //  · paso bajo 7,2 kHz: quita siseos y platillos por encima de la banda de la voz
    // (Sin compresor: subiría la música hasta el nivel de la voz y reduciría el contraste voz/fondo.)
    const hp = s.ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90; hp.Q.value = 0.7;
    const lp = s.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7200; lp.Q.value = 0.7;
    const makeup = s.ctx.createGain(); makeup.gain.value = 1.0;
    src.connect(hp); hp.connect(lp); lp.connect(makeup);
    // Bloques de 1024 muestras (~21 ms a 48 kHz): la mitad de espera que con 2048 antes de enviar cada trozo
    const proc = s.ctx.createScriptProcessor(1024, 1, 1);
    const ratio = s.ctx.sampleRate / 16000;
    let acc = 0, n = 0, peak = 0, carry = 0, gain = 1, recentPeak = 0;
    proc.onaudioprocess = (ev) => {
      const d = ev.inputBuffer.getChannelData(0);
      // el nivel se mide SIN la ganancia automática, para que el monitor refleje lo que llega de la pestaña
      for (let i = 0; i < d.length; i++) { const v = d[i] / gain; acc += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
      n += d.length;
      // Reducir a 16 kHz (promedio por bloque) y codificar en Int16 → base64
      const set = ports.get(tabId);
      if (set && set.size) {
        const out = [];
        for (let pos = carry; pos < d.length; pos += ratio) {
          const a = Math.floor(pos), b = Math.min(d.length, Math.floor(pos + ratio));
          let sum = 0; for (let k = a; k < b; k++) sum += d[k];
          out.push(sum / Math.max(1, b - a));
          carry = pos + ratio - d.length;
        }
        let bin = '';
        for (const v of out) { const x = Math.max(-1, Math.min(1, v)) * 32767 | 0; bin += String.fromCharCode(x & 255, (x >> 8) & 255); }
        const pcm = btoa(bin);
        for (const port of set) { try { port.postMessage({ pcm }); stats.sent++; } catch (_) { set.delete(port); } }
      }
      if (n >= s.ctx.sampleRate) {
        const rms = Math.sqrt(acc / n);
        stats.maxLevel = Math.max(stats.maxLevel, rms);
        send({ cmd: 'asrPush', tabId, frameId, status: { level: rms, peak, maxLevel: stats.maxLevel, gain: +gain.toFixed(2), ctx: s.ctx.state, elapsed: (Date.now() - stats.t0) / 1000 } });
        // Ganancia automática LENTA (no es un compresor: sube todo por igual, voz y fondo, y cambia en segundos):
        // si la pestaña suena baja, se amplifica hasta ×8 para que el pico ronde 0,5 y el reconocedor oiga las voces flojas.
        recentPeak = Math.max(peak, recentPeak * 0.8);
        if (recentPeak > 0.003) {
          const want = Math.max(1, Math.min(8, 0.5 / recentPeak));
          gain = want < gain ? want : gain + (want - gain) * 0.3; // baja al instante (sin saturar), sube poco a poco
          makeup.gain.setTargetAtTime(gain, s.ctx.currentTime, 0.15);
        }
        acc = 0; n = 0; peak = 0;
      }
    };
    const mute = s.ctx.createGain(); mute.gain.value = 0;
    makeup.connect(proc); proc.connect(mute); mute.connect(s.ctx.destination);
    s.asr = { stats, stop() { proc.onaudioprocess = null; try { proc.disconnect(); src.disconnect(); } catch (_) { /* nada */ } } };
    return { ok: true };
  }

  const debug = (tabId) => { const x = sessions.get(tabId); return x ? { ocr: x.ocr && x.ocr.stats, asr: x.asr && x.asr.stats, tracks: x.stream.getTracks().map((t) => t.kind + ':' + t.readyState) } : null; };
  root.RJCapture = { start, stop, ocr, pump, asrStatus, debug, has: (tabId) => sessions.has(tabId) };
})(globalThis);
