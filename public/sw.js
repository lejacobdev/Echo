// Echo service worker: precached app shell for first-launch offline support,
// network-first for every subsequent fetch. API and WebSocket traffic
// always goes to the network untouched.
const VERSION = 'echo-v1.11.0';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/js/main.js',
  '/js/find.js',
  '/js/social.js',
  '/js/audio.js',
  '/js/ranging.js',
  '/js/ranging-worklet.js',
  '/js/goertzel.js',
  '/js/geo.js',
  '/js/net.js',
  '/js/i18n.js',
  '/js/qr.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
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
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  if (event.request.mode === 'navigate') {
    // Network-first for navigations so deploys land, shell fallback offline.
    event.respondWith(
      fetch(event.request, { cache: 'reload' }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Network-first for every asset (CSS/JS/manifest/icons): a code or design
  // change shows up on the very next reload, online, with no manual cache
  // version bump required. `cache: 'reload'` also bypasses the browser's
  // own HTTP cache, so this is the one true source of freshness. The cache
  // is only ever a fallback, for when there's no network at all (Nearby
  // mode's offline support).
  event.respondWith(
    fetch(event.request, { cache: 'reload' })
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(VERSION).then((cache) => cache.put(event.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
