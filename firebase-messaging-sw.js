// firebase-messaging-sw.js - Handles background push notifications
importScripts('https://www.gstatic.com/firebasejs/10.8.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDj63mPMog4eXIdNBcUalkipaxcA090Rik",
  authDomain: "examforge.com.ng",
  projectId: "examforgetest",
  storageBucket: "examforgetest.firebasestorage.app",
  messagingSenderId: "676042786985",
  appId: "1:676042786985:web:1d69719ed17cd03f9b41b8",
  measurementId: "G-G4FXC8KDT2"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  const data = payload.data || {};
  const title = data.title || 'ExamForge';
  const options = {
    body: data.body || '',
    icon: '/examforge.jpeg',
    badge: '/512.png',
    image: '/examforge.jpeg',
    data: { url: data.url || '/' },
    vibrate: [200, 100, 200],
    requireInteraction: true
  };
  self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clientList) {
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          const baseUrl = url.split('?')[0].split('#')[0];
          if (client.url.includes(baseUrl) && 'focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) return clients.openWindow(url);
      })
  );
});
