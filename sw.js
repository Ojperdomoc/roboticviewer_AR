/**
 * sw.js — offline del ROBOVISOR.
 *
 * Estrategia:
 *  - `network-first` para index.html (para que una actualización del sitio se vea al recargar);
 *  - `cache-first` para el resto de los archivos del mismo origen (vendorizado: three.js,
 *    wasm de MediaPipe, shaders, íconos): la segunda visita no baja nada del CDN ni de GitHub.
 *  - los .task de MediaPipe NO se cachean acá: pesan ~30 MB y ya viven en IndexedDB.
 */
const VERSION = 'robovisor-v1';
const PRECACHE = [
  './',
  './index.html',
  './css/app.css',
  './js/main.js',
  './manifest.webmanifest',
  './vendor/three/three.module.js',
  './vendor/three/three.core.js',
  './vendor/mediapipe/vision_bundle.mjs',
  './vendor/mediapipe/wasm/vision_wasm_internal.js',
  './vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  './vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js',
  './vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
      .catch((err) => console.warn('[sw] precache parcial:', err?.message))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                 // modelos: IndexedDB + red
  if (/\.task$|\.tflite$|\.wasm\.map$/.test(url.pathname)) return;  // ya cacheados por la app

  if (req.mode === 'navigate' || /index\.html$/.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => { const c = res.clone(); caches.open(VERSION).then((k) => k.put(req, c)); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const c = res.clone();
      caches.open(VERSION).then((k) => k.put(req, c));
      return res;
    }))
  );
});
