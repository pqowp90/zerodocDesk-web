'use strict';
const CACHE = 'deskdoc-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
e.waitUntil((async () => {
for (const k of await caches.keys()) if (k.startsWith('deskdoc-') && k !== CACHE) await caches.delete(k);
await self.clients.claim();
})());
});
self.addEventListener('fetch', (e) => {
const req = e.request;
if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
e.respondWith((async () => {
const cache = await caches.open(CACHE);
try {
const res = await fetch(req);
if (res.ok) cache.put(req, res.clone()).catch(() => {});
return res;
} catch (err) {
const hit = await cache.match(req, { ignoreSearch: true });
if (hit) return hit;
throw err;
}
})());
});
