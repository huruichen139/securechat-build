/* SecureChat Service Worker —�?网络优先，缓存静态资源以加速加�?*/
'use strict';

const CACHE = 'securechat-auto-route-v15';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/e2ee.js',
  '/i18n.js',
  '/ai.js',
  '/webrtc.js',
  '/manifest.json'
];

// 安装：预缓存核心资源
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 请求：网络优先，失败回退缓存
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 只处理同源请求；API/WS 走网络不缓存
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/ws')) return;

  // 不缓存后台页面（避免更新后卡旧版）
  if (url.pathname.startsWith('/admin')) return;
  if (url.pathname.startsWith('/download')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // 只缓存成功的静态资源
        if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});
