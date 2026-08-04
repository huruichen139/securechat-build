/* SecureChat Service Worker 鈥旓拷?缃戠粶浼樺厛锛岀紦瀛橀潤鎬佽祫婧愪互鍔犻€熷姞锟?*/
'use strict';

const CACHE = 'securechat-auto-route-v37';
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/e2ee.js',
  '/i18n.js',
  '/ai.js',
  '/webrtc.js?v=1-24-3-24',
  '/manifest.json'
];

// 瀹夎锛氶缂撳瓨鏍稿績璧勬簮
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

// 婵€娲伙細娓呯悊鏃х紦瀛?self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 璇锋眰锛氱綉缁滀紭鍏堬紝澶辫触鍥為€€缂撳瓨
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 鍙鐞嗗悓婧愯姹傦紱API/WS 璧扮綉缁滀笉缂撳瓨
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/ws')) return;

  // 涓嶇紦瀛樺悗鍙伴〉闈紙閬垮厤鏇存柊鍚庡崱鏃х増锛?  if (url.pathname.startsWith('/admin')) return;
  if (url.pathname.startsWith('/download')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        // 鍙紦瀛樻垚鍔熺殑闈欐€佽祫婧?        if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});
