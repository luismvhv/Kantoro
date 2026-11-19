const fs = require('fs'); const { Diarizer } = require('../ext/engine/diarize.js');
const sig = new Float32Array(fs.readFileSync('/tmp/w/dia/dialog.f32').buffer.slice(0));
const segs = JSON.parse(fs.readFileSync('/tmp/w/dia/segs.json'));
const truth = { A: 137, B: 229, C: 304 };
const res = [];
for (const gap of [0, 0.25, 0.5]) for (const decay of [0.7, 0.84, 0.95]) for (const H of [4, 6, 8]) for (const comp of [10, 50, 200]) {
  const d = new Diarizer({ gap, decay, H, comp, keepMs: 1e9 });
  for (let p = 0, t = 0; p < sig.length; p += 683, t += 683 / 16) d.push(sig.subarray(p, p + 683), t);
  // las tramas se recortan a 20 s: reconstruir pasando todo (offline) → usar frames acumulados sin recorte
  let ok = 0, tot = 0; const per = { A: [0, 0], B: [0, 0], C: [0, 0] };
  for (const f of d.frames) {
    if (!f.f0) continue;
    const s = segs.find((x) => f.t / 1000 >= x.start && f.t / 1000 <= x.end); if (!s) continue;
    const r = f.f0 / truth[s.spk]; const good = r > 0.8 && r < 1.25;
    tot++; ok += good; per[s.spk][0] += good; per[s.spk][1]++;
  }
  res.push({ gap, decay, H, comp, acc: ok / tot, per: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, (v[0] / v[1]).toFixed(2)])) });
}
res.sort((a, b) => b.acc - a.acc);
for (const r of res.slice(0, 6)) console.log(JSON.stringify(r));
console.log('peor:', JSON.stringify(res[res.length - 1]));
