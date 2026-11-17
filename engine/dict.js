/* Kantoro — acceso a JMdict / KANJIDIC2 fragmentados (carga bajo demanda + caché LRU). */
(function (root) {
  'use strict';

  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  class LRU {
    constructor(max) { this.max = max; this.m = new Map(); }
    get(k) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
    set(k, v) { this.m.set(k, v); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value); }
  }

  class Dict {
    /** @param loadJSON (relPath, gz:boolean) => Promise<any> */
    constructor(loadJSON) {
      this.load = loadJSON;
      this.forms = new LRU(160);
      this.entries = new LRU(80);
      this.pending = new Map();
    }
    async init() {
      [this.meta, this.kanji] = await Promise.all([
        this.load('data/jmdict/meta.json', false),
        this.load('data/kanji.json.gz', true),
      ]);
    }
    _shard(cache, key, path) {
      const hit = cache.get(key);
      if (hit) return hit;
      if (this.pending.has(path)) return this.pending.get(path);
      const p = this.load(path, true).then((d) => { cache.set(key, d); this.pending.delete(path); return d; });
      this.pending.set(path, p);
      return p;
    }
    /** Devuelve Map(forma → [{id, ...entrada}]) */
    async lookupMany(forms) {
      const uniq = [...new Set(forms.filter(Boolean))];
      const fShards = await Promise.all(uniq.map((f) => {
        const n = fnv(f) % this.meta.formShards;
        return this._shard(this.forms, n, `data/jmdict/f${n}.json.gz`);
      }));
      const idsByForm = new Map();
      const needed = new Set();
      uniq.forEach((f, i) => {
        const ids = fShards[i][f] || [];
        idsByForm.set(f, ids);
        ids.forEach((id) => needed.add(Math.floor(id / this.meta.entryShard)));
      });
      const eShards = new Map();
      await Promise.all([...needed].map(async (n) => {
        eShards.set(n, await this._shard(this.entries, n, `data/jmdict/e${n}.json.gz`));
      }));
      const res = new Map();
      for (const [f, ids] of idsByForm) {
        res.set(f, ids.map((id) => {
          const e = eShards.get(Math.floor(id / this.meta.entryShard))[id % this.meta.entryShard];
          return Object.assign({ id }, e);
        }));
      }
      return res;
    }
    /** Lecturas (hiragana) válidas de una entrada para una forma escrita concreta */
    static readingsFor(entry, form, kataToHira, commonOnly) {
      const isKanjiForm = entry.k.some((k) => k[0] === form);
      return entry.r
        .filter((r) => !isKanjiForm || !r[2] || r[2].includes(form))
        .filter((r) => !commonOnly || r[1])
        .map((r) => kataToHira(r[0]));
    }
  }

  const api = { Dict, fnv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RJDict = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
