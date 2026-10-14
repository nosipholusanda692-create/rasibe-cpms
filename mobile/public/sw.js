/*
 * Shell cache only.
 *
 * API responses are never cached: a stale timesheet is worse than no timesheet,
 * and work that spans a connection gap is carried by the offline queue in
 * localStorage, not by this worker. The worker exists so the app opens at all
 * when a consultant is in a building with no signal.
 */
const CACHE = 'rasibe-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(['/', '/index.html', '/manifest.webmanifest']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never touch the API, and never interfere with a write.
  if (url.pathname.startsWith('/api/') || event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then((hit) => hit ?? caches.match('/index.html')),
      ),
  );
});
