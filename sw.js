'use strict';
const CACHE = 'deskdoc-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
e.waitUntil((async () => {
for (const k of await caches.keys()) if (k.startsWith('deskdoc-') && k !== CACHE) await caches.delete(k);
await self.clients.claim();
})());
});
const ROOT = new URL('./', self.location).href;
const deskOf = () => (self.registration.scope.match(/\/push\/([0-9a-f]{64})\/$/) || [])[1] || '';
self.addEventListener('push', (e) => {
let m = {};
try { m = e.data ? e.data.json() : {}; } catch {}
const tab = Number.isInteger(m.tab) ? m.tab : null;
e.waitUntil(self.registration.showNotification(m.title || 'DeskDoc', {
body: m.body || '',
tag: tab === null ? 'zd' : `zd-${tab}`,
renotify: true,
icon: `${ROOT}icons/icon-192.png`,
data: { desk: deskOf(), tab },
}));
});
self.addEventListener('notificationclick', (e) => {
e.notification.close();
const { desk = '', tab = null } = e.notification.data || {};
e.waitUntil((async () => {
const open = { t: 'zd-open', desk, tab };
const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
const w = wins.find((c) => c.url.startsWith(ROOT));
if (w) {
try { await w.focus(); } catch {}
w.postMessage(open);
return;
}
const q = new URLSearchParams({ open: desk });
if (tab !== null) q.set('tab', String(tab));
await self.clients.openWindow(`${ROOT}?${q}`);
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
