const CACHE_NAME = 'nexus-chat-v6';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {}));
          }
          return response;
        })
        .catch(async () => {
          const cachedPage = await caches.match(request).catch(() => undefined)
          if (cachedPage) return cachedPage
          const appShell = await caches.match('/index.html').catch(() => undefined)
          return appShell || new Response('Nexus Chat is temporarily unavailable offline.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          })
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request)
      .catch(() => undefined)
      .then((cached) => cached || fetch(request))
      .catch(() => new Response('This resource is temporarily unavailable.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }))
  );
});

// Routes a notification tap (or its "Open"/"Dismiss" action button) to the app.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const target = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil((async () => {
    const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientList) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target).catch(() => undefined);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

// Renders a notification for a Web Push message so closed-app delivery keeps the
// same preview content and action buttons as in-app notifications.
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Nexus Chat', body: event.data.text() };
  }

  event.waitUntil(self.registration.showNotification(payload.title || 'Nexus Chat', {
    body: payload.body || payload.preview || 'You received a new message.',
    icon: payload.icon || '/nexus-logo.svg',
    tag: payload.tag,
    data: { url: payload.url || '/app' },
    actions: [
      { action: 'open', title: 'Open' },
      { action: 'dismiss', title: 'Dismiss' },
    ],
  }));
});
