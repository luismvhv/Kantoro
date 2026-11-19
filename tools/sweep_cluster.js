const fs = require('fs'); const { Diarizer } = require('../ext/engine/diarize.js');
const dir = process.argv[2] || '/tmp/w/dia';
const sig = new Float32Array(fs.readFileSync(dir + '/dialog.f32').buffer.slice(0));
const segs = JSON.parse(fs.readFileSync(dir + '/segs.json'));
const d = new Diarizer({ keepMs: 1e9 });
for (let p = 0, t = 0; p < sig.length; p += 683, t += 683 / 16) d.push(sig.subarray(p, p + 683), t);
const offs = [[0, 0], [-0.8, 0.3], [-1.2, 0.6]];
const feats = offs.map(([a, b]) => segs.map((s) => d.features((s.start + a) * 1000, (s.end + b) * 1000)));
// Precisión estricta: cada personaje tiene UN color (su grupo mayoritario) y cada color UN personaje
function strict(got) {
  const bySpk = {}; got.forEach((g, i) => { const k = segs[i].spk; (bySpk[k] = bySpk[k] || {})[g] = (bySpk[k][g] || 0) + 1; });
  const main = {}; for (const k in bySpk) main[k] = +Object.entries(bySpk[k]).sort((a, b) => b[1] - a[1])[0][0];
  const used = Object.values(main); const unique = new Set(used).size === used.length;
  return { ok: got.filter((g, i) => g === main[segs[i].spk]).length, unique };
}
const out = [];
for (const fW of [0.2, 0.25, 0.35, 0.5]) for (const mW of [6, 8, 10, 12]) for (const thr of [1, 1.2, 1.4, 1.6, 1.8, 2, 2.3]) {
  let ok = 0, uni = 0;
  for (const F of feats) { const c = new Diarizer({ fW, mW, thr }); const r = strict(F.map((f) => c.assign(f))); ok += r.ok; uni += r.unique; }
  out.push({ fW, mW, thr, ok, uni });
}
out.sort((a, b) => b.uni - a.uni || b.ok - a.ok);
console.log('máximo:', 3 * segs.length, 'frases (3 desfases)');
out.slice(0, 8).forEach((r) => console.log(JSON.stringify(r)));
