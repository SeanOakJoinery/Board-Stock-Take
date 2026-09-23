const CACHE_NAME = 'board-stock-shell-v1';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

// FIXED (real issue hit during development): the previous version used a
// cache-FIRST strategy for everything, which meant once index.html was
// cached, every future visit kept serving that same old copy forever —
// deploying a genuinely new index.html to GitHub Pages had no visible
// effect at all until CACHE_NAME itself was bumped, which is easy to
// forget and did in fact get forgotten. Now: the app shell (index.html /
// manifest.json / navigation requests) is network-FIRST — always try the
// real network copy first so a new deploy shows up on the very next load,
// only falling back to the cached copy if there's no network (offline).
// Icons rarely change, so they stay cache-first to save a request.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin sync calls (jsonbin, Drive) pass straight through

  const isShellDoc = event.request.mode === 'navigate' ||
    url.pathname.endsWith('/index.html') ||
    url.pathname.endsWith('/manifest.json') ||
    url.pathname === '/' || url.pathname.endsWith('/');

  if (isShellDoc){
    event.respondWith(
      fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      }).catch(() => cached);
    })
  );
});
