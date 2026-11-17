/* Kantoro — conversión kana → rōmaji (Hepburn modificado), determinista y sin pérdidas.
 * Funciona en navegador (globalThis.RJRomaji) y en Node (module.exports). */
(function (root) {
  'use strict';

  const BASE = {
    'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
    'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
    'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
    'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
    'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
    'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
    'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
    'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
    'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
    'わ': 'wa', 'ゐ': 'i', 'ゑ': 'e', 'を': 'o', 'ん': 'n',
    'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
    'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
    'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
    'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
    'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
    'ゔ': 'vu', 'ゕ': 'ka', 'ゖ': 'ke',
    'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o',
    'ゃ': 'ya', 'ゅ': 'yu', 'ょ': 'yo', 'ゎ': 'wa',
  };

  // Combinaciones de dos kana (yōon y combinaciones de préstamos en katakana)
  const PAIRS = {};
  const Y = { 'ゃ': 'a', 'ゅ': 'u', 'ょ': 'o' };
  const YSTEM = { 'き': 'ky', 'ぎ': 'gy', 'し': 'sh', 'じ': 'j', 'ち': 'ch', 'ぢ': 'j', 'に': 'ny',
    'ひ': 'hy', 'び': 'by', 'ぴ': 'py', 'み': 'my', 'り': 'ry' };
  for (const s in YSTEM) for (const y in Y) PAIRS[s + y] = YSTEM[s] + Y[y];
  Object.assign(PAIRS, {
    'ふぁ': 'fa', 'ふぃ': 'fi', 'ふぇ': 'fe', 'ふぉ': 'fo', 'ふゅ': 'fyu',
    'てぃ': 'ti', 'でぃ': 'di', 'とぅ': 'tu', 'どぅ': 'du', 'てゅ': 'tyu', 'でゅ': 'dyu',
    'うぃ': 'wi', 'うぇ': 'we', 'うぉ': 'wo', 'いぇ': 'ye',
    'ゔぁ': 'va', 'ゔぃ': 'vi', 'ゔぇ': 've', 'ゔぉ': 'vo', 'ゔゅ': 'vyu',
    'しぇ': 'she', 'じぇ': 'je', 'ちぇ': 'che',
    'つぁ': 'tsa', 'つぃ': 'tsi', 'つぇ': 'tse', 'つぉ': 'tso',
    'くぁ': 'kwa', 'くぃ': 'kwi', 'くぇ': 'kwe', 'くぉ': 'kwo', 'ぐぁ': 'gwa',
    'すぃ': 'si', 'ずぃ': 'zi', 'ほぅ': 'hu',
  });

  const PUNCT = {
    '、': ',', '。': '.', '！': '!', '？': '?', '「': '“', '」': '”', '『': '“', '』': '”',
    '（': '(', '）': ')', '【': '[', '】': ']', '〈': '<', '〉': '>', '《': '«', '》': '»',
    '・': '·', '～': '~', '〜': '~', '…': '…', '‥': '..', '　': ' ', '，': ',', '．': '.',
    '：': ':', '；': ';', '♪': '♪', '〃': '"', '｢': '“', '｣': '”', '､': ',', '｡': '.',
  };

  const MACRON = { a: 'ā', i: 'ī', u: 'ū', e: 'ē', o: 'ō' };

  function kataToHira(str) {
    let out = '';
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c >= 0x30a1 && c <= 0x30f6) out += String.fromCodePoint(c - 0x60);
      else if (ch === 'ヷ') out += 'わ゙';
      else if (ch === 'ヺ') out += 'を゙';
      else out += ch;
    }
    return out;
  }

  const isKanaChar = (ch) => /[ぁ-ゖァ-ヺーゝゞヽヾ]/.test(ch);
  const isKana = (s) => s.length > 0 && [...s].every(isKanaChar);
  const hasKanji = (s) => /[㐀-䶿一-鿿豈-﫿々〆〇ヶ]/.test(s);
  const hasJapanese = (s) => /[぀-ヿ㐀-䶿一-鿿豈-﫿々ｦ-ﾟ]/.test(s);

  /**
   * Convierte una cadena kana (hiragana o katakana) a rōmaji.
   * opts.longVowels: 'literal' (ou, uu, ā→aa) | 'macron' (ō, ū)
   * opts.protectFinalU: no fusionar la -u final (terminación de verbo: omou, no omō)
   * opts.n: 'n' (shinbun) | 'm' (shimbun, Hepburn tradicional)
   */
  function kanaToRomaji(kana, opts = {}) {
    const s = [...kataToHira(kana)];
    const chunks = []; // {r: rōmaji, kana: bool}
    for (let i = 0; i < s.length; i++) {
      const c = s[i], n = s[i + 1];
      if (n && PAIRS[c + n]) { chunks.push({ r: PAIRS[c + n], k: true }); i++; continue; }
      if (c === 'ゝ' || c === 'ゞ') { // iteración
        const prev = chunks.length ? chunks[chunks.length - 1].src : null;
        if (prev && BASE[prev]) {
          let r = BASE[prev];
          if (c === 'ゞ') r = r.replace(/^k/, 'g').replace(/^s/, 'z').replace(/^t/, 'd').replace(/^h/, 'b').replace(/^f/, 'b').replace(/^chi/, 'ji').replace(/^tsu/, 'zu');
          chunks.push({ r, k: true, src: prev }); continue;
        }
      }
      if (BASE[c] !== undefined) { chunks.push({ r: BASE[c], k: true, src: c, sp: c === 'っ' ? 0 : undefined }); continue; }
      if (c === 'っ') { chunks.push({ r: '', k: true, sokuon: true }); continue; }
      if (c === 'ー') { chunks.push({ r: '', k: true, long: true }); continue; }
      chunks.push({ r: PUNCT[c] !== undefined ? PUNCT[c] : c, k: false });
    }

    let out = '';
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i], nx = chunks[i + 1];
      if (ch.sokuon) {
        if (nx && nx.k && /^[bcdfghjkmprstvwz]/.test(nx.r)) out += nx.r.startsWith('ch') ? 't' : nx.r[0];
        else out += '’'; // っ final o ante vocal: oclusión glotal (ej. あっ → a’)
        continue;
      }
      if (ch.long) {
        const v = out.slice(-1);
        if (opts.longVowels === 'macron' && MACRON[v]) out = out.slice(0, -1) + MACRON[v];
        else if (/[aiueo]/.test(v)) out += v;
        else if (/[āīūēō]/.test(v)) { /* ya largo */ }
        else out += '-';
        continue;
      }
      if (ch.src === 'ん') {
        if (nx && nx.k && /^[aiueoy]/.test(nx.r)) { out += "n'"; continue; }
        if (opts.n === 'm' && nx && nx.k && /^[bmp]/.test(nx.r)) { out += 'm'; continue; }
        out += 'n'; continue;
      }
      if (opts.longVowels === 'macron' && ch.k && ch.r.length === 1 && /[aiueo]/.test(ch.r)) {
        const v = out.slice(-1);
        const isLast = i === chunks.length - 1;
        const prevChunk = chunks[i - 1];
        const prevIsN = prevChunk && prevChunk.src === 'ん';
        const merge = !prevIsN && prevChunk && prevChunk.k && !(opts.protectFinalU && isLast) &&
          ((v === 'o' && (ch.r === 'o' || ch.r === 'u')) || (v === 'u' && ch.r === 'u') ||
           (v === 'a' && ch.r === 'a') || (v === 'e' && ch.r === 'e'));
        if (merge) { out = out.slice(0, -1) + MACRON[v]; continue; }
      }
      out += ch.r;
    }
    return out;
  }

  function punct(str) {
    let o = '';
    for (const c of str) o += PUNCT[c] !== undefined ? PUNCT[c] : c;
    return o;
  }

  const api = { kanaToRomaji, kataToHira, isKana, isKanaChar, hasKanji, hasJapanese, punct };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RJRomaji = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
