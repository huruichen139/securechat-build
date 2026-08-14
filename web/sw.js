/* SecureChat Service Worker - network-first, cache static assets */
'use strict';

const CACHE = 'securechat-auto-route-v53';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js?v=1-53-0-0',
  '/e2ee.js',
  '/jsqr.js?v=1-53-0-0',
  '/i18n.js',
  '/ai.js?v=1-53-0-0',
  '/webrtc.js?v=1-24-3-26',
  '/manifest.json',
  '/modules/registry.js?v=1-53-0-1',
  '/modules/groups.js?v=1-53-0-1',
  '/modules/chat-ext.js?v=1-53-0-1',
  '/modules/rtc.js?v=1-53-0-1',
  '/modules/voicemsg.js?v=1-53-0-1',
  '/modules/filehelper.js?v=1-53-0-1',
  '/modules/oa.js?v=1-53-0-1',
  '/modules/videos.js?v=1-53-0-1',
  '/modules/live.js?v=1-53-0-1',
  '/modules/miniapp.js?v=1-53-0-1',
  '/modules/nearby.js?v=1-53-0-1',
  '/modules/shake.js?v=1-53-0-1',
  '/modules/scan.js?v=1-53-0-1',
  '/modules/pay.js?v=1-53-0-1',
  '/modules/status.js?v=1-53-0-1',
  '/modules/favorites.js?v=1-53-0-1',
  '/modules/moment-ext.js?v=1-53-0-1',
  '/modules/polls.js?v=1-53-0-1',
  '/modules/remind.js?v=1-53-0-1',
  '/modules/todos.js?v=1-53-0-1',
  '/modules/translate.js?v=1-53-0-1'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/ws')) return;

  if (url.pathname.startsWith('/admin')) return;
  if (url.pathname.startsWith('/download')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});



