#!/usr/bin/env python3
"""Compila JMdict (eng + spa) y KANJIDIC2 en índices compactos .json.gz para la extensión.

Uso: python3 build_dicts.py <dir_con_json_de_jmdict-simplified> <dir_salida>
Fuentes: https://github.com/scriptin/jmdict-simplified (licencia CC BY-SA 4.0, EDRDG)
"""
import gzip, json, sys, os
from collections import defaultdict

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

def load(name):
    for f in os.listdir(src):
        if f.startswith(name) and f.endswith('.json'):
            return json.load(open(os.path.join(src, f), encoding='utf-8'))
    raise SystemExit(f'No encuentro {name}*.json en {src}')

eng = load('jmdict-eng-3')
spa = load('jmdict-spa')
kd = load('kanjidic2-all')

# Glosas en español por id de entrada (lista por sentido)
spa_by_id = {}
for w in spa['words']:
    spa_by_id[w['id']] = [[g['text'] for g in s['gloss']] for s in w['sense']]

def star(lst):
    return None if (not lst or lst == ['*']) else lst

entries = []
for w in eng['words']:
    common = any(x['common'] for x in w['kanji']) or any(x['common'] for x in w['kana'])
    e = {
        'k': [[x['text'], 1 if x['common'] else 0] for x in w['kanji']],
        'r': [[x['text'], 1 if x['common'] else 0] + ([star(x['appliesToKanji'])] if star(x['appliesToKanji']) else [])
              for x in w['kana']],
        's': [],
    }
    for s in w['sense']:
        se = {'p': s['partOfSpeech'], 'g': [g['text'] for g in s['gloss']]}
        if s['misc']: se['m'] = s['misc']
        if s['field']: se['f'] = s['field']
        if s['info']: se['i'] = s['info']
        if s['dialect']: se['d'] = s['dialect']
        if star(s['appliesToKanji']): se['ak'] = s['appliesToKanji']
        if star(s['appliesToKana']): se['ar'] = s['appliesToKana']
        e['s'].append(se)
    if w['id'] in spa_by_id:
        e['es'] = spa_by_id[w['id']]
    if common: e['c'] = 1
    entries.append(e)

# Entradas comunes primero (mejor desempate en la búsqueda)
entries.sort(key=lambda e: 0 if e.get('c') else 1)

index = defaultdict(list)
for i, e in enumerate(entries):
    for f in [x[0] for x in e['k']] + [x[0] for x in e['r']]:
        if i not in index[f]:
            index[f].append(i)

def fnv(s):
    """FNV-1a 32 bits sobre unidades UTF-16 (idéntico a la versión JS)."""
    h = 0x811c9dc5
    b = s.encode('utf-16-le')
    for cu in (int.from_bytes(b[i:i + 2], 'little') for i in range(0, len(b), 2)):
        h ^= cu
        h = (h * 0x01000193) & 0xffffffff
    return h

FORM_SHARDS = 256
ENTRY_SHARD = 1000
jd = os.path.join(out, 'jmdict')
os.makedirs(jd, exist_ok=True)

def dump_gz(path, obj):
    with gzip.open(path, 'wt', encoding='utf-8', compresslevel=9) as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(',', ':'))

form_shards = [dict() for _ in range(FORM_SHARDS)]
for f, ids in index.items():
    form_shards[fnv(f) % FORM_SHARDS][f] = ids
for n, sh in enumerate(form_shards):
    dump_gz(os.path.join(jd, f'f{n}.json.gz'), sh)
for n in range(0, len(entries), ENTRY_SHARD):
    dump_gz(os.path.join(jd, f'e{n // ENTRY_SHARD}.json.gz'), entries[n:n + ENTRY_SHARD])
with open(os.path.join(jd, 'meta.json'), 'w', encoding='utf-8') as fh:
    json.dump({'formShards': FORM_SHARDS, 'entryShard': ENTRY_SHARD, 'count': len(entries), 'tags': eng['tags']},
              fh, ensure_ascii=False)

# ---------- KANJIDIC2 ----------
# Palabras comunes que contienen cada kanji (para la sección "usos")
words_by_kanji = defaultdict(list)
for e in entries:
    if not e.get('c') or not e['k']:
        continue
    form = e['k'][0][0]
    if len(form) > 4 or not e['k'][0][1]:
        continue
    reading = e['r'][0][0]
    gl = (e.get('es') or [[]])[0][:2]
    if not gl or any(x.count('(') != x.count(')') for x in gl):
        gl = e['s'][0]['g'][:2]
    for ch in set(form):
        if ('\u4e00' <= ch <= '\u9fff' or ch == '々') and form != ch:
            words_by_kanji[ch].append((len(form), 0 if form.startswith(ch) else 1, form, reading, '; '.join(gl)))
for ch in words_by_kanji:
    words_by_kanji[ch] = [list(x[2:]) for x in sorted(words_by_kanji[ch])[:8]]

kanji = {}
for c in kd['characters']:
    rm = c.get('readingMeaning') or {}
    on, kun, en, es = [], [], [], []
    for g in rm.get('groups', []):
        for r in g['readings']:
            if r['type'] == 'ja_on': on.append(r['value'])
            elif r['type'] == 'ja_kun': kun.append(r['value'])
        for m in g['meanings']:
            if m['lang'] == 'en': en.append(m['value'])
            elif m['lang'] == 'es': es.append(m['value'])
    misc = c['misc']
    kanji[c['literal']] = {
        's': (misc.get('strokeCounts') or [None])[0], 'g': misc.get('grade'),
        'j': misc.get('jlptLevel'), 'f': misc.get('frequency'),
        'on': on, 'kun': kun, 'n': rm.get('nanori', []), 'en': en, 'es': es,
        'w': words_by_kanji.get(c['literal'], []),
    }

with gzip.open(os.path.join(out, 'kanji.json.gz'), 'wt', encoding='utf-8', compresslevel=9) as fh:
    json.dump(kanji, fh, ensure_ascii=False, separators=(',', ':'))

print('entradas', len(entries), 'formas', len(index), 'kanji', len(kanji))
