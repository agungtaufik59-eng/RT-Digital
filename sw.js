const CACHE_NAME = 'rt-digital-v2';
const urlsToCache = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// ===== INSTALL: cache aset statis =====
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Cache dibuka:', CACHE_NAME);
      return cache.addAll(urlsToCache);
    })
  );
  self.skipWaiting();
});

// ===== ACTIVATE: hapus cache lama =====
self.addEventListener('activate', event => {
  const whitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.map(n => {
          if (whitelist.indexOf(n) === -1) {
            console.log('[SW] Hapus cache lama:', n);
            return caches.delete(n);
          }
        })
      )
    )
  );
  self.clients.claim();
});

// ===== FETCH: cache-first untuk aset, biarkan GAS fresh =====
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Jangan cache request ke Google Apps Script (biar selalu fresh)
  if (url.indexOf('script.google.com') >= 0 ||
      url.indexOf('googleusercontent.com') >= 0 ||
      url.indexOf('google.com') >= 0) {
    return;
  }

  // Hanya cache request GET
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // Cache hit → return cache + refresh di background
        fetch(event.request)
          .then(res => {
            if (res && res.status === 200) {
              caches.open(CACHE_NAME).then(c => c.put(event.request, res));
            }
          })
          .catch(() => { /* silent */ });
        return cached;
      }

      // Cache miss → fetch network
      return fetch(event.request).then(res => {
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        return res;
      });
    })
  );
});
