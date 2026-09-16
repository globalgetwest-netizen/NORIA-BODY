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

// ── Live web search (free, no API key) ────────────────────────────────────────
// Grounds Noria on current information, the way Gemini searches. Server-side so
// there's no CORS and no key. DuckDuckGo HTML results, with an Instant-Answer
// fallback. The Engine is never involved — this is the Body's own capability.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
}
function decodeDDG(u) {
  try {
    if (u.includes('uddg=')) {
      const uddg = new URL(u.startsWith('//') ? 'https:' + u : u).searchParams.get('uddg')
      if (uddg) return decodeURIComponent(uddg)
    }
  } catch {}
  return u.startsWith('//') ? 'https:' + u : u
}
async function webSearch(q) {
  const results = []
  try {
    const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } })
    const html = await r.text()
    const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let m
    while ((m = re.exec(html)) && results.length < 6) {
      const url = decodeDDG(m[1]), title = stripTags(m[2]), snippet = stripTags(m[3])
      if (title && snippet) results.push({ url, title, snippet })
    }
  } catch {}
  if (!results.length) {
    try {
      const r = await fetch('https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=' + encodeURIComponent(q), { headers: { 'User-Agent': UA } })
      const j = await r.json()
      if (j.AbstractText) results.push({ title: j.Heading || q, snippet: j.AbstractText, url: j.AbstractURL || '' })
      ;(j.RelatedTopics || []).forEach((t) => { if (t.Text && results.length < 6) results.push({ title: (t.Text || '').split(' - ')[0].slice(0, 90), snippet: t.Text, url: t.FirstURL || '' }) })
    } catch {}
  }
  return results
}

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  if (p === '/') p = '/index.html'
  const full = normalize(join(PUBLIC, p))
  if (!full.startsWith(PUBLIC)) { res.writeHead(403).end('Forbidden'); return }
  try {
    const buf = await readFile(full)
    const ext = extname(full)
    // HTML/JS/CSS/JSON must always revalidate so updates reach users immediately;
    // images/fonts/audio can be cached a while (their URLs change when replaced).
    const longCache = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.mp3', '.wav', '.ogg'].includes(ext)
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': longCache ? 'public, max-age=604800' : 'no-cache',
    })
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

  // Feedback (👍/👎) → the Engine's review pipeline. The learning loop's input.
  if (pathname === '/brain/feedback' && req.method === 'POST') {
    const body = await readBody(req)
    try {
      const r = await fetch(`${ENGINE}/v1/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      const t = await r.text()
      res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(t)
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message }))
    }
    return
  }

  // Live web search — the Body's own grounding capability (free, no key).
  if (pathname === '/search' && req.method === 'GET') {
    const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').trim()
    if (!q) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'no query' })); return }
    try {
      const results = await webSearch(q)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ query: q, results }))
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ query: q, results: [], error: e.message }))
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
