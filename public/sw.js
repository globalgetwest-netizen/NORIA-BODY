/* Noria — the service worker is retired.
 * This build exists only to CLEAN UP: it unregisters any previously installed
 * Noria service worker and deletes its caches, so every device loads the app
 * directly from the network. No request is ever intercepted, so it can never
 * hang the app or serve stale/broken code again. */
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { for (const k of await caches.keys()) await caches.delete(k) } catch {}
    try { await self.registration.unregister() } catch {}
    try {
      const clients = await self.clients.matchAll({ type: 'window' })
      for (const c of clients) { try { c.navigate(c.url) } catch {} }
    } catch {}
  })())
})
/* No fetch handler on purpose — the network is used directly. */
