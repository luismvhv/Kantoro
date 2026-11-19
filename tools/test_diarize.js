const fs = require('fs');
const { Diarizer } = require('../ext/engine/diarize.js');
const dir = process.argv[2] || '/tmp/w/dia';
const sig = new Float32Array(fs.readFileSync(dir + '/dialog.f32').buffer.slice(0));
const segs = JSON.parse(fs.readFileSync(dir + '/segs.json', 'utf8'));
for (const [label, pre, post] of [['ventana exacta', 0, 0], ['desfase realista (-0,8 s / +0,3 s)', -0.8, 0.3], ['desfase fuerte (-1,2 s / +0,6 s)', -1.2, 0.6]]) {
  const d = new Diarizer();
  const CH = 683; let t = 0; let si = 0; const got = [];
  const t0 = performance.now();
  for (let p = 0; p < sig.length; p += CH) {
    d.push(sig.subarray(p, p + CH), t); t += (CH / 16000) * 1000;
    // cuando "termina" una frase (+ desfase), se asigna su voz
    while (si < segs.length && t / 1000 >= segs[si].end + post + 0.05) {
      const s = segs[si];
      got.push(d.assign(d.features((s.start + pre) * 1000, (s.end + post) * 1000))); si++;
    }
  }
  while (si < segs.length) { const s = segs[si++]; got.push(d.assign(d.features((s.start + pre) * 1000, (s.end + post) * 1000))); }
  const ms = performance.now() - t0;
  // pureza: mejor correspondencia grupo → personaje
  const map = {};
  got.forEach((g, i) => { (map[g] = map[g] || {})[segs[i].spk] = ((map[g] || {})[segs[i].spk] || 0) + 1; });
  let ok = 0; for (const g in map) ok += Math.max(...Object.values(map[g]));
  // ¿un personaje partido en varios grupos?
  const per = {}; got.forEach((g, i) => { (per[segs[i].spk] = per[segs[i].spk] || new Set()).add(g); });
  console.log(`${label}: ${ok}/${segs.length} frases en el grupo correcto · grupos: ${Object.keys(map).length} · ` +
    Object.entries(per).map(([k, v]) => `${k}→${[...v].join('/')}`).join(' ') + ` · ${(ms / (sig.length / 16000)).toFixed(1)} ms por s de audio`);
  if (label === 'ventana exacta') console.log('   asignaciones:', segs.map((s, i) => s.spk + got[i]).join(' '));
}
