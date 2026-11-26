// Offline support. Two caches, both versioned at build time and cleaned up on update:
//   saferaah-air-<build>  the app shell and hashed bundles (cache-first for /assets/)
//   saferaah-air-data-<data>  map data (cache-first; only changes when data-manifest.json does)
// Pages and other files: network first, cache as fallback. API calls never touch the cache.
const BUILD = '__BUILD__';
const DATA_VERSION = '__DATA__';
const CACHE = `saferaah-air-${BUILD}`;
const DATA = `saferaah-air-data-${DATA_VERSION}`;
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', 'fonts/noto/0-255.pbf', 'fonts/noto/256-511.pbf'];

self.addEventListener('install', (e) => {
  // only the small shell here: the big map data is cached as the app loads it (no second download)
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k.startsWith('saferaah-air-') && k !== CACHE && k !== DATA).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isData = (u) => u.pathname.includes('/data/') || u.pathname.includes('/help/');
const isImmutable = (u) => u.pathname.includes('/assets/');

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  if (isData(url) || isImmutable(url)) {
    const name = isData(url) ? DATA : CACHE;
    e.respondWith(caches.open(name).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))),
  );
});

// The first visit loads before this worker controls the page; the app then sends the list of
// files it loaded, and they are copied into the caches (from the browser's HTTP cache).
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'warm' || !Array.isArray(e.data.urls)) return;
  e.waitUntil((async () => {
    for (const raw of e.data.urls.slice(0, 200)) {
      try {
        const u = new URL(raw);
        if (u.origin !== location.origin || u.pathname.includes('/api/')) continue;
        const c = await caches.open(isData(u) ? DATA : CACHE);
        if (!(await c.match(u.href))) await c.add(u.href);
      } catch { /* best effort */ }
    }
  })());
});
