// Joldipabo CRM service worker — scaffolding only.
//
// What this does today:
//   - Caches the application shell (HTML, JS, CSS, manifest) so the app can
//     be launched from the home screen and rendered even if the network is
//     unreachable at first paint.
//   - Serves shell assets from cache-first when present, falling back to the
//     network.
//
// What this deliberately does NOT do today:
//   - Does NOT cache any /api/* response. CRM data is read-only against the
//     server; caching it via the SW would risk leaking data across users on
//     shared devices. See docs/BACKEND_INTEGRATION_PLAN.md and docs/PWA_OFFLINE_PLAN.md.
//   - Does NOT register a sync handler. The offline queue
//     (src/services/offlineQueue.js) flushes will be wired in the next phase.
//   - Does NOT handle Push notifications. The notification strategy is
//     described in docs/PWA_OFFLINE_PLAN.md §8.
//
// Cache strategy: cache-first with network fallback for the shell. New shell
// versions (different bundled JS/CSS hashes) bust the cache automatically on
// activate because the cache name includes the package version.
//
// Lifecycle:
//   install  → pre-cache the manifest and a small set of shell URLs
//   activate → remove any prior cache
//   fetch    → handle static GETs; everything else is passthrough
//
// Future extension points (see docs/PWA_OFFLINE_PLAN.md §10):
//   - 'sync' event listener that calls into src/services/syncWorker.js.
//   - 'push' event listener for manager message notifications.
//   - 'periodicsync' for background flush.

// Bump this when the caching STRATEGY changes, not on every build. The
// activate handler deletes any cache whose name differs, so a bump is what
// purges a stale shell from a device that already installed the old worker.
const CACHE_NAME = 'joldipabo-shell-v2';
const SHELL_URLS = [
  '/',
  '/manifest.webmanifest',
  '/joldipabo-logo.jpg',
  '/orchid-heights.png',
  '/nexa-courtyard.png',
  '/skyline-vista.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Pre-cache best-effort. Missing assets do not block install.
      await Promise.allSettled(SHELL_URLS.map((url) => cache.add(url)));
      self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache API responses. The future API repository owns /api/* and
  // will be served straight from the network.
  if (url.pathname.startsWith('/api/')) return;

  // Navigations (the HTML document) are NETWORK-FIRST.
  //
  // Cache-first here is a trap: index.html names the hashed JS/CSS bundles,
  // so a cached document keeps pointing at files a rebuild has replaced —
  // the app then runs (or fails to run) a stale build with no visible cause.
  // Network-first means a reload always picks up the current build, and the
  // cache only serves when the network is genuinely unavailable.
  const isNavigation = request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');

  if (isNavigation) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (response && response.ok) {
            const cache = await caches.open(CACHE_NAME);
            cache.put('/', response.clone()).catch(() => {});
          }
          return response;
        } catch (err) {
          const cached = await caches.match('/');
          if (cached) return cached;
          throw err;
        }
      })()
    );
    return;
  }

  // Content-hashed assets are immutable per build, so cache-first is safe
  // and makes repeat loads instant.
  const isStaticAsset =
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.webmanifest') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.svg');

  if (!isStaticAsset) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response && response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })()
  );
});

// Placeholder for future sync hook. The offline queue
// (src/services/offlineQueue.js) will eventually post a message to this
// service worker to trigger a flush.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // Future: if (event.data && event.data.type === 'FLUSH_QUEUE') { ... }
});
