const FONT_CACHE = 'examforge-cache-v19';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(names.map((n) => {
        if (n !== FONT_CACHE) return caches.delete(n);
      }));
    }).then(() => clients.claim())
  );
});

// async function cacheFirst(r) {
//   const c = await caches.open(FONT_CACHE);
//   const cached = await c.match(r);
//   if (cached) return cached;
//   try {
//     const net = await fetch(r);
//     if (net && net.status === 200) c.put(r, net.clone());
//     return net;
//   } catch(e) { throw e; }
// }

// self.addEventListener('fetch', (event) => {
//   const url = new URL(event.request.url);
//   if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
//     event.respondWith(cacheFirst(event.request));
//   }
// });

// Handle all notification clicks
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(list) {
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          const base = url.split('?')[0].split('#')[0];
          if (c.url.includes(base) && 'focus' in c) return c.focus();
        }
        if (clients.openWindow) return clients.openWindow(url);
      })
  );
});

// Handle push events (FCM background)
self.addEventListener('push', function(event) {
  if (!event.data) return;
  try {
    const d = event.data.json();
    const title = d.notification?.title || d.title || 'ExamForge';
    const options = {
      body: d.notification?.body || d.body || '',
      icon: '/examforge.jpeg',
      badge: '/512.png',
      image: '/examforge.jpeg',
      data: { url: d.data?.url || d.click_action || '/' },
      vibrate: [200, 100, 200],
      requireInteraction: true
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch(e) {
    event.waitUntil(
      self.registration.showNotification('ExamForge', {
        body: event.data.text(), icon: '/examforge.jpeg'
      })
    );
  }
});
