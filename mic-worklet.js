/* Kantoro — captura del micrófono en el hilo de audio (AudioWorklet).
 * Entrega al hilo principal bloques de 16 kHz (por defecto 200 ms) con su nivel. Si el contexto ya va a 16 kHz
 * (lo normal: lo remuestrea el navegador en código nativo) solo acumula; si no, reduce la frecuencia promediando. */
class KantoroMic extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = (opts && opts.processorOptions) || {};
    this.size = o.size || 3200;
    this.step = sampleRate / 16000;
    this.buf = new Float32Array(this.size); this.n = 0;
    this.acc = 0; this.accN = 0; this.pos = 0;
  }
  push(v) {
    this.buf[this.n++] = v;
    if (this.n === this.size) {
      let e = 0; for (let i = 0; i < this.size; i++) e += this.buf[i] * this.buf[i];
      this.port.postMessage({ pcm: this.buf, rms: Math.sqrt(e / this.size) }, [this.buf.buffer]);
      this.buf = new Float32Array(this.size); this.n = 0;
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.step === 1) { for (let i = 0; i < ch.length; i++) this.push(ch[i]); return true; }
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.accN++; this.pos++;
      if (this.pos >= this.step) { this.pos -= this.step; this.push(this.acc / this.accN); this.acc = 0; this.accN = 0; }
    }
    return true;
  }
}
registerProcessor('kantoro-mic', KantoroMic);
