// sw.js - Cache-First for Google Fonts, passthrough for everything else
const FONT_CACHE_NAME = 'examforge-fonts-cache-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  console.log('Service Worker: Installed (Font Caching Mode)');
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== FONT_CACHE_NAME) {
            console.log('Service Worker: Clearing old cache');
            return caches.delete(cache);
          }
        })
      );
    }).then(() => clients.claim())
  );
  console.log('Service Worker: Activated');
});

async function cacheFirstStrategy(request) {
  const cache = await caches.open(FONT_CACHE_NAME);
  const cachedResponse = await cache.match(request);

  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const networkResponse = await fetch(request);
    if (networkResponse && networkResponse.status === 200) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    console.error('Service Worker: Fetch failed for font asset', error);
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Cache Google Fonts CSS
  if (url.origin === 'https://fonts.googleapis.com') {
    event.respondWith(cacheFirstStrategy(event.request));
    return;
  }

  // Cache Google Font files (.woff2)
  if (url.origin === 'https://fonts.gstatic.com') {
    event.respondWith(cacheFirstStrategy(event.request));
    return;
  }

  // For EVERYTHING else (Firebase, your app files, APIs):
  // Do NOT call event.respondWith() — let the browser handle natively.
  // This is critical: Firebase uses WebSockets/long-polling that break
  // when intercepted by a service worker fetch() call.
});