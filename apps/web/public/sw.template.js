// Service Worker Mbolo TV — GABARIT : public/sw.js est généré à chaque build
// depuis ce fichier avec une VERSION unique (next.config.ts), ce qui force le
// navigateur à réinstaller le SW et purger les caches runtime périmés.
//
// Stratégies :
//   - Navigations (HTML)   → réseau d'abord, repli cache hors ligne.
//     Chaque déploiement est donc visible immédiatement.
//   - /_next/static/*      → cache-first (fichiers hashés = immuables).
//   - Autres GET même origine → stale-while-revalidate.

const VERSION = 'dev';
const SHELL_CACHE = `mbolo-tv-shell-${VERSION}`;
const RUNTIME_CACHE = `mbolo-tv-runtime-${VERSION}`;
const PRECACHE = ['/', '/icon.svg', '/apple-icon.svg'];

// En dev, /_next/static/* n'est pas immuable : les chunks gardent la même URL
// avec un contenu recompilé, donc le cache-first servirait du JS périmé après
// chaque édition. Le SW se désactive lui-même et purge tous les caches.
const IS_DEV = ['localhost', '127.0.0.1'].includes(self.location.hostname);

self.addEventListener('install', (event) => {
  if (!IS_DEV) event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => IS_DEV || (name !== SHELL_CACHE && name !== RUNTIME_CACHE))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
      // En dev, désinscription après purge : le rechargement suivant ne passe
      // plus par le SW (PwaRegister ne le réenregistre pas hors production).
      if (IS_DEV) await self.registration.unregister();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  if (IS_DEV) return;
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 0. Requêtes internes Next.js (payloads RSC / préfetch route) :
  //    ne JAMAIS les intercepter — une réponse en cache périmée force le
  //    router à basculer sur un rechargement complet de la page.
  if (
    request.headers.get('x-nextjs-data') ||
    request.headers.get('RSC') === '1' ||
    url.searchParams.has('_rsc')
  ) {
    return;
  }

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

// ---------- Notifications push ----------
// Le serveur (cron de l'API) envoie { title, body, url, tag } ; l'affichage
// est natif OS — il fonctionne même app fermée (PWA installé, iOS ≥ 16.4).
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Mbolo TV', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Mbolo TV', {
      body: payload.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: payload.tag || undefined,
      data: { url: payload.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const client = clientList[0];
      if (client) {
        // Ramener l'app déjà ouverte sur la bonne page plutôt qu'un doublon.
        return client.navigate(target).catch(() => client.focus());
      }
      return self.clients.openWindow(target);
    }),
  );
});
