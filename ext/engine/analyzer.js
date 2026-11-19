/* Kantoro — análisis morfológico (kuromoji/IPADIC) + verificación con JMdict + rōmaji. */
(function (root) {
  'use strict';
  const R = root.RJRomaji || (typeof require !== 'undefined' && require('./romaji.js'));
  const D = root.RJDict || (typeof require !== 'undefined' && require('./dict.js'));
  const { kanaToRomaji, kataToHira, isKana, hasKanji, hasJapanese, punct } = R;

  const OPEN = new Set(['「', '『', '（', '(', '【', '〈', '《', '“', '‘', '[', '｢']);
  const CLOSE = new Set(['」', '』', '）', ')', '】', '〉', '》', '、', '。', '！', '？', '!', '?', ',', '.', '…', '‥', '”', '’', ']', '~', '～', '〜', '：', ':', '；', ';', '｣', '､', '｡']);
  const CONT_POS = new Set(['動詞', '形容詞', '助動詞']);

  const POS_ES = {
    '名詞': 'sustantivo', '動詞': 'verbo', '形容詞': 'adjetivo (-i)', '副詞': 'adverbio', '助詞': 'partícula',
    '助動詞': 'verbo auxiliar', '連体詞': 'adnominal', '接続詞': 'conjunción', '感動詞': 'interjección',
    '接頭詞': 'prefijo', '記号': 'signo', 'フィラー': 'muletilla', 'その他': 'otro',
  };
  const DETAIL_ES = {
    '固有名詞': 'nombre propio', '人名': 'nombre de persona', '地域': 'topónimo', '組織': 'organización',
    '代名詞': 'pronombre', '数': 'número', '接尾': 'sufijo', '非自立': 'dependiente', 'サ変接続': 'sustantivo + suru',
    '形容動詞語幹': 'raíz de adjetivo -na', '副詞可能': 'uso adverbial posible', '格助詞': 'partícula de caso',
    '係助詞': 'partícula de tema/énfasis', '副助詞': 'partícula adverbial', '終助詞': 'partícula final',
    '接続助詞': 'partícula conjuntiva', '並立助詞': 'partícula coordinante', '連体化': 'partícula adnominal (の)',
    '自立': 'independiente', '助数詞': 'contador', '一般': '',
  };
  const CFORM_ES = {
    '基本形': 'forma diccionario', '連用形': 'forma continuativa (ren\'yōkei)', '連用タ接続': 'forma continuativa ante た/て',
    '未然形': 'forma irrealis (mizenkei, base de negación)', '未然ウ接続': 'forma irrealis ante う (volitivo)',
    '未然レル接続': 'forma irrealis ante れる', '仮定形': 'forma condicional (kateikei)', '仮定縮約１': 'condicional contraída',
    '命令ｅ': 'imperativo', '命令ｒｏ': 'imperativo', '命令ｙｏ': 'imperativo', '命令ｉ': 'imperativo',
    '体言接続': 'forma adnominal', '連用テ接続': 'forma continuativa ante て', '連用ゴザイ接続': 'forma ante ございます',
    'ガル接続': 'forma ante がる', '音便基本形': 'forma diccionario eufónica', '文語基本形': 'forma diccionario clásica',
  };
  const AUX_ES = {
    'た': 'pasado / acción completada', 'だ': 'cópula “ser” (llana) o pasado tras sonido sonoro',
    'です': 'cópula “ser” (cortés)', 'ます': 'terminación cortés (teineigo)', 'ない': 'negación',
    'ぬ': 'negación (clásica / formal)', 'ん': 'negación (contracción de ぬ)', 'たい': 'deseo (“querer …”)',
    'れる': 'pasiva / potencial / honorífico', 'られる': 'pasiva / potencial / honorífico',
    'せる': 'causativo (“hacer que …”)', 'させる': 'causativo (“hacer que …”)', 'う': 'volitivo (“vamos a…”, “haré…”)',
    'よう': 'volitivo / conjetura', 'らしい': 'conjetura (“parece que…”)', 'そうだ': 'apariencia / rumor',
    'まい': 'volitivo negativo / conjetura negativa', 'じゃ': 'contracción de では', 'や': 'cópula dialectal (Kansai)',
  };
  const PRT_ES = {
    'は': 'marca el tema de la oración (se pronuncia “wa”)', 'が': 'marca el sujeto gramatical; también “pero”',
    'を': 'marca el objeto directo (se pronuncia “o”)', 'に': 'destino, momento, objeto indirecto, agente',
    'へ': 'dirección (se pronuncia “e”)', 'で': 'lugar de la acción, medio, causa', 'と': '“y” (listas exhaustivas), “con”, cita',
    'の': 'posesivo / nominalizador', 'も': '“también”, “incluso”', 'から': '“desde”, “porque”', 'まで': '“hasta”',
    'より': '“que” (comparación), “desde”', 'や': '“y” (listas no exhaustivas)', 'か': 'pregunta; “o”',
    'ね': 'busca acuerdo (“¿verdad?”)', 'よ': 'afirmación / información nueva', 'な': 'prohibición o exclamación',
    'て': 'conecta acciones / forma -te', 'ば': 'condicional (“si…”)', 'けど': '“pero”, “aunque”', 'し': '“y además”',
    'ぞ': 'énfasis (masculino)', 'ぜ': 'énfasis (masculino, coloquial)', 'わ': 'énfasis (femenino / Kansai)',
    'さ': 'énfasis coloquial', 'って': 'cita coloquial / tema', 'のに': '“a pesar de”', 'ながら': '“mientras”',
    'たり': 'enumeración de acciones', 'だけ': '“solo”', 'しか': '“solo” (con negación)', 'ほど': '“tanto como”',
    'くらい': '“aproximadamente”', 'ぐらい': '“aproximadamente”', 'でも': '“incluso”, “pero”', 'なら': '“si es el caso de”',
  };

  class Analyzer {
    constructor(tokenizer, dict) { this.tk = tokenizer; this.dict = dict; this.cache = new Map(); }

    async analyze(text, opts = {}) {
      const key = JSON.stringify([text, opts.particles, opts.longVowels, opts.n]);
      if (this.cache.has(key)) return this.cache.get(key);
      const lines = text.normalize('NFKC').split(/\n+/).map((l) => l.trim()).filter(Boolean);
      const tokLines = lines.map((l) => this.tk.tokenize(l));

      // Formas a consultar en JMdict (superficies, formas base y compuestos candidatos)
      const cand = [];
      for (const toks of tokLines) {
        toks.forEach((t, i) => {
          cand.push(t.surface_form);
          if (t.basic_form && t.basic_form !== '*') cand.push(t.basic_form);
          let s = t.surface_form;
          for (let j = i + 1; j < Math.min(i + 4, toks.length); j++) {
            if (!isNounish(toks[j]) || !isNounish(t)) break;
            s += toks[j].surface_form;
            cand.push(s);
          }
        });
      }
      const dm = await this.dict.lookupMany(cand);
      const res = { lines: tokLines.map((toks) => this._line(toks, dm, opts)) };
      res.romaji = res.lines.map((l) => l.text).join('\n');
      if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, res);
      return res;
    }

    _readings(dm, form, commonOnly) {
      const set = new Set();
      for (const e of dm.get(form) || []) for (const r of D.Dict.readingsFor(e, form, kataToHira, commonOnly)) set.add(r);
      return set;
    }

    _tokKana(t, dm, opts) {
      const surf = t.surface_form;
      if (t.reading && t.reading !== '*') {
        let r = t.reading;
        const p = t.pronunciation;
        if (opts.particles !== 'literal' && p && p.length === r.length) {
          r = [...r].map((c, i) => ('ハヘヲ'.includes(c) && 'ワエオ'.includes(p[i]) ? p[i] : c)).join('');
        }
        return { kana: kataToHira(r), src: 'ipadic' };
      }
      if (isKana(surf)) return { kana: kataToHira(surf), src: 'kana' };
      if (!hasJapanese(surf)) return { kana: null, raw: surf };
      const rs = [...this._readings(dm, surf)];
      if (rs.length) return { kana: rs[0], src: 'jmdict', amb: rs.length > 1, alt: rs.slice(1) };
      const g = this._guess(surf);
      if (g) return { kana: g, src: 'guess', unknown: true, guess: true };
      return { kana: null, raw: surf, unknown: true };
    }

    // Palabra que no está en ningún diccionario (casi siempre un nombre propio): lectura ESTIMADA carácter a
    // carácter con KANJIDIC2 — kun'yomi si es un kanji suelto, on'yomi dentro de compuestos. Se marca como estimación.
    _guess(surf) {
      const K = this.dict.kanji || {};
      const chars = [...surf];
      let out = '';
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (isKana(c)) { out += kataToHira(c); continue; }
        if (c === '々' && i > 0) { out += this._guessOne(K[chars[i - 1]], chars.length === 1) || ''; continue; }
        const r = this._guessOne(K[c], chars.length === 1);
        if (!r) return null;
        out += r;
      }
      return out || null;
    }
    _guessOne(k, alone) {
      if (!k) return null;
      const kun = (k.kun || []).map((x) => x.split('.')[0].replace(/-/g, '')).filter(Boolean);
      const on = (k.on || []).map((x) => kataToHira(x.replace(/-/g, ''))).filter(Boolean);
      return (alone ? kun[0] || on[0] : on[0] || kun[0]) || null;
    }

    _line(toks, dm, opts) {
      // 1) Fusionar compuestos nominales que existen en JMdict (日本+語 → 日本語) verificando la lectura
      const units = [];
      for (let i = 0; i < toks.length; i++) {
        let merged = null;
        if (isNounish(toks[i])) {
          for (let j = Math.min(i + 3, toks.length - 1); j > i; j--) {
            const run = toks.slice(i, j + 1);
            if (!run.every(isNounish)) continue;
            const surf = run.map((t) => t.surface_form).join('');
            const rs = this._readings(dm, surf);
            if (!rs.size) continue;
            const ks = run.map((t) => this._tokKana(t, dm, opts));
            const concat = ks.every((k) => k.kana) ? ks.map((k) => k.kana).join('') : null;
            const common = this._readings(dm, surf, true);
            let kana = null;
            if (concat && common.has(concat)) kana = concat;          // la lectura de kuromoji es la habitual
            else if (common.size) kana = [...common][0];              // p. ej. 二人 → ふたり (no ににん)
            else if (concat && rs.has(concat)) kana = concat;
            else if (rs.size === 1) kana = [...rs][0];                // lectura única (p. ej. rendaku)
            if (kana) { merged = { toks: run, kana, surf, compound: true }; i = j; break; }
          }
        }
        if (merged) units.push(merged);
        else {
          const t = toks[i];
          const k = this._tokKana(t, dm, opts);
          units.push({ toks: [t], kana: k.kana, raw: k.raw, surf: t.surface_form, src: k.src, amb: k.amb, alt: k.alt, unknown: k.unknown, guess: k.guess });
        }
      }

      // 2) Agrupar en palabras (verbo + auxiliares, sustantivo + sufijo, puntuación)
      const words = [];
      for (const u of units) {
        const t = u.toks[0];
        const prev = words[words.length - 1];
        const last = prev && prev.units[prev.units.length - 1].toks.slice(-1)[0];
        const s = t.surface_form;
        let mode = null; // 'glue' | 'hyphen' | 'punct'
        if (prev && !prev.punct) {
          if (last && /[っッ]$/.test(last.surface_form) && u.kana) mode = 'glue'; // 言っ+てる → itteru
          else if (t.pos === '助動詞' && last && CONT_POS.has(last.pos)) mode = 'glue';
          else if (t.pos === '助詞' && t.pos_detail_1 === '接続助詞' && ['て', 'で', 'ば'].includes(s) && last && CONT_POS.has(last.pos)) mode = 'glue';
          else if ((t.pos === '動詞' || t.pos === '形容詞') && t.pos_detail_1 === '接尾') mode = 'glue';
          else if (t.pos === '名詞' && t.pos_detail_1 === '接尾') mode = t.pos_detail_2 === '人名' ? 'hyphen' : 'glue';
        }
        if (mode) { prev.units.push(Object.assign(u, { hyphen: mode === 'hyphen' })); continue; }
        const isPunct = t.pos === '記号' || (!u.kana && u.raw !== undefined && !hasJapanese(u.raw) && /^[\p{P}\p{S}\s]+$/u.test(u.raw));
        words.push({ units: [u], punct: isPunct });
      }

      // 3) Rōmaji por palabra + metadatos para el tooltip
      const out = [];
      for (const w of words) {
        const surf = w.units.map((u) => u.surf).join('');
        const head = w.units[0].toks[0];
        let r;
        if (w.punct) r = punct(surf);
        else {
          const segs = [];
          for (const u of w.units) {
            const piece = u.kana != null ? u.kana : `[${u.raw}]`;
            if (u.hyphen || !segs.length) segs.push(piece); else segs[segs.length - 1] += piece;
          }
          const lastTok = w.units[w.units.length - 1].toks.slice(-1)[0];
          r = segs.map((sg, i) => sg.replace(/\[([^\]]*)\]/g, '\u0000$1\u0001')
            .split(/(\u0000[^\u0001]*\u0001)/).map((p) => p.startsWith('\u0000') ? p.slice(1, -1) :
              kanaToRomaji(p, {
                longVowels: opts.longVowels, n: opts.n,
                protectFinalU: head.pos === '動詞' && lastTok === head && i === segs.length - 1,
              })).join('')).join('-');
          r = r.replace(/^[’']+/, '');
        }
        const kana = w.units.map((u) => (u.kana != null ? u.kana : u.raw)).join('');

        // Verificación de la lectura contra JMdict (solo formas no conjugadas con kanji)
        let amb = !!w.units.some((u) => u.amb || u.unknown);
        let alt = [];
        const u0 = w.units[0];
        if (!w.punct && hasKanji(u0.surf) && (u0.compound || ['*', '基本形'].includes(head.conjugated_form))) {
          const all = this._readings(dm, u0.surf, false);
          const common = this._readings(dm, u0.surf, true);
          const mine = u0.kana;
          if (all.size && mine) {
            alt = [...common].filter((x) => x !== mine && !x.includes('ー'));
            if (!all.has(mine) && !alt.length) alt = [...all].filter((x) => !x.includes('ー'));
            if (!all.has(mine) || alt.length) amb = true;
          }
        }
        if (u0.alt) alt = alt.concat(u0.alt);
        out.push({
          s: surf, k: kana, r, punct: w.punct, amb, guess: w.units.some((u) => u.guess), alt: [...new Set(alt)].slice(0, 6),
          ra: alt.length ? [...new Set(alt)].slice(0, 6).map((a) => kanaToRomaji(a, opts)) : [],
          open: w.punct && OPEN.has(surf.slice(-1)), close: w.punct && CLOSE.has(surf[0]),
          toks: w.units.flatMap((u) => u.toks.map((t) => ({
            s: t.surface_form, b: t.basic_form, pos: t.pos, d1: t.pos_detail_1, d2: t.pos_detail_2,
            cf: t.conjugated_form, ct: t.conjugated_type, k: t.reading && t.reading !== '*' ? kataToHira(t.reading) : null,
          }))),
          comp: u0.compound ? u0.surf : null,
        });
      }
      // Texto de línea con espaciado tipográfico correcto
      let text = '';
      out.forEach((w, i) => {
        const p = out[i - 1];
        w.sp = !(i === 0 || w.close || (p && p.open));
        text += (w.sp ? ' ' : '') + w.r;
      });
      return { words: out, text };
    }

    /** Explicación detallada para el tooltip */
    async explain(w, opts = {}) {
      const head = w.toks[0];
      const forms = [w.comp, w.s, head.b !== '*' ? head.b : null, head.s].filter(Boolean);
      const dm = await this.dict.lookupMany(forms);
      const seen = new Set();
      const ents = [];
      for (const f of forms) for (const e of dm.get(f) || []) if (!seen.has(e.id)) { seen.add(e.id); ents.push({ e, f }); }
      const hk = head.k;
      ents.sort((a, b) => score(b) - score(a));
      function score({ e, f }) {
        let s = e.c ? 2 : 0;
        const rs = D.Dict.readingsFor(e, f, kataToHira);
        if (hk && rs.some((r) => r === hk || (head.b !== head.s && r.startsWith(hk.slice(0, Math.max(1, hk.length - 1)))))) s += 4;
        if (f === w.comp || f === w.s) s += 1;
        if (e.k.some((k) => k[0] === f) || isKana(f)) s += 1;
        return s;
      }
      const tags = this.dict.meta.tags || {};
      const entries = ents.slice(0, 3).map(({ e, f }) => ({
        forms: e.k.map((k) => k[0]),
        readings: D.Dict.readingsFor(e, f, kataToHira).map((r) => ({ kana: r, romaji: kanaToRomaji(r, opts) })),
        common: !!e.c,
        senses: e.s.slice(0, 6).map((s) => ({
          pos: (s.p || []).map((p) => JM_POS_ES[p] || tags[p] || p),
          misc: (s.m || []).map((p) => JM_MISC_ES[p] || tags[p] || p),
          field: (s.f || []).map((p) => tags[p] || p),
          info: s.i || [], g: s.g,
        })),
        es: [...new Set((e.es || []).flat())].slice(0, 14),
      }));

      const kanjiChars = [...new Set([...(w.s + (head.b || ''))].filter((c) => hasKanji(c)))];
      const kanji = kanjiChars.map((c) => {
        const k = this.dict.kanji[c];
        if (!k) return { c };
        return {
          c, strokes: k.s, grade: k.g, jlpt: k.j, freq: k.f,
          on: k.on.map((x) => ({ kana: x, romaji: kanaToRomaji(x).toUpperCase() })),
          kun: k.kun.map((x) => ({ kana: x, romaji: kanaToRomaji(x.replace('.', '').replace(/-/g, '')) , okurigana: x.includes('.') ? x.split('.')[1] : '' })),
          en: k.en, es: k.es, words: k.w.slice(0, 6).map(([f, r, g]) => ({ f, r, romaji: kanaToRomaji(r, opts), g })),
        };
      });

      const grammar = w.toks.map((t) => {
        const parts = [POS_ES[t.pos] || t.pos];
        const d = DETAIL_ES[t.d1];
        if (d) parts.push(d);
        if (t.pos === '助詞' && PRT_ES[t.s]) parts.push(PRT_ES[t.s]);
        if (t.pos === '助動詞') parts.push(AUX_ES[t.b] || AUX_ES[t.s] || '');
        if (t.cf && t.cf !== '*') parts.push(CFORM_ES[t.cf] || t.cf);
        if (t.b && t.b !== '*' && t.b !== t.s) parts.push(`forma base: ${t.b}`);
        return { s: t.s, romaji: t.k ? kanaToRomaji(t.k, opts) : '', desc: parts.filter(Boolean).join(' · ') };
      });
      return { entries, kanji, grammar };
    }
  }

  function isNounish(t) { return t.pos === '名詞' || t.pos === '接頭詞'; }

  const JM_POS_ES = {
    'n': 'sustantivo', 'n-adv': 'sustantivo adverbial', 'n-t': 'sustantivo temporal', 'n-suf': 'sustantivo sufijo',
    'n-pref': 'sustantivo prefijo', 'n-pr': 'nombre propio', 'pn': 'pronombre', 'adj-i': 'adjetivo -i',
    'adj-ix': 'adjetivo -i (いい/よい)', 'adj-na': 'adjetivo -na', 'adj-no': 'sustantivo que admite の', 'adj-pn': 'adnominal',
    'adj-t': 'adjetivo -taru', 'adj-f': 'sustantivo/verbo que modifica a otro', 'adv': 'adverbio', 'adv-to': 'adverbio con と',
    'aux': 'auxiliar', 'aux-v': 'verbo auxiliar', 'aux-adj': 'adjetivo auxiliar', 'conj': 'conjunción', 'cop': 'cópula',
    'ctr': 'contador', 'exp': 'expresión', 'int': 'interjección', 'num': 'numeral', 'pref': 'prefijo', 'prt': 'partícula',
    'suf': 'sufijo', 'unc': 'sin clasificar', 'v1': 'verbo ichidan', 'v1-s': 'verbo ichidan (くれる)',
    'v5u': 'verbo godan en -u', 'v5k': 'verbo godan en -ku', 'v5k-s': 'verbo godan (行く)', 'v5g': 'verbo godan en -gu',
    'v5s': 'verbo godan en -su', 'v5t': 'verbo godan en -tsu', 'v5n': 'verbo godan en -nu', 'v5b': 'verbo godan en -bu',
    'v5m': 'verbo godan en -mu', 'v5r': 'verbo godan en -ru', 'v5r-i': 'verbo godan en -ru (irregular)',
    'v5aru': 'verbo godan -aru (honorífico)', 'v5u-s': 'verbo godan en -u (especial)', 'vk': 'verbo irregular くる',
    'vs': 'sustantivo + する', 'vs-i': 'verbo する', 'vs-s': 'verbo -する (especial)', 'vz': 'verbo -ずる',
    'vi': 'intransitivo', 'vt': 'transitivo',
  };
  const JM_MISC_ES = {
    'uk': 'se escribe normalmente en kana', 'uK': 'se escribe normalmente con kanji', 'col': 'coloquial',
    'pol': 'cortés (teineigo)', 'hon': 'honorífico (sonkeigo)', 'hum': 'humilde (kenjōgo)', 'sl': 'argot', 'vulg': 'vulgar',
    'arch': 'arcaico', 'obs': 'obsoleto', 'dated': 'anticuado', 'abbr': 'abreviatura', 'fem': 'lenguaje femenino',
    'male': 'lenguaje masculino', 'joc': 'jocoso', 'derog': 'despectivo', 'on-mim': 'onomatopeya / mimesis',
    'yoji': 'yojijukugo (4 kanji)', 'id': 'modismo', 'proverb': 'proverbio', 'form': 'formal', 'poet': 'poético',
    'sens': 'delicado', 'chn': 'lenguaje infantil', 'fam': 'familiar', 'rare': 'raro', 'litf': 'literario', 'net-sl': 'argot de internet',
  };

  const api = { Analyzer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RJAnalyzer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
