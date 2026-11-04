// 오프라인 사용을 위한 캐시. 파일을 바꾸면 VERSION을 올리세요.
const VERSION = 'steelcoat-web-v7';
const FILES = [
  './', 'index.html', 'style.css', 'app.js', 'hbeam_specs.js', 'manifest.webmanifest',
  'vendor/three.module.min.js', 'vendor/OrbitControls.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// 네트워크 우선, 실패하면 캐시 (개발 중 수정 사항이 바로 보이도록)
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== location.origin) return;
  // 브라우저 HTTP 캐시를 거치지 않고 항상 서버에 확인 → 예전 파일과 섞이지 않음
  e.respondWith(fetch(e.request.url, { cache: 'no-cache' })
    .then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
