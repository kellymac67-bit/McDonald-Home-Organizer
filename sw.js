// Keeps the app shell available so the home-screen app opens fast. Data always comes live from Supabase.
const CACHE = 'organizer-v7';
const SHELL = ['/', '/index.html', '/app.css', '/js/app.js', '/js/config.js', '/manifest.json', '/icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Pages (/, /b/XMAS-07, /loc/GAR-A1 …) all serve the app; try network first so updates arrive.
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).catch(() => caches.match('/index.html')));
    return;
  }
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(res => {
    const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res;
  }).catch(() => caches.match(e.request)));
});
