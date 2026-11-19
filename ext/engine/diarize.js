/* Kantoro — distinción aproximada de voces (quién habla) en tiempo real, sin red ni modelos.
 * 1.7.1: el color solo cambia cuando la voz cambia de verdad (umbral para mantener y otro, mayor, para cambiar), el
 * tono pesa más (en semitonos), las frases con poca voz no cambian de personaje, lo provisional no parpadea y la
 * ventana de cada frase se corta en la pausa anterior. Banco: test/h_diar.html con test/dialog4.wav (4 voces y
 * música; tools/make_dialog.ps1): 8/15 → 12/15 frases bien asignadas, 14/14 cambios de personaje detectados y
 * ninguno de más, provisionales con otro color 31 → 19 de 87. Los parámetros salen de ?sweep en ese banco.
 * Por cada trama de 32 ms con voz se mide el tono fundamental (F0, autocorrelación normalizada) y el "brillo"
 * del timbre (energía de la derivada / energía). Cada frase se resume en [mediana de log2 F0, brillo medio] y se
 * asigna al personaje más cercano, o a uno nuevo si ninguno se parece (agrupamiento en línea, máx. 4 voces).
 * Es una aproximación: separa bien voces de distinto tipo (grave / aguda / muy aguda) y confunde voces parecidas. */
