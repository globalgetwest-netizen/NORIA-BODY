/* Noria PWA service worker — hardened so it can NEVER hang or break opening the
 * app. Page navigations and the engine (/brain) are never intercepted; they go
 * straight to the network. Scripts/styles use network-first WITH a timeout so a
 * slow moment falls back to cache instead of hanging. Images/fonts are cache-first. */
const CACHE = 'noria-v3'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
  await self.clients.claim()
})()))

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
}

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET') return
  // Never touch the page open, the engine, or cross-origin — always straight to network.
  if (req.mode === 'navigate' || url.origin !== location.origin || url.pathname.startsWith('/brain')) return

  const dest = req.destination
  if (dest === 'image' || dest === 'font' || dest === 'audio' || dest === 'video') {
    // Static media: cache-first, refresh in the background.
    e.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const hit = await cache.match(req)
      if (hit) { fetch(req).then((r) => { if (r && r.ok) cache.put(req, r.clone()) }).catch(() => {}); return hit }
      try { const r = await fetch(req); if (r && r.ok) cache.put(req, r.clone()); return r } catch { return hit || Response.error() }
    })())
    return
  }
  // Scripts / styles / json: fresh when possible, cache fallback, never hang.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE)
    try {
      const r = await withTimeout(fetch(req), 5000)
      if (r && r.ok) cache.put(req, r.clone())
      return r
    } catch {
      const hit = await cache.match(req)
      if (hit) return hit
      return fetch(req) // last resort: a plain fetch (may still succeed slowly) instead of failing
    }
  })())
})
