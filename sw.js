/* Kantoro (web app) — service worker: hace la app instalable y guarda en el dispositivo lo ya descargado.
 * · Aplicación (HTML, CSS, JS): se sirve de la caché y se actualiza en segundo plano.
 * · Diccionarios (kuromoji-dict/ y data/, ~34 MB): se guardan la primera vez que se piden y no se vuelven a descargar.
 * Sube SHELL_V al publicar una versión nueva; DATA_V solo si cambian los diccionarios. */
'use strict';
const SHELL_V = 'kantoro-shell-v1';
const DATA_V = 'kantoro-data-v1';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'engine-worker.js', 'manifest.webmanifest',
  'engine/romaji.js', 'engine/dict.js', 'engine/analyzer.js', 'lib/kuromoji.js', 'icons/192.png', 'icons/512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_V && k !== DATA_V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== self.location.origin) return;
  if (/\/(kuromoji-dict|data)\//.test(u.pathname)) {
    e.respondWith(caches.open(DATA_V).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  e.respondWith(caches.open(SHELL_V).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || net;
  }));
});