(function (root) {
  'use strict';

  class Diarizer {
    // Agrupamiento (1.7.1): distancia = √((Δtono en semitonos / stW)² + (Δtimbre MFCC / mW)²) entre la frase y la
    // media de cada personaje. keep: por debajo, sigue el mismo personaje; split: por encima, es otra voz (un
    // personaje conocido si alguno queda por debajo de split, o uno nuevo). Entre ambos, se mantiene el actual: el
    // color solo cambia cuando la voz cambia de verdad. minN: tramas con tono necesarias para decidir.
    constructor({ rate = 16000, maxSpeakers = 4, gap = 0, decay = 0.7, H = 8, comp = 10, keepMs = 20000, stW = 1.5, mW = 12, keep = 1.25, split = 1.6, minN = 20, pause = 300, guessNew = true } = {}) {
      this.keepMs = keepMs; this.cl = { stW, mW, keep, split, minN, pause, guessNew };
      this.cur = -1;           // personaje de la última frase confirmada
      this.shs = { gap, decay, H, comp };
      this.rate = rate;
      this.max = maxSpeakers;
      this.frameLen = 512; this.hop = 256;
      this.buf = new Float32Array(0);
      this.bufT = 0;           // tiempo (ms) de la primera muestra de buf
      this.frames = [];        // { t, rms, f0, bright }
      this.speakers = [];      // { lf0, br, n }
      this.noise = 0.004;      // nivel de ruido estimado (se adapta)
    }

    // f32: muestras a 16 kHz; t: tiempo (ms) de la primera muestra
    push(f32, t) {
      if (!this.buf.length) this.bufT = t;
      const b = new Float32Array(this.buf.length + f32.length);
      b.set(this.buf); b.set(f32, this.buf.length);
      let pos = 0;
      while (pos + this.frameLen <= b.length) {
        this.frames.push(this._frame(b.subarray(pos, pos + this.frameLen), this.bufT + (pos / this.rate) * 1000));
        pos += this.hop;
      }
      this.buf = b.slice(pos);
      this.bufT += (pos / this.rate) * 1000;
      // conservar ~20 s
      const cut = t - this.keepMs;
      while (this.frames.length && this.frames[0].t < cut) this.frames.shift();
    }

    // FFT real radix-2 (in situ) — tamaño fijo 2048 a 16 kHz (resolución 7,8 Hz)
    _fft(re, im) {
      const n = re.length;
      for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
      }
      for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
          let cr = 1, ci = 0;
          for (let k = 0; k < len / 2; k++) {
            const a = i + k, b = a + len / 2;
            const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
            const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
          }
        }
      }
    }

    _frame(x, t) {
      const n = x.length, N = 2048;
      let e = 0, mean = 0;
      for (let i = 0; i < n; i++) mean += x[i];
      mean /= n;
      for (let i = 0; i < n; i++) { const v = x[i] - mean; e += v * v; }
      const rms = Math.sqrt(e / n);
      if (!this.win) {
        this.win = new Float32Array(n); for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
        this.re = new Float32Array(N); this.im = new Float32Array(N); this.bg = new Float32Array(N / 2);
      }
      const re = this.re, im = this.im;
      re.fill(0); im.fill(0);
      for (let i = 0; i < n; i++) re[i] = (x[i] - mean) * this.win[i];
      this._fft(re, im);
      const half = N / 2, mag = new Float32Array(half);
      for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]);
      // Espectro de fondo (música, ruido): seguimiento de mínimos — baja rápido, sube muy despacio
      const bg = this.bg;
      for (let k = 0; k < half; k++) bg[k] = mag[k] < bg[k] || !bg[k] ? bg[k] * 0.7 + mag[k] * 0.3 : bg[k] * 0.995 + mag[k] * 0.005;
      // Suelo de ruido = percentil 20 del nivel de los últimos ~3 s (válido desde el primer segundo; la música de
      // fondo queda por debajo y no se confunde con voz)
      (this.rmsHist = this.rmsHist || []).push(rms);
      if (this.rmsHist.length > 190) this.rmsHist.shift();
      const sorted = this.rmsHist.slice().sort((p, q) => p - q);
      // (un percentil de 0 exacto es válido: silencio digital, p. ej. tras una pausa; antes se confundía con "sin dato"
      // y el suelo pasaba a ser el propio nivel de la voz, que dejaba de detectarse)
      const p20 = sorted[Math.floor(sorted.length * 0.2)];
      this.noise = p20 === undefined ? rms : p20;
      let f0 = 0, bright = 0, mf = null;
      if (rms > Math.max(0.01, this.noise * 1.6)) {
        // restar el fondo y buscar el tono con el producto de armónicos (más robusto que la autocorrelación
        // cuando hay música con sus propias notas)
        const S = new Float32Array(half);
        let tot = 0, cen = 0;
        for (let k = 0; k < half; k++) {
          S[k] = Math.max(0, mag[k] - 1.5 * bg[k]);
          const f = (k * this.rate) / N;
          if (f > 250 && f < 4000) { tot += S[k]; cen += S[k] * f; }
        }
        bright = tot ? cen / tot / 1000 : 0;
        // timbre del espectro SIN el fondo (antes se medía con la música incluida y el timbre de una misma voz
        // variaba mucho de una frase a otra)
        mf = this._mfcc(this.mfFromBg ? S : mag);
        // Suma de subarmónicos (SHS): el tono candidato f puntúa con la energía (comprimida) de f, 2f … 6f.
        // Funciona aunque el fundamental esté casi ausente (voces graves, música encima) y penaliza f/2,
        // porque sus armónicos impares caen donde no hay energía.
        const L = new Float32Array(half);
        for (let k = 0; k < half; k++) L[k] = Math.log1p(S[k] * this.shs.comp);
        const at = (fk) => { const i = Math.floor(fk), fr = fk - i; return i + 1 < half ? L[i] * (1 - fr) + L[i + 1] * fr : 0; };
        const fmin = 70, fmax = 700, step = 1.0; // Hz
        let best = 0, bf = 0;
        for (let f = fmin; f <= fmax; f += step) {
          let sc = 0, w = 1;
          for (let h = 1; h <= this.shs.H; h++) { sc += w * at((h * f * N) / this.rate); w *= this.shs.decay; }
          // penalizar huecos: energía en los semiarmónicos indica que el tono real es f/2
          let gap = 0;
          for (let h = 1; h <= 3; h++) gap += at(((h - 0.5) * f * N) / this.rate);
          sc -= this.shs.gap * gap;
          if (sc > best) { best = sc; bf = f; }
        }
        if (best > 1.2) f0 = bf;
      }
      return { t, rms, f0, bright, mf };
    }

    // MFCC (timbre): banco de 24 filtros mel 100–7000 Hz → log → DCT; coeficientes 1..12
    _mfcc(mag) {
      const N = 2048, half = N / 2, B = 24;
      if (!this.mel) {
        const mel = (f) => 2595 * Math.log10(1 + f / 700), inv = (m) => 700 * (10 ** (m / 2595) - 1);
        const lo = mel(100), hi = mel(7000);
        const pts = Array.from({ length: B + 2 }, (_, i) => Math.round((inv(lo + ((hi - lo) * i) / (B + 1)) * N) / this.rate));
        this.mel = [];
        for (let b = 0; b < B; b++) {
          const w = new Float32Array(half);
          for (let k = pts[b]; k < pts[b + 2]; k++) w[k] = k < pts[b + 1] ? (k - pts[b]) / Math.max(1, pts[b + 1] - pts[b]) : (pts[b + 2] - k) / Math.max(1, pts[b + 2] - pts[b + 1]);
          this.mel.push({ w, a: pts[b], z: pts[b + 2] });
        }
      }
      const le = new Float32Array(B);
      for (let b = 0; b < B; b++) { const { w, a, z } = this.mel[b]; let e = 0; for (let k = a; k < z; k++) e += w[k] * mag[k] * mag[k]; le[b] = Math.log(e + 1e-9); }
      const out = new Float32Array(12);
      for (let c = 1; c <= 12; c++) { let v = 0; for (let b = 0; b < B; b++) v += le[b] * Math.cos((Math.PI * c * (b + 0.5)) / B); out[c - 1] = v; }
      return out;
    }

    // Resumen de la voz entre t0 y t1 (ms)
    // anchor (opcional): cuándo se sabe que ya sonaba esta frase. La ventana empieza 1 s antes por el retraso del
    // reconocedor, pero así podía incluir el final de la frase ANTERIOR (otro personaje): se corta en la última
    // pausa (≥ 0,3 s sin voz con tono) anterior a anchor.
    features(t0, t1, anchor) {
      if (anchor) {
        let lastV = -Infinity;
        for (const f of this.frames) {
          if (f.t < t0) continue;
          if (f.t > anchor) break;
          if (f.f0 > 0) { if (f.t - lastV >= this.cl.pause && lastV > -Infinity) t0 = f.t; lastV = f.t; }
        }
      }
      const fr = this.frames.filter((f) => f.t >= t0 && f.t <= t1 && f.f0 > 0);
      const fm = this.frames.filter((f) => f.t >= t0 && f.t <= t1 && f.mf);
      if (fr.length < 6 || fm.length < 6) return null;
      const mf = new Float32Array(12);
      for (const f of fm) for (let i = 0; i < 12; i++) mf[i] += f.mf[i] / fm.length;
      const lf = fr.map((f) => Math.log2(f.f0)).sort((a, b) => a - b);
      const br = fr.map((f) => f.bright).sort((a, b) => a - b);
      const q = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
      return { lf0: q(lf, 0.5), br: q(br, 0.5), mf, n: fr.length };
    }

    dist(s, feat) {
      let m = 0; for (let k = 0; k < 12; k++) m += (s.mf[k] - feat.mf[k]) ** 2;
      const st = 12 * (s.lf0 - feat.lf0); // semitonos
      return Math.hypot(st / this.cl.stW, Math.sqrt(m) / this.cl.mW);
    }
    // Decide sin tocar nada: { id, nuevo } — id -1 si no hay datos para decidir
    decide(feat) {
      const { keep, split, minN } = this.cl;
      const live = this.speakers.map((s, i) => (s.dead ? null : { i, d: this.dist(s, feat) })).filter(Boolean);
      if (!live.length) return { id: -1, fresh: true };
      const cur = this.resolve(this.cur);
      const dc = cur >= 0 ? this.dist(this.speakers[cur], feat) : Infinity;
      if (dc <= keep) return { id: cur };                                  // la misma voz
      const best = live.reduce((a, b) => (b.d < a.d ? b : a));
      if (dc < split) return { id: cur };                                  // duda: no se cambia de color
      if (best.i !== cur && best.d <= keep + (split - keep) / 2) return { id: best.i }; // vuelve un personaje conocido
      if (live.length < this.max && best.d >= split) return { id: -1, fresh: true }; // voz nueva
      return { id: best.i };
    }
    // Personaje para lo provisional: el actual, salvo que la voz ya sea claramente la de otro personaje conocido.
    // No se adelanta un personaje nuevo (eso lo decide el final), así el color no parpadea mientras se habla.
    peek(feat) {
      if (!feat || feat.n < this.cl.minN) return this.cur >= 0 ? this.resolve(this.cur) : -1;
      const r = this.decide(feat);
      if (!r.fresh) return r.id;
      // voz nueva con datos de sobra: se adelanta el número que tendrá el nuevo personaje (su color)
      if (this.cl.guessNew && feat.n >= this.cl.minN * 1.5 && this.speakers.every((s) => s.dead || this.dist(s, feat) >= this.cl.split * 1.25)) return this.speakers.length;
      return this.cur >= 0 ? this.resolve(this.cur) : -1;
    }
    resolve(i) { let k = i; while (k >= 0 && this.speakers[k] && this.speakers[k].dead) k = this.speakers[k].alias; return k; }

    // Devuelve el índice de personaje (0..max-1) o -1 si no hay voz suficiente
    assign(feat) {
      // frase con muy poca voz medible: se queda con el personaje actual (no se cambia de color sin pruebas)
      if (!feat || feat.n < this.cl.minN) return this.cur >= 0 ? this.resolve(this.cur) : -1;
      const r = this.decide(feat);
      let id = r.id;
      if (r.fresh) {
        this.speakers.push({ lf0: feat.lf0, br: feat.br, mf: Float32Array.from(feat.mf), n: 1 });
        id = this.speakers.length - 1;
      } else {
        const s = this.speakers[id];
        const w = 1 / Math.min(10, ++s.n); // media adaptativa
        s.lf0 += (feat.lf0 - s.lf0) * w; s.br += (feat.br - s.br) * w;
        for (let i = 0; i < 12; i++) s.mf[i] += (feat.mf[i] - s.mf[i]) * w;
        // Dos personajes que acaban siendo casi idénticos (la 1.ª frase se midió mal) se fusionan
        for (let j = 0; j < this.speakers.length; j++) {
          const o = this.speakers[j];
          if (j === id || o.dead) continue;
          if (this.dist(o, s) < this.cl.keep * 0.5) {
            const [k, drop] = o.n >= s.n ? [j, id] : [id, j];
            this.speakers[drop].dead = true; this.speakers[drop].alias = k;
            this.speakers[k].n += this.speakers[drop].n;
            id = k; break;
          }
        }
      }
      this.cur = id;
      return id;
    }
  }

  const api = { Diarizer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RJDiarize = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
