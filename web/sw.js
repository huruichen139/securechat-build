self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => {
  self.registration.unregister();
  caches.keys().then(k => k.forEach(x => caches.delete(x)));
  self.clients.matchAll().then(clients => clients.forEach(c => c.navigate(c.url)));
});
