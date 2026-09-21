/**
 * Noria AI Worker — the Body's vision + image-generation capability, powered by
 * Cloudflare Workers AI (free tier). Uses the account's AI binding, so there is
 * NO API key or secret to store anywhere. CORS-open so the Noria app can call it.
 * The Noria Engine is never involved — this is a separate Body capability.
 */
import { handleAccounts } from './accounts.js'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Noria-Pro, Authorization',
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS })
    const url = new URL(request.url)
    try {
      // Accounts (D1): sign-up, sign-in, profile, preferences and saved conversations. Only reached on /acct/…
      if (url.pathname.startsWith('/acct/')) return await handleAccounts(request, env, url, json, ctx)
      // Noria Pro features (image creation, photo understanding) cost real compute, so they need a valid Pro
      // access code, checked here on the server — not only hidden in the app.
      if ((url.pathname === '/vision' && request.method === 'POST') || (url.pathname === '/image' && (request.method === 'POST' || request.method === 'GET'))) {
        const code = (url.searchParams.get('pro') || request.headers.get('X-Noria-Pro') || '').trim().toUpperCase()
        if (!(await validCode(code, env.PRO_KEY, env.OWNER_KEY))) return json({ error: 'Noria Pro required' }, 402)
      }
      // See a photo: raw image bytes in the body, question in ?prompt=
      if (url.pathname === '/vision' && request.method === 'POST') {
        const prompt = url.searchParams.get('prompt') ||
          'Describe this image in detail: any visible text (read it exactly), objects, people, setting, colors, and notable details.'
        const buf = await request.arrayBuffer()
        const out = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
          image: [...new Uint8Array(buf)], prompt, max_tokens: 512,
        })
        const text = (out && (out.description || out.response || out.text)) || ''
        return json({ text })
      }
      // Generate an image: ?prompt=... → PNG bytes
      if (url.pathname === '/image' && (request.method === 'POST' || request.method === 'GET')) {
        let prompt = url.searchParams.get('prompt') || ''
        if (!prompt && request.method === 'POST') { try { prompt = (await request.json()).prompt || '' } catch {} }
        if (!prompt) return json({ error: 'no prompt' }, 400)
        // Image models are tried in order; the list is a setting (IMAGE_MODELS, comma-separated Cloudflare model ids), so a
        // stronger model can be swapped in later without touching this code. If none works or returns a usable picture, the
        // previous Stable Diffusion XL path below runs exactly as before, so images can only stay the same or get better.
        // A fixed style line (light, lens, detail) is added for these models only; it costs no AI tokens.
        // Model TEST option (Pro only, like the rest of this route): ?model=<@cf/...>&steps=&width=&height= runs exactly that
        // one model and reports its real error if it cannot, so candidates can be compared side by side. No fallback here.
        const testModel = url.searchParams.get('model')
        if (testModel) {
          if (!/^@cf\/[a-z0-9._\/-]+$/i.test(testModel)) return json({ error: 'bad model id' }, 400)
          const params = { prompt: prompt.trim().slice(0, 1900) }
          for (const k of ['steps', 'width', 'height']) { const v = Number(url.searchParams.get(k)); if (v) params[k] = v }
          try {
            let input = params
            if (/flux-2/i.test(testModel)) { // the FLUX.2 models take a multipart form
              const form = new FormData()
              form.append('prompt', params.prompt); form.append('width', String(params.width || 1024)); form.append('height', String(params.height || 1024))
              if (params.steps) form.append('steps', String(params.steps))
              const fr = new Response(form)
              input = { multipart: { body: fr.body, contentType: fr.headers.get('content-type') } }
            }
            const out = await Promise.race([env.AI.run(testModel, input), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout after 60s')), 60000))])
            let bytes = null, type = 'image/jpeg'
            if (out && typeof out.image === 'string' && out.image.length > 1000) { const bin = atob(out.image); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) }
            else if (out instanceof ReadableStream || out instanceof ArrayBuffer || out instanceof Uint8Array) { bytes = out; type = 'image/png' }
            if (!bytes) return json({ model: testModel, error: 'no image in response', keys: out && typeof out === 'object' ? Object.keys(out).slice(0, 8) : typeof out }, 502)
            return new Response(bytes, { headers: { ...CORS, 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Noria-Image-Model': testModel.split('/').pop() } })
          } catch (e) { return json({ model: testModel, error: String((e && e.message) || e).slice(0, 300) }, 502) }
        }
        const allModels = String(env.IMAGE_MODELS || '@cf/black-forest-labs/flux-1-schnell').split(',').map((m) => m.trim()).filter(Boolean)
        const codeUsed = (url.searchParams.get('pro') || request.headers.get('X-Noria-Pro') || '').trim().toUpperCase()
        let led = null
        try { led = await imageLedger(env, codeUsed) } catch (_) { led = null } // if the ledger is unreachable, images still work (unmetered)
        try { if (await env.SYNC.get('imgblock')) return json({ error: 'image_budget', message: 'Noria has used the free image allowance for now. It comes back within a few hours, and midnight UTC at the latest.' }, 429) } catch (_) {}
        if (led) {
          if (led.used >= led.perUser) return json({ error: 'image_limit', message: 'You have reached today\'s image limit for this account. It resets at midnight UTC.' }, 429)
          if (led.spent >= led.budget) return json({ error: 'image_budget', message: 'Noria has used today\'s free image allowance. It resets at midnight UTC.' }, 429)
        }
        const left = led ? led.budget - led.spent : Infinity
        // the costly, higher-quality models may use only the first half of the day's budget; after that the cheap model keeps images flowing
        const models = allModels.filter((m) => { const c = imageCost(env, m); return c <= left && (c <= 500 || !led || led.spent + c <= led.budget * 0.5) })
        if (!models.length) return json({ error: 'image_budget', message: 'Noria has used today\'s free image allowance. It resets at midnight UTC.' }, 429)
        const styled = (prompt.trim() + '. Natural lighting, sharp focus, fine detail, realistic textures, professional photography quality.').slice(0, 1900)
        for (const model of models) {
          try {
            const out = await Promise.race([
              env.AI.run(model, imageInput(model, styled)),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000)),
            ])
            let bytes = null, type = 'image/jpeg'
            if (out && typeof out.image === 'string' && out.image.length > 1000) {
              const bin = atob(out.image); bytes = new Uint8Array(bin.length)
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
            } else if (out instanceof ReadableStream || out instanceof ArrayBuffer || out instanceof Uint8Array) {
              bytes = out; type = 'image/png'
            }
            if (bytes) { if (led) { try { await imageCharge(env, led, imageCost(env, model)) } catch (_) {} } return new Response(bytes, { headers: { ...CORS, 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Noria-Image-Model': model.split('/').pop() } }) }
          } catch (e) { if (isAllowanceError(e)) return await markAllowanceGone(env, led) /* else: try the next model, then Stable Diffusion XL */ }
        }
        let img
        try { img = await env.AI.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', { prompt }) } catch (e) { if (isAllowanceError(e)) return await markAllowanceGone(env, led); throw e }
        if (led) { try { await imageCharge(env, led, imageCost(env, 'stable-diffusion-xl-base-1.0')) } catch (_) {} }
        return new Response(img, { headers: { ...CORS, 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Noria-Image-Model': 'sdxl' } })
      }
      // Natural neural voice — Deepgram Aura (reliable), MeloTTS fallback.
      if (url.pathname === '/tts' && (request.method === 'POST' || request.method === 'GET')) {
        let text = url.searchParams.get('text') || ''
        const lang = url.searchParams.get('lang') || 'en'
        if (!text && request.method === 'POST') { try { text = (await request.json()).text || '' } catch {} }
        text = (text || '').trim()
        if (!text) return json({ error: 'no text' }, 400)
        const speaker = url.searchParams.get('speaker') || 'hera'
        let lastErr = ''
        const AUDIO_MP3 = { ...CORS, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }
        // 0) Deepgram DIRECT — the SAME Aura voice, but called on the account's own
        //    Deepgram API key ($200 free dev credit ≈ millions of characters, no card),
        //    so it is NOT subject to Cloudflare's 10,000-neuron/day cap. Only runs when
        //    DEEPGRAM_KEY is set; otherwise we fall through to the Cloudflare path below.
        // Multiple keys rotate for RESILIENCE (a revoked/rate-limited key falls
        // through to the next). NOTE: keys under one Deepgram account share the same
        // credit pool — rotation adds robustness, not extra free quota.
        const dgKeys = String(env.DEEPGRAM_KEY || '').split(',').map((s) => s.trim()).filter(Boolean)
        if (dgKeys.length) {
          const model = env.DEEPGRAM_MODEL || (speaker === 'orion' ? 'aura-orion-en' : 'aura-hera-en')
          const start = Math.floor(Math.random() * dgKeys.length) // spread load across keys
          for (let n = 0; n < dgKeys.length; n++) {
            const key = dgKeys[(start + n) % dgKeys.length]
            try {
              const dg = await fetch('https://api.deepgram.com/v1/speak?model=' + model + '&encoding=mp3', {
                method: 'POST',
                headers: { 'Authorization': 'Token ' + key, 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: text.slice(0, 1900) }),
              })
              if (dg.ok && dg.body) return new Response(dg.body, { headers: AUDIO_MP3 })
              lastErr = 'deepgram: ' + dg.status + ' ' + (await dg.text().catch(() => '')).slice(0, 140)
            } catch (e) { lastErr = 'deepgram: ' + (e && e.message ? e.message : String(e)) }
          }
        }
        // 1) Deepgram Aura via Cloudflare Workers AI (falls back here if no direct key).
        //    env.AI.run returns the audio as a ReadableStream directly, so stream it back.
        try {
          const aura = await env.AI.run('@cf/deepgram/aura-1', { text: text.slice(0, 1800), speaker })
          const AUDIO = { ...CORS, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }
          if (aura instanceof ReadableStream) return new Response(aura, { headers: AUDIO })
          if (aura && aura.body) return new Response(aura.body, { headers: AUDIO })
          if (aura && aura.audio) { const by = Uint8Array.from(atob(aura.audio), (c) => c.charCodeAt(0)); return new Response(by, { headers: AUDIO }) }
        } catch (e) { lastErr = 'aura: ' + (e && e.message ? e.message : String(e)) }
        // 2) Fall back to MeloTTS (retry its transient 3043 errors).
        const input = { prompt: text.slice(0, 900) }
        if (lang) input.lang = lang
        let out = null
        for (let i = 0; i < 4; i++) {
          try { out = await env.AI.run('@cf/myshell-ai/melotts', input); if (out && out.audio) break }
          catch (e) { lastErr = 'melo: ' + (e && e.message ? e.message : String(e)) }
          await new Promise((r) => setTimeout(r, 300))
        }
        const b64 = (out && out.audio) || ''
        if (!b64) return json({ error: 'tts failed: ' + (lastErr || 'no audio') }, 502)
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        const isWav = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        return new Response(bytes, { headers: { ...CORS, 'Content-Type': isWav ? 'audio/wav' : 'audio/mpeg', 'Cache-Control': 'no-store' } })
      }
      // Voice in (fallback provider): raw audio bytes → Whisper on Workers AI (free binding).
      if (url.pathname === '/stt' && request.method === 'POST') {
        const buf = await request.arrayBuffer()
        if (!buf.byteLength) return json({ error: 'no audio' }, 400)
        if (buf.byteLength > 4 * 1024 * 1024) return json({ error: 'audio too large' }, 413)
        const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: bytesToBase64(buf) })
        return json({ text: String((out && out.text) || '').trim() })
      }
      // ── Noria accounts: email + one-time code (Noria's own identity, no SkyGlobe ID) ──
      if (url.pathname === '/auth/request' && request.method === 'POST') {
        let b; try { b = await request.json() } catch { return json({ error: 'bad request' }, 400) }
        const email = (b.email || '').trim().toLowerCase()
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Please enter a valid email.' }, 400)
        const eh = await sha256('noria-user:' + email)
        if (await env.SYNC.get('rl:' + eh)) return json({ error: 'Please wait a few seconds before requesting another code.' }, 429)
        const code = String(Math.floor(100000 + Math.random() * 900000))
        await env.SYNC.put('code:' + eh, JSON.stringify({ code, tries: 0 }), { expirationTtl: 600 })
        await env.SYNC.put('rl:' + eh, '1', { expirationTtl: 60 })
        const sent = await sendLoginEmail(env, email, code)
        return json({ ok: true, sent, ...(sent || env.DEV_MODE !== '1' ? {} : { devCode: code }) }) // the code is shown ONLY in local test mode, never in production
      }
      if (url.pathname === '/auth/verify' && request.method === 'POST') {
        let b; try { b = await request.json() } catch { return json({ error: 'bad request' }, 400) }
        const email = (b.email || '').trim().toLowerCase(), code = (b.code || '').trim()
        const eh = await sha256('noria-user:' + email)
        const rec = await env.SYNC.get('code:' + eh)
        if (!rec) return json({ error: 'That code expired — request a new one.' }, 400)
        const c = JSON.parse(rec)
        if (c.tries >= 5) { await env.SYNC.delete('code:' + eh); return json({ error: 'Too many attempts — request a new code.' }, 400) }
        if (c.code !== code) { c.tries++; await env.SYNC.put('code:' + eh, JSON.stringify(c), { expirationTtl: 600 }); return json({ error: 'Incorrect code.' }, 400) }
        await env.SYNC.delete('code:' + eh)
        const tok = [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, '0')).join('')
        await env.SYNC.put('sess:' + tok, JSON.stringify({ email, eh }), { expirationTtl: 60 * 60 * 24 * 60 })
        let ur = await env.SYNC.get('user:' + eh)
        if (!ur) { ur = JSON.stringify({ email, pro: false, created: Date.now() }); await env.SYNC.put('user:' + eh, ur) }
        return json({ ok: true, token: tok, email, pro: !!JSON.parse(ur).pro })
      }
      if (url.pathname === '/auth/me') {
        const t = url.searchParams.get('token') || ''
        const s = t && await env.SYNC.get('sess:' + t)
        if (!s) return json({ signedIn: false })
        const { email, eh } = JSON.parse(s)
        const ur = JSON.parse((await env.SYNC.get('user:' + eh)) || '{"pro":false}')
        return json({ signedIn: true, email, pro: !!ur.pro })
      }
      if (url.pathname === '/auth/logout' && request.method === 'POST') {
        let b; try { b = await request.json() } catch { b = {} }
        if (b.token) await env.SYNC.delete('sess:' + b.token)
        return json({ ok: true })
      }

      // Zero-knowledge sync: client derives `key` from its passphrase and encrypts
      // the data itself. We only store an opaque encrypted blob under that key.
      if (url.pathname === '/sync/get' && request.method === 'GET') {
        const key = (url.searchParams.get('key') || '').trim()
        if (!/^[a-f0-9]{64}$/.test(key)) return json({ error: 'bad key' }, 400)
        const v = await env.SYNC.get('u:' + key)
        return v ? new Response(v, { headers: { ...CORS, 'Content-Type': 'application/json' } }) : json({ found: false })
      }
      if (url.pathname === '/sync/put' && request.method === 'POST') {
        let body; try { body = await request.json() } catch { return json({ error: 'bad body' }, 400) }
        const key = (body.key || '').trim()
        if (!/^[a-f0-9]{64}$/.test(key)) return json({ error: 'bad key' }, 400)
        if (typeof body.blob !== 'string' || body.blob.length > 6000000) return json({ error: 'bad blob' }, 400)
        await env.SYNC.put('u:' + key, JSON.stringify({ blob: body.blob, iv: body.iv || '', salt: body.salt || '', ts: Date.now(), v: 1 }))
        return json({ ok: true })
      }
      // Noria Pro license check — stateless HMAC-signed codes (no database).
      // A small daily allowance per Pro code for costly features (deep research): GET /quota/take?kind=research&max=3&code=…
      if (url.pathname === '/quota/take') {
        const code = (url.searchParams.get('code') || '').trim().toUpperCase()
        if (!(await validCode(code, env.PRO_KEY, env.OWNER_KEY))) return json({ ok: false, error: 'pro' }, 402)
        const kind = (url.searchParams.get('kind') || '').replace(/[^a-z]/g, '').slice(0, 12) || 'x'
        const owner = isOwnerKey(code, env.OWNER_KEY)
        const max = Math.min(owner ? 20 : 5, Number(url.searchParams.get('max')) || 3)
        const key = 'quota:' + kind + ':' + utcDay() + ':' + (await shortHash(code))
        const used = Number(await env.SYNC.get(key)) || 0
        if (used >= max) return json({ ok: false, error: 'limit', left: 0 })
        if (url.searchParams.get('peek')) return json({ ok: true, left: max - used }) // just looking: nothing is counted
        await env.SYNC.put(key, String(used + 1), { expirationTtl: 172800 })
        return json({ ok: true, left: max - used - 1 })
      }
      if (url.pathname === '/pro/check') {
        const code = (url.searchParams.get('code') || '').trim().toUpperCase()
        return json({ pro: await validCode(code, env.PRO_KEY, env.OWNER_KEY) })
      }
      return new Response('Noria AI capability worker', { headers: CORS })
    } catch (e) {
      return json({ error: e && e.message ? e.message : String(e) }, 500)
    }
  },
  // Keep-warm: ping the Noria Body every 10 min so Render's free tier never
  // cold-starts (which is what made replies slow after idle).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetch('https://noria-body.onrender.com/brain/health').catch(() => {}))
    // Once an hour: forget expired sessions and old rate-limit rows, so the database only holds what is in use.
    if (env.DB && new Date(event.scheduledTime).getUTCMinutes() < 10) {
      const t = Math.floor(Date.now() / 1000)
      ctx.waitUntil(env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
        env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(t - 3600),
        env.DB.prepare('DELETE FROM reset_tokens WHERE expires_at < ?').bind(t),
      ]).catch(() => {}))
    }
  },
}

