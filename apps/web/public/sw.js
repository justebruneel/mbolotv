// Service Worker Mbolo TV
//
// Stratégies :
//   - Navigations (HTML)   → réseau d'abord, repli cache hors ligne.
//     Chaque déploiement est donc visible immédiatement.
//   - /_next/static/*      → cache-first (fichiers hashés = immuables).
//   - Autres GET même origine → stale-while-revalidate.
// Le nom de cache est versionné : incrémenter VERSION purge tout l'ancien.

const VERSION = 'v2';
const SHELL_CACHE = `mbolo-tv-shell-${VERSION}`;
const RUNTIME_CACHE = `mbolo-tv-runtime-${VERSION}`;
const PRECACHE = ['/', '/icon.svg', '/apple-icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== SHELL_CACHE && name !== RUNTIME_CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 1. Navigations : réseau d'abord.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached ?? caches.match('/')),
        ),
    );
    return;
  }

  // 2. Assets statiques hashés : immuables, cache-first.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
            return response;
          }),
      ),
    );
    return;
  }

  // 3. Autres GET (icônes, manifest…) : stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached ?? network;
    }),
  );
});
