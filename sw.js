/* MPGB Premier League - simple PWA service worker */
const CACHE_NAME = 'mpgb-pl-v1';
const PRECACHE = [
  './',
  './index.html',
  './schedule.html',
  './points.html',
  './teams.html',
  './venues.html',
  './rules.html',
  './admin.html',
  './scorer.html',
  './live.html',
  './scorecard.html',
  './stats.html',
  './manifest.json',
  './css/app.css',
  './js/app.js',
  './js/scoring-core.js',
  './js/store-fb.js',
  './js/page-index.js',
  './js/page-scorer.js',
  './js/page-scorecard.js',
  './js/page-schedule.js',
  './js/page-points.js',
  './js/page-teams.js',
  './js/page-venues.js',
  './js/page-rules.js',
  './js/page-admin.js',
  './js/page-stats.js',
  './data/tournament.json',
  './assets/icons/favicon-32.png',
  './favicon.ico',
  './assets/icons/icon-192.png',
  './assets/icons/icon-192-maskable.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GET
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        // Cache successful basic responses
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      }).catch(() => cached); // if network fails and nothing cached, browser will handle
    })
  );
});
