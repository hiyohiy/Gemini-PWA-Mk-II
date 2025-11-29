// sw.js - Enhanced error handling and performance optimization

const CACHE_NAME = 'gemini-pwa-cache-v0.53'; // バージョンアップ: 改良版
const urlsToCache = [
  './', // ルートパス (index.html を指すことが多い)
  './index.html',
  './manifest.json',
  './marked.js',
  './style.css',
  './app.js',
  './function-calling.js',
  // アイコンファイルもキャッシュする場合 (manifest.json で指定したもの)
  './icon-192x192.png',
];

// キャッシュの最大サイズ制限を追加
const MAX_CACHE_SIZE = 50; // 最大キャッシュエントリ数

// キャッシュサイズ管理関数
async function limitCacheSize(cacheName, maxSize) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxSize) {
    console.log(`SW: Cache limit exceeded (${keys.length}/${maxSize}). Deleting oldest entries...`);
    await cache.delete(keys[0]);
    await limitCacheSize(cacheName, maxSize);
  }
}

// インストール時にキャッシュを作成 (Enhanced error handling)
self.addEventListener('install', (event) => {
  console.log('SW: Installing new service worker...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('SW: Opened cache');
        // 個別にキャッシュして、一部が失敗しても継続
        return Promise.all(
          urlsToCache.map(url =>
            cache.add(url).catch(err => {
              console.warn(`SW: Failed to cache ${url}:`, err);
              return null; // エラーを無視して続行
            })
          )
        );
      })
      .then(() => {
        console.log('SW: Cache initialization complete');
        // インストール完了後、すぐにアクティブにする (古いSWを待たない)
        return self.skipWaiting();
      })
      .catch(error => {
        console.error('SW: Critical error during install:', error);
      })
  );
});

// フェッチイベントの処理
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // APIリクエスト (Google APIへのPOST) はService Workerの処理から完全に除外する
  if (requestUrl.hostname === 'generativelanguage.googleapis.com' && event.request.method === 'POST') {
    return; 
  }

  // それ以外のリクエスト (主にGET) はキャッシュ優先戦略 (Cache falling back to network)
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        if (response) {
          // console.log('SW: Serving from cache:', event.request.url);
          return response;
        }
        // キャッシュになければネットワークから取得
        return fetch(event.request).then(
          (networkResponse) => {
            // 成功したGETリクエストのレスポンスをキャッシュ
            if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
               const isCachable = urlsToCache.some(url => {
                   if (url === './') return requestUrl.pathname === '/' || requestUrl.pathname === '/index.html';
                   return requestUrl.pathname.endsWith(url.substring(1));
               });
               if (isCachable) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME)
                      .then(cache => {
                        cache.put(event.request, responseToCache);
                        // キャッシュサイズ制限を適用
                        return limitCacheSize(CACHE_NAME, MAX_CACHE_SIZE);
                      })
                      .catch(err => console.warn('SW: Cache put error:', err));
               }
            }
            return networkResponse;
          }
        ).catch(error => {
          console.error('SW: Fetch failed for:', event.request.url, error);
          // オフライン時のフォールバック
          const acceptHeader = event.request.headers.get('accept') || '';
          if (acceptHeader.includes('application/json')) {
            return new Response(JSON.stringify({ error: 'Offline or network error' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' }
            });
          }
          if (acceptHeader.includes('text/html')) {
            // HTMLリクエストの場合、キャッシュからindex.htmlを返す
            return caches.match('./index.html')
              .then(cachedResponse => cachedResponse || new Response('Network error occurred.', {
                status: 503,
                statusText: 'Service Unavailable'
              }));
          }
          return new Response('Network error occurred.', {
            status: 503,
            statusText: 'Service Unavailable'
          });
        });
      })
  );
});

// activateイベントで古いキャッシュを削除 & クライアント制御の要求
self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            console.log('SW: Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('SW: Activating new version and claiming clients...');
      // 新しいService Workerがアクティブになったら、すぐにクライアントを制御する
      // この後、クライアント側で 'controllerchange' イベントが発火する
      return self.clients.claim();
    })
  );
});

// メッセージリスナー (キャッシュクリア用)
self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'clearCache') {
    console.log('SW: Clearing cache...');
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          return caches.delete(cacheName);
        })
      );
    }).then(() => {
      console.log('SW: Cache cleared.');
      // Service Workerの登録解除(unregister)やリロード命令を削除します。
      // キャッシュクリアが完了したことをクライアントに通知するだけに留めます。
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
          clients.forEach(client => {
              client.postMessage({ status: 'cacheCleared' });
          });
      });
    }).catch(error => {
      console.error('SW: Failed to clear cache:', error);
       self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
          clients.forEach(client => {
              client.postMessage({ status: 'cacheClearFailed', error: error.message });
          });
      });
    });
  }
});