function bytesToBase64(buf) {
  const b = new Uint8Array(buf); let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000))
  return btoa(s)
}

// ── Free-tier image budget ─────────────────────────────────────────────────────────────────────────────────────────
// Cloudflare's free AI allowance is 10,000 "neurons" a day for everything (images, photo reading, fallbacks). Images differ
// hugely in cost, so each is priced (an ESTIMATE, adjustable with IMAGE_COSTS = {"model-name": neurons}), a daily image
// budget is kept in KV (IMAGE_DAILY_BUDGET, default 6000 — the rest stays free for other features), and each request uses
// the best model that still fits what is left, sliding down to a cheaper one instead of failing. A per-account daily cap
// (IMAGE_PER_USER, default 12) stops one person using it all. When the day's budget is gone, people are told so plainly.
const IMAGE_COST = { 'flux-2-klein-9b': 1500, 'lucid-origin': 2500, 'phoenix-1.0': 2100, 'flux-1-schnell': 150, 'stable-diffusion-xl-base-1.0': 300 }
const shortModel = (m) => String(m).split('/').pop()
function imageCost(env, model) {
  let table = IMAGE_COST
  try { if (env.IMAGE_COSTS) table = Object.assign({}, IMAGE_COST, JSON.parse(env.IMAGE_COSTS)) } catch (_) {}
  return Number(table[shortModel(model)]) || 800
}
const utcDay = () => new Date().toISOString().slice(0, 10)
async function shortHash(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('')
}
async function imageLedger(env, code) {
  const day = utcDay(), uid = await shortHash(String(code || 'anon'))
  const spentKey = 'imgspent2:' + day, userKey = 'imguser:' + day + ':' + uid
  const [spent, used] = await Promise.all([env.SYNC.get(spentKey), env.SYNC.get(userKey)])
  return { spentKey, userKey, spent: Number(spent) || 0, used: Number(used) || 0,
    budget: Number(env.IMAGE_DAILY_BUDGET) || 6000, perUser: Number(env.IMAGE_PER_USER) || 12 }
}
async function imageCharge(env, led, cost) {
  await Promise.all([env.SYNC.put(led.spentKey, String(led.spent + cost), { expirationTtl: 172800 }), env.SYNC.put(led.userKey, String(led.used + 1), { expirationTtl: 172800 })])
}
const isAllowanceError = (e) => /4006|daily free allocation|neurons/i.test(String((e && e.message) || e));
async function markAllowanceGone(env, led) { // Cloudflare says today's allowance is gone: stop calling it until tomorrow
  try { await env.SYNC.put('imgblock', '1', { expirationTtl: 1800 }) } catch (_) {} // try again in half an hour: the moment Cloudflare's allowance returns is not known
  return json({ error: 'image_budget', message: 'Noria has used today\'s free image allowance. It resets at midnight UTC.' }, 429)
}
// Input for an image model: most take { prompt, steps }; the FLUX.2 family takes a multipart form (1024 x 1024).
function imageInput(model, prompt) {
  if (/flux-2/i.test(model)) {
    const form = new FormData()
    form.append('prompt', prompt); form.append('width', '1024'); form.append('height', '1024')
    const fr = new Response(form)
    return { multipart: { body: fr.body, contentType: fr.headers.get('content-type') } }
  }
  if (/leonardo/i.test(model)) return { prompt, width: 1024, height: 1024 }
  return { prompt, steps: 8 }
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// Stateless Noria Pro codes: NORIA-<BODY>-<6-char HMAC prefix>. Valid iff the
// prefix matches HMAC-SHA256(PRO_KEY, "NORIA-<BODY>"). Generate offline with the
// same key; validate here without any database.
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
}
// Sends the Noria sign-in code via the configured email provider (Resend or Brevo).
// Returns false when no provider is configured yet (test mode → code returned in the API).
async function sendLoginEmail(env, to, code) {
  const from = env.MAIL_FROM || 'Noria <noria@skyglobegroup.com>'
  const subject = 'Your Noria sign-in code'
  const text = `Your Noria sign-in code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#1A1712">
    <div style="font-weight:700;font-size:20px;margin-bottom:14px">✦ Noria</div>
    <p style="margin:0 0 8px;color:#7A7264">Your sign-in code:</p>
    <div style="font-size:30px;font-weight:800;letter-spacing:6px;color:#0B1F3A">${code}</div>
    <p style="margin:16px 0 0;color:#A79E8D;font-size:13px">It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
  </div>`
  try {
    if (env.RESEND_KEY) {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to, subject, text, html }) })
      return r.ok
    }
    if (env.BREVO_KEY) {
      const m = from.match(/^(.*)<(.+)>$/)
      const sender = m ? { name: m[1].trim() || 'Noria', email: m[2].trim() } : { name: 'Noria', email: from }
      const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': env.BREVO_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text, htmlContent: html }) })
      return r.ok
    }
  } catch {}
  return false
}
async function hmacHex(key, msg) {
  const enc = new TextEncoder()
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
// The owner's own key (a secret set with `wrangler secret put OWNER_KEY`, at least 8 characters) unlocks Pro as well.
// Compared without an early exit, and matched case-insensitively because the app upper-cases every code it sends.
function isOwnerKey(code, owner) {
  const o = String(owner || '').trim().toUpperCase(), c = String(code || '').trim().toUpperCase()
  if (o.length < 8 || c.length !== o.length) return false
  let d = 0; for (let i = 0; i < o.length; i++) d |= o.charCodeAt(i) ^ c.charCodeAt(i)
  return d === 0
}
async function validCode(code, key, owner) {
  if (isOwnerKey(code, owner)) return true
  if (!key) return false
  const m = code.match(/^NORIA-([A-Z0-9]{4,16})-([A-F0-9]{6})$/)
  if (!m) return false
  const sig = await hmacHex(key, 'NORIA-' + m[1])
  return sig.slice(0, 6).toUpperCase() === m[2]
}
