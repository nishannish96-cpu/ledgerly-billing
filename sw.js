const CACHE_NAME = 'ledgerly-shell-v64';
const APP_SHELL = [
  './',
  './index.html',
  './login.html',
  './billing.html',
  './styles.css',
  './login.css',
  './dark-mode.css',
  './app.js?v=136',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(async keys => {
      await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)));
      const cache = await caches.open(CACHE_NAME);
      const requests = await cache.keys();
      await Promise.all(requests.filter(request => new URL(request.url).pathname.startsWith('/api/')).map(request => cache.delete(request)));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin === self.location.origin && requestUrl.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
    return;
  }
  const requestPath = requestUrl.pathname;
  const liveAsset = requestPath.endsWith('.html') || requestPath.endsWith('.js');
  event.respondWith(
    (liveAsset ? fetch(event.request).then(response => {
      if (!response.ok) return response;
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request)) : caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      if (!response.ok) return response;
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      return response;
    }))).catch(() => caches.match('./index.html'))
  );
});
