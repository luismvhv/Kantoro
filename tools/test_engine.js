const path = require('path'), fs = require('fs'), zlib = require('zlib');
const kuromoji = require('kuromoji');
require('../ext/engine/romaji.js'); require('../ext/engine/dict.js');
const { Analyzer } = require('../ext/engine/analyzer.js');
const { Dict } = globalThis.RJDict;
const EXT = path.join(__dirname, '../ext');
const load = async (p, gz) => { const b = fs.readFileSync(path.join(EXT, p)); return JSON.parse(gz ? zlib.gunzipSync(b) : b); };
kuromoji.builder({ dicPath: path.join(EXT, 'kuromoji-dict') }).build(async (err, tk) => {
  if (err) throw err;
  const d = new Dict(load); await d.init();
  const a = new Analyzer(tk, d);
  const cases = process.argv.slice(2).length ? process.argv.slice(2) : [
    '私は東京へ行きました。', 'こんにちは！今日はいい天気ですね。', 'ちょっと待って、何を言ってるの？',
    '日本語を勉強しています', '田中さんはコーヒーが好きだ', 'ラーメンを食べに行こう！', 'あっ、しまった…',
    '先生、本当にありがとうございました', '学校に行かなければならない', '進撃の巨人', 'お前はもう死んでいる',
    'ヴァイオリンとフィギュアスケート', '新聞を読んだ', '一緒に頑張ろうね', '大丈夫だよ、心配しないで', 'きっと、また会える。',
  ];
  for (const opts of [{}, { longVowels: 'macron' }]) {
    console.log('== opts', JSON.stringify(opts));
    for (const c of cases) {
      const t = performance.now(); const r = await a.analyze(c, opts); const ms = (performance.now() - t).toFixed(1);
      console.log(`${c}\n  → ${r.romaji}   [${ms} ms]${r.lines[0].words.filter(w => w.amb).map(w => `  ⚠${w.s}:${w.alt.join('/')}`).join('')}`);
    }
  }
  const r = await a.analyze('食べました', {}); const t = performance.now();
  const ex = await a.explain(r.lines[0].words[0]);
  console.log('explain ms', (performance.now() - t).toFixed(1)); console.log(JSON.stringify(ex, null, 1).slice(0, 2500));
});
