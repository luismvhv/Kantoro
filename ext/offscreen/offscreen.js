/* Kantoro — motor en documento offscreen: kuromoji + JMdict + traducción local. */
'use strict';

const WARMUP = [
  '準備完了です。', '私は学生です。', 'これは何ですか？', 'ありがとうございました！', 'ちょっと待って！', '本当に大丈夫？',
  '俺はお前を信じてる。', '僕たちは友達だよね', 'どうしてそんなことを言うの？', 'もう一度やってみよう', 'すみません、分かりません',
  '早く行こう、時間がない！', '彼女は先生に会いに来た', '今日は楽しかったね', 'あなたのことが好きです', '何があっても守る',
  '行かなければならない', 'そうか、そういうことだったのか', 'ここで待っていてください', 'お腹が空いた', '家に帰りたい',
  '父さんと母さんはどこ？', '明日学校で会おう', '心配しないで', 'やめろ！', 'いいえ、違います', '一緒に食べませんか',
  '本当にごめんなさい', 'お願いします', '大変だ！', 'ずっと前から知っていた', '世界を救うために戦う', '見て、きれいな空',
];
const state = { ready: false, error: null, t0: performance.now(), loadMs: 0 };
let analyzer = null;

async function loadJSON(rel, gz) {
  const res = await fetch(chrome.runtime.getURL(rel));
  if (!gz) return res.json();
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).json();
}

const ready = (async () => {
  try {
    const tokenizer = await new Promise((resolve, reject) =>
      kuromoji.builder({ dicPath: chrome.runtime.getURL('kuromoji-dict/') })
        .build((err, tk) => (err ? reject(err) : resolve(tk))));
    const dict = new RJDict.Dict(loadJSON);
    await dict.init();
    analyzer = new RJAnalyzer.Analyzer(tokenizer, dict);
    // Calentar JIT y precargar los fragmentos de diccionario más usados en diálogos
    for (const s of WARMUP) await analyzer.analyze(s, {});
    state.ready = true;
    state.loadMs = Math.round(performance.now() - state.t0);
    setTimeout(() => RJOcr.warm().catch(() => {}), 3000); // precargar el OCR sin retrasar el rōmaji
  } catch (e) {
    state.error = String(e && e.stack || e);
    console.error('[Kantoro]', e);
  }
})();

// ---------- Traducción local (Chrome Translator API, modelo en el dispositivo) ----------
const translators = new Map();
const trCache = new Map();
async function getTranslator(target) {
  if (typeof Translator === 'undefined') throw new Error('no-api');
  if (!translators.has(target)) {
    const p = (async () => {
      const av = await Translator.availability({ sourceLanguage: 'ja', targetLanguage: target });
      if (av === 'unavailable') throw new Error('unsupported');
      if (av !== 'available') throw new Error('needs-download');
      return Translator.create({ sourceLanguage: 'ja', targetLanguage: target });
    })();
    translators.set(target, p);
    p.catch(() => translators.delete(target));
  }
  return translators.get(target);
}
// ---------- Traducción en línea (1.7.0) ----------
// Para idiomas o equipos donde el traductor integrado no está disponible («Combinación no disponible en este
// dispositivo») o no está descargado. Traductor de Google (translate.googleapis.com, sin clave; no es una API oficial)
// y MyMemory de reserva. Solo se envía el texto japonés de la frase. La extensión tiene permiso de host, así que
// estas peticiones no dependen del CORS de la web en la que esté el usuario.
const ONLINE_CODE = { zh: 'zh-CN', 'zh-Hant': 'zh-TW', iw: 'iw', fil: 'tl', no: 'no' };
let googleOffUntil = 0; // si Google limita (429) o falla, 5 min directos a la reserva
async function translateOnline(text, target) {
  const tl = ONLINE_CODE[target] || target;
  try {
    if (Date.now() < googleOffUntil) throw new Error('en pausa');
    const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=' + encodeURIComponent(tl) + '&dt=t&q=' + encodeURIComponent(text), { credentials: 'omit' });
    if (!r.ok) { googleOffUntil = Date.now() + 300000; throw new Error('HTTP ' + r.status); }
    const j = await r.json();
    const out = (j && j[0] || []).map((s) => (s && s[0]) || '').join('').trim();
    if (out) return out;
    throw new Error('vacío');
  } catch (e) {
    const r = await fetch('https://api.mymemory.translated.net/get?langpair=ja|' + encodeURIComponent(tl) + '&q=' + encodeURIComponent(text), { credentials: 'omit' });
    const j = await r.json().catch(() => null);
    const out = j && j.responseData && j.responseData.translatedText;
    if (r.ok && out && j.responseStatus === 200) return out;
    throw new Error('online-failed');
  }
}
// mode: 'auto' (integrado si está listo; si no, en línea) | 'local' | 'online'
async function translate(text, target, mode = 'auto') {
  const key = mode + '\u0000' + target + '\u0000' + text;
  if (trCache.has(key)) return trCache.get(key);
  let out;
  if (mode === 'online') out = await translateOnline(text, target);
  else {
    try { out = await (await getTranslator(target)).translate(text); }
    catch (e) { if (mode === 'local') throw e; out = await translateOnline(text, target); }
  }
  if (trCache.size > 3000) trCache.delete(trCache.keys().next().value);
  trCache.set(key, out);
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.to !== 'engine') return false;
  (async () => {
    switch (msg.cmd) {
      case 'status':
        return { ready: state.ready, error: state.error, loadMs: state.loadMs, translator: typeof Translator !== 'undefined' };
      case 'analyze': {
        await ready;
        const t = performance.now();
        const res = await analyzer.analyze(msg.text, msg.opts || {});
        return Object.assign({ ms: +(performance.now() - t).toFixed(2) }, res);
      }
      case 'score': { // nº de palabras que no existen en el diccionario, por texto (para elegir entre alternativas de la voz)
        await ready;
        const unk = [];
        for (const t of (msg.texts || []).slice(0, 5)) {
          const r = await analyzer.analyze(String(t).slice(0, 200), {});
          unk.push(r.lines.reduce((n, l) => n + l.words.filter((w) => w.guess).length, 0));
        }
        return { unk };
      }
      case 'explain':
        await ready;
        return analyzer.explain(msg.word, msg.opts || {});
      case 'translate':
        try { return { text: await translate(msg.text, msg.target, msg.mode || 'auto') }; }
        catch (e) { return { error: e.message }; }
      case 'ocr':
        try { return await RJOcr.ocr(msg); }
        catch (e) { console.error('[Kantoro OCR]', e); return { error: String(e && e.message || e) }; }
      case 'capStart':
        try { return await RJCapture.start(msg); } catch (e) { return { error: String(e && e.message || e) }; }
      case 'capStop':
        RJCapture.stop(msg.tabId); return { ok: true };
      case 'capDebug':
        return RJCapture.debug(msg.tabId);
      case 'capHas':
        return { has: RJCapture.has(msg.tabId) };
      case 'capOcr':
        return RJCapture.ocr(msg);
      case 'capPump':
        try { return RJCapture.pump(msg); } catch (e) { return { error: String(e && e.message || e) }; }
      case 'asrStatus':
        return RJCapture.asrStatus(msg.local);
      case 'trAvailability':
        if (typeof Translator === 'undefined') return { av: 'no-api' };
        return { av: await Translator.availability({ sourceLanguage: 'ja', targetLanguage: msg.target }) };
      default:
        return { error: 'unknown' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
