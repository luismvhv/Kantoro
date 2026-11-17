/* Kantoro (web app) — motor en un Web Worker: kuromoji + JMdict/KANJIDIC2 → rōmaji y ficha de diccionario.
 * Es el mismo motor que el de la extensión (engine/*.js, copiados por tools/build_web.ps1). */
'use strict';
self.window = self; // kuromoji.js espera `window`
importScripts('lib/kuromoji.js', 'engine/romaji.js', 'engine/dict.js', 'engine/analyzer.js');

const url = (rel) => new URL(rel, self.location).href;
async function loadJSON(rel, gz) {
  const res = await fetch(url(rel));
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + rel);
  if (!gz) return res.json();
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).json();
}

const WARMUP = ['こんにちは、元気ですか？', '私は学生です。', 'ありがとうございました！', 'ちょっと待ってください', '今日はいい天気ですね', 'すみません、分かりません'];
const t0 = performance.now();
let analyzer = null;
const ready = (async () => {
  const tokenizer = await new Promise((resolve, reject) =>
    kuromoji.builder({ dicPath: url('kuromoji-dict/') }).build((err, tk) => (err ? reject(err) : resolve(tk))));
  const dict = new RJDict.Dict(loadJSON);
  await dict.init();
  analyzer = new RJAnalyzer.Analyzer(tokenizer, dict);
  for (const s of WARMUP) await analyzer.analyze(s, {});
  return Math.round(performance.now() - t0);
})();
ready.then((ms) => postMessage({ ev: 'ready', ms }), (e) => postMessage({ ev: 'error', error: String(e && e.message || e) }));

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    await ready;
    let res;
    if (m.cmd === 'analyze') {
      const t = performance.now();
      res = Object.assign({ ms: +(performance.now() - t).toFixed(1) }, await analyzer.analyze(m.text, m.opts || {}));
    } else if (m.cmd === 'explain') res = await analyzer.explain(m.word, m.opts || {});
    else res = { error: 'unknown' };
    postMessage({ id: m.id, res });
  } catch (e) {
    postMessage({ id: m.id, err: String(e && e.message || e) });
  }
};
