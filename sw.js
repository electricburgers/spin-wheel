// Service worker for offline-first PWA support. Paths are all relative to this file's own
// location (not root-absolute) so caching still works when the site is served from a GitHub
// Pages repo subpath (username.github.io/repo-name/).
const CACHE_VERSION = 'v3';
const CACHE_NAME = `spin-wheel-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './audio/start.wav',
  './audio/loop.wav',
  './audio/end.wav',
  './icons/icon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate for same-origin GET requests: serve from cache immediately when
// available (so the app is instantly usable offline), while refreshing the cache in the
// background so the next load picks up any change.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request)
        .then((response) => {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      if (cached) {
        networkFetch.catch(() => {}); // refresh in background, ignore failures
        return cached;
      }
      const networkResponse = await networkFetch;
      if (networkResponse) return networkResponse;
      if (request.mode === 'navigate') return cache.match('./index.html');
      return Response.error();
    }),
  );
});
