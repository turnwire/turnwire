const CACHE = 'turnwire-shell-v1';
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/', '/icon.svg', '/manifest.webmanifest']))); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || event.request.headers.has('authorization') || ['/rpc', '/devices', '/events', '/health'].includes(url.pathname)) return;
  if (event.request.mode === 'navigate') { event.respondWith(fetch(event.request).catch(() => caches.match('/'))); return; }
  if (!url.pathname.startsWith('/assets/') && !['/icon.svg', '/manifest.webmanifest'].includes(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async cache => { const cached = await cache.match(event.request); if (cached) return cached; const response = await fetch(event.request); if (response.ok) await cache.put(event.request, response.clone()); return response; }));
});
self.addEventListener('push', event => {
  // Push is a generic hint. Never trust its payload as an approval or execute a command here.
  event.waitUntil(self.registration.showNotification('Turnwire 需要你的处理', { body: '打开收件箱查看最新待办。', icon: '/icon.svg', badge: '/icon.svg', tag: 'turnwire-inbox', data: { path: '/?inbox=1' } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
    const window = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (window) { await window.focus(); window.postMessage({ type: 'turnwire.inbox' }); }
    else await clients.openWindow('/?inbox=1');
  }));
});
