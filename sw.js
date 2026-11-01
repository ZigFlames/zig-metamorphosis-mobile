/* Offline support for Zig Metamorphosis. Caches only this app's own files.
   Never touches your videos: picked files are local blob: URLs and pasted links go straight to their server. */
const CACHE = 'zig-mobile-v2';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'demo.mp4',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Safari asks for video in byte ranges; answer them from the cached copy so the demo plays offline.
async function rangeFromCache(req) {
  const cached = await caches.match(req.url.split('#')[0], { ignoreSearch: true });
  if (!cached) return fetch(req);
  const buf = await cached.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  const size = buf.byteLength;
  let start = m && m[1] ? Number(m[1]) : 0, end = m && m[2] ? Number(m[2]) : size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  end = Math.min(end, size - 1);
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers: {
    'Content-Type': cached.headers.get('Content-Type') || 'video/mp4', 'Content-Length': String(end - start + 1),
    'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' } });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // pasted video links: not ours, leave alone
  if (req.headers.has('range')) { e.respondWith(rangeFromCache(req)); return; }
  // app files: network first (so updates arrive), cache when offline
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && res.type === 'basic' && !url.pathname.endsWith('.mp4')) {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
