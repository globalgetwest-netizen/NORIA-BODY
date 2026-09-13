/**
 * NORIA BODY OS — the body's own tiny server.
 *
 * Two jobs, nothing more:
 *   1. Serve the Virtual Noria front-end from /public.
 *   2. Proxy the browser's request to the EXISTING Noria Engine's streaming API.
 *
 * The proxy is why the front-end never talks to the Engine cross-origin: the
 * browser calls THIS server (same-origin), and this server calls the Engine
 * server-to-server (no CORS). The Engine is never modified and is unaware of us.
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINE = (process.env.NORIA_ENGINE_URL || 'https://noria-engine.onrender.com').replace(/\/+$/, '')
const PORT = Number(process.env.PORT) || 5178
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public')

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })
}

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (p === '/') p = '/index.html'
  const full = normalize(join(PUBLIC, p))
  if (!full.startsWith(PUBLIC)) { res.writeHead(403).end('Forbidden'); return }
  try {
    const buf = await readFile(full)
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' })
    res.end(buf)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x')

  // Body-OS → Engine proxy (streaming). The one and only touch-point to the brain.
  if (pathname === '/brain/ask/stream' && req.method === 'POST') {
    const body = await readBody(req)
    let upstream
    try {
      upstream = await fetch(`${ENGINE}/v1/ask/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/event-stream' })
      res.end(`data: ${JSON.stringify({ error: 'Cannot reach Noria Engine: ' + e.message })}\n\n`)
      return
    }
    res.writeHead(upstream.status, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    })
    const reader = upstream.body.getReader()
    const dec = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(dec.decode(value, { stream: true }))
      }
    } catch { /* client/upstream dropped */ }
    res.end()
    return
  }

  // Non-streaming ask — used for the structured JSON control protocol (we need
  // the whole answer to parse it, so streaming tokens don't apply here).
  if (pathname === '/brain/ask' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const r = await fetch(`${ENGINE}/v1/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      const t = await r.text()
      res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(t)
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Cannot reach Noria Engine: ' + e.message }))
    }
    return
  }

  // Convenience: health passthrough so the UI can show which brain it's wired to.
  if (pathname === '/brain/health') {
    try {
      const r = await fetch(`${ENGINE}/health`)
      const t = await r.text()
      res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(t)
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'unreachable', error: e.message, engine: ENGINE }))
    }
    return
  }

  await serveStatic(req, res)
})

server.listen(PORT, () => {
  console.log(`NORIA Body OS on http://localhost:${PORT}`)
  console.log(`Brain (Noria Engine): ${ENGINE}`)
})
