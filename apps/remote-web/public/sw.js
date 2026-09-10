// The phone's offline shell. Two rules keep an old interface from coming back to life:
//   1. a navigation is network-first and the fresh page replaces the cached one, so the offline
//      fallback is the last page actually seen rather than the one that happened to be up when
//      this worker first installed;
//   2. a new worker takes over immediately instead of waiting for every tab to close, and a cache
//      name it does not recognise is deleted.
// Hashed assets under /assets/ may be cached first: their name changes when their content does.
const CACHE = 'turnwire-shell-v2';
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/', '/icon-192.png', '/apple-touch-icon.png', '/manifest.webmanifest'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || event.request.headers.has('authorization') || ['/rpc', '/devices', '/events', '/health'].includes(url.pathname)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(async response => {
      // Keep the newest shell for the offline case; a page that was never stored cannot be served.
      if (response.ok) await caches.open(CACHE).then(cache => cache.put('/', response.clone()));
      return response;
    }).catch(async () => (await caches.match('/')) ?? Response.error()));
    return;
  }
  if (!url.pathname.startsWith('/assets/') && !['/icon-192.png', '/apple-touch-icon.png', '/manifest.webmanifest'].includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async cache => { const cached = await cache.match(event.request); if (cached) return cached; const response = await fetch(event.request); if (response.ok) await cache.put(event.request, response.clone()); return response; }));
});
self.addEventListener('push', event => {
  // Push is a generic hint. Never trust its payload as an approval or execute a command here.
  event.waitUntil(self.registration.showNotification('Turnwire 需要你的处理', { body: '打开收件箱查看最新待办。', icon: '/icon-192.png', tag: 'turnwire-inbox', data: { path: '/?inbox=1' } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
    const window = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (window) { await window.focus(); window.postMessage({ type: 'turnwire.inbox' }); }
    else await clients.openWindow('/?inbox=1');
  }));
});
