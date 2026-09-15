/* Noria PWA service worker — network-first (always fresh online), cache
 * fallback for offline. The engine (/brain/*) is never cached. */
const CACHE = 'noria-v1'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
  await self.clients.claim()
})()))

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.pathname.startsWith('/brain')) return
  e.respondWith((async () => {
    const cache = await caches.open(CACHE)
    try {
      const res = await fetch(e.request)
      if (res && res.ok && url.origin === location.origin) cache.put(e.request, res.clone())
      return res
    } catch (err) {
      const hit = await cache.match(e.request)
      if (hit) return hit
      if (e.request.mode === 'navigate') {
        const shell = await cache.match('/workspace.html')
        if (shell) return shell
      }
      throw err
    }
  })())
})
