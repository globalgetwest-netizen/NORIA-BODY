/**
 * NORIA ACCOUNTS — people, profiles, preferences and saved conversations, kept in Cloudflare D1 (SQLite at the edge).
 *
 * Free-tier aware: D1's free plan is 5 GB of storage, 100,000 rows written and 5,000,000 rows read per day. Every write
 * path here is one or two rows, saves are last-write-wins upserts, and each account has caps (conversations, size) so one
 * person cannot use the shared allowance. Nothing here needs a paid plan.
 *
 * Security:
 *  - Passwords are never stored: PBKDF2-HMAC-SHA512 with a random 16-byte salt per person, the iteration count kept inside
 *    the stored string so it can be raised later without breaking anyone's login. (Workers allow at most 100,000 iterations.)
 *  - Login always does the full hash work, even for an address that has no account, so timing does not reveal who is registered.
 *  - Sign-in attempts are counted per address and per network address (in D1), and locked for 15 minutes after too many failures.
 *  - Session tokens are 256-bit random values; only their SHA-256 is stored, so a leaked database gives no working session.
 *  - Saved conversations belong to the signed-in account and are kept on the server, so they are there on every device and after a
 *    password reset (they are not tied to the password). Only the owner's session can read them; the owner can export or erase them.
 *  - Password reset: an emailed link with a 256-bit token, stored only as a hash, valid 30 minutes, usable once; using it signs every
 *    device out. Asking for a link never reveals whether an address has an account.
 */
const ITER_DEFAULT = 100000 // the most Workers allow for PBKDF2
const SESSION_DAYS = 30
const MAX_CONVOS = 500, MAX_PAYLOAD = 250 * 1024, MAX_USER_BYTES = 10 * 1024 * 1024, MAX_PREFS = 8 * 1024
const RESET_MINUTES = 30
const COMMON = new Set(['password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop', 'iloveyou12', 'abcdefghij', '0123456789', 'letmein123', 'welcome123', 'admin12345', 'noria12345'])

// ── small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
const enc = new TextEncoder()
const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const unb64 = (str) => { const p = str.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4)); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u }
const now = () => Math.floor(Date.now() / 1000)
const sha256b64 = async (t) => b64(await crypto.subtle.digest('SHA-256', enc.encode(t)))
function safeEqual(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0 }

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: iter }, key, 512))
}
export async function hashPassword(password, iter = ITER_DEFAULT) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return 'pbkdf2-sha512$' + iter + '$' + b64(salt) + '$' + b64(await pbkdf2(password, salt, iter))
}
export async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || '').split('$')
  if (alg !== 'pbkdf2-sha512' || !iter || !salt || !hash) return false
  return safeEqual(await pbkdf2(password, unb64(salt), Number(iter)), unb64(hash))
}
let _dummy = null // hashed once per isolate so a missing account costs the same time as a real one
async function dummyVerify(password) { if (!_dummy) _dummy = await hashPassword('noria-timing-guard', ITER_DEFAULT); await verifyPassword(password, _dummy) }

const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)
function passwordProblem(p) {
  if (typeof p !== 'string' || p.length < 10) return 'Use at least 10 characters — a short phrase of a few words works well.'
  if (p.length > 128) return 'That password is too long (128 characters at most).'
  if (COMMON.has(p.toLowerCase()) || /^(.)\1+$/.test(p)) return 'That password is too easy to guess. Try a short phrase of a few unrelated words.'
  return ''
}
const clientIp = (request) => request.headers.get('CF-Connecting-IP') || 'unknown'

// ── email (Resend or Brevo — whichever key is set as a secret; both have free plans) ───────────────────────────────
async function sendEmail(env, to, subject, text, html) {
  const from = env.MAIL_FROM || 'Noria <noria@skyglobegroup.com>'
  try {
    if (env.RESEND_KEY) {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject, text, html }) })
      return r.ok
    }
    if (env.BREVO_KEY) {
      const m = from.match(/^(.*)<(.+)>$/)
      const sender = m ? { name: m[1].trim() || 'Noria', email: m[2].trim() } : { name: 'Noria', email: from }
      const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': env.BREVO_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text, htmlContent: html }) })
      return r.ok
    }
  } catch (_) {}
  return false
}
const mailShell = (inner) => `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:460px;margin:0 auto;padding:24px;color:#1A1712"><div style="font-weight:700;font-size:20px;margin-bottom:14px">✦ Noria</div>${inner}</div>`

// ── rate limiting in D1 (fixed 15-minute windows) ──────────────────────────────────────────────────────────────────
const WINDOW = 15 * 60
async function limited(env, key, max) {
  const r = await env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE k = ?').bind(key).first()
  return !!r && now() - r.window_start < WINDOW && r.count >= max
}
async function hit(env, key) {
  const t = now()
  await env.DB.prepare('INSERT INTO rate_limits (k, count, window_start) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET count = CASE WHEN ? - window_start >= ? THEN 1 ELSE count + 1 END, window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END')
    .bind(key, t, t, WINDOW, t, WINDOW, t).run()
}
const clearHits = (env, key) => env.DB.prepare('DELETE FROM rate_limits WHERE k = ?').bind(key).run()

// ── sessions ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function newSession(env, userId, request) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32)))
  const t = now()
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, agent) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await sha256b64(token), userId, t, t + SESSION_DAYS * 86400, t, (request.headers.get('User-Agent') || '').slice(0, 120)).run()
  return token
}
async function authed(request, env) {
  const h = request.headers.get('Authorization') || ''
  const m = /^Bearer\s+([A-Za-z0-9_-]{40,60})$/.exec(h)
  if (!m) return null
  const th = await sha256b64(m[1])
  const s = await env.DB.prepare('SELECT s.user_id AS uid, s.expires_at AS exp, s.last_seen AS seen, u.email AS email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?').bind(th).first()
  if (!s || s.exp < now()) return null
  if (now() - s.seen > 3600) await env.DB.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?').bind(now(), th).run() // at most one write an hour
  return { userId: s.uid, email: s.email, tokenHash: th }
}

async function userView(env, userId) {
  const u = await env.DB.prepare('SELECT u.id AS id, u.email AS email, u.created_at AS created_at, p.display_name AS name, p.tz AS tz, p.lang AS lang, p.prefs AS prefs FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = ?').bind(userId).first()
  if (!u) return null
  let prefs = {}; try { prefs = JSON.parse(u.prefs || '{}') } catch (_) {}
  return { id: u.id, email: u.email, name: u.name || '', tz: u.tz || '', lang: u.lang || '', prefs, created_at: u.created_at }
}

// ── the routes ─────────────────────────────────────────────────────────────────────────────────────────────────────
export async function handleAccounts(request, env, url, json, ctx) {
  const path = url.pathname
  if (!path.startsWith('/acct/')) return null
  if (!env.DB) return json({ error: 'Accounts are not switched on yet.' }, 503)
  let body = {}
  if (request.method === 'POST') { try { body = await request.json() } catch (_) { return json({ error: 'Bad request.' }, 400) } }

  // create an account
  if (path === '/acct/register' && request.method === 'POST') {
    const email = String(body.email || '').trim().toLowerCase()
    if (!validEmail(email)) return json({ error: 'Please enter a valid email address.' }, 400)
    const problem = passwordProblem(body.password); if (problem) return json({ error: problem }, 400)
    const ipKey = 'reg:ip:' + await sha256b64(clientIp(request))
    if (await limited(env, ipKey, 10)) return json({ error: 'Too many new accounts from this network. Please try again later.' }, 429)
    await hit(env, ipKey)
    if (await env.DB.prepare('SELECT 1 AS x FROM users WHERE email = ?').bind(email).first()) return json({ error: 'An account with this email already exists. Try signing in.' }, 409)
    const id = crypto.randomUUID(), t = now(), pw = await hashPassword(body.password, Number(env.PBKDF2_ITER) || ITER_DEFAULT)
    const name = String(body.name || '').trim().slice(0, 60)
    await env.DB.batch([
      env.DB.prepare('INSERT INTO users (id, email, pw_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').bind(id, email, pw, t, t),
      env.DB.prepare('INSERT INTO profiles (user_id, display_name, tz, lang, prefs, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, name, String(body.tz || '').slice(0, 60), String(body.lang || '').slice(0, 20), '{}', t),
    ])
    return json({ ok: true, token: await newSession(env, id, request), user: await userView(env, id) })
  }

  // sign in
  if (path === '/acct/login' && request.method === 'POST') {
    const email = String(body.email || '').trim().toLowerCase(), password = String(body.password || '')
    if (!validEmail(email) || !password) return json({ error: 'Email or password is not right.' }, 401)
    const eKey = 'login:e:' + await sha256b64(email), iKey = 'login:ip:' + await sha256b64(clientIp(request))
    if ((await limited(env, eKey, 8)) || (await limited(env, iKey, 40))) return json({ error: 'Too many attempts. Please wait 15 minutes and try again.' }, 429)
    const u = await env.DB.prepare('SELECT id, pw_hash FROM users WHERE email = ?').bind(email).first()
    const ok = u ? await verifyPassword(password, u.pw_hash) : (await dummyVerify(password), false)
    if (!ok) { await Promise.all([hit(env, eKey), hit(env, iKey)]); return json({ error: 'Email or password is not right.' }, 401) }
    await clearHits(env, eKey)
    return json({ ok: true, token: await newSession(env, u.id, request), user: await userView(env, u.id) })
  }

  // forgotten password: ask for a link, then choose a new password with it
  if (path === '/acct/reset/request' && request.method === 'POST') {
    const said = { ok: true, message: 'If there is an account for that email, we have sent a link to reset the password. It works for ' + RESET_MINUTES + ' minutes.' }
    const email = String(body.email || '').trim().toLowerCase()
    if (!validEmail(email)) return json(said) // the answer never depends on whether the address has an account
    const ipKey = 'reset:ip:' + await sha256b64(clientIp(request)), eKey = 'reset:e:' + await sha256b64(email)
    if (await limited(env, ipKey, 8)) return json({ error: 'Too many requests. Please try again later.' }, 429)
    await hit(env, ipKey)
    if (await limited(env, eKey, 3)) return json(said) // at most three emails per address per 15 minutes; silently
    await hit(env, eKey)
    const u = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
    if (!u) return json(said)
    const token = b64(crypto.getRandomValues(new Uint8Array(32))), t = now()
    await env.DB.batch([
      env.DB.prepare('DELETE FROM reset_tokens WHERE user_id = ?').bind(u.id), // a new request cancels older links
      env.DB.prepare('INSERT INTO reset_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256b64(token), u.id, t, t + RESET_MINUTES * 60),
    ])
    const link = (env.APP_URL || 'https://noria.africa') + '/?reset=' + token
    const text = 'Someone asked to reset the password for your Noria account. To choose a new password, open this link within ' + RESET_MINUTES + ' minutes:\n\n' + link + '\n\nIf you did not ask for this, ignore this email — your password stays as it is.'
    const html = mailShell('<p style="margin:0 0 14px">Someone asked to reset the password for your Noria account.</p><p style="margin:0 0 18px"><a href="' + link + '" style="background:#0B1F3A;color:#fff;text-decoration:none;padding:12px 20px;border-radius:9px;display:inline-block;font-weight:600">Choose a new password</a></p><p style="margin:0;color:#7A7264;font-size:13px">The link works once, for ' + RESET_MINUTES + ' minutes. If you did not ask for this, ignore this email — your password stays as it is.</p>')
    const send = sendEmail(env, email, 'Reset your Noria password', text, html) // sent in the background so the reply takes the same time either way
    if (ctx && ctx.waitUntil) ctx.waitUntil(send); else await send
    return json(env.DEV_MODE === '1' ? Object.assign({ devToken: token }, said) : said) // the token is returned ONLY in local test mode
  }
  if (path === '/acct/reset/confirm' && request.method === 'POST') {
    const token = String(body.token || '')
    const problem = passwordProblem(body.password); if (problem) return json({ error: problem }, 400)
    const ipKey = 'resetc:ip:' + await sha256b64(clientIp(request))
    if (await limited(env, ipKey, 10)) return json({ error: 'Too many attempts. Please try again later.' }, 429)
    await hit(env, ipKey)
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return json({ error: 'This reset link is not valid. Please ask for a new one.' }, 400)
    const row = await env.DB.prepare('SELECT r.user_id AS uid, r.expires_at AS exp, u.email AS email FROM reset_tokens r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?').bind(await sha256b64(token)).first()
    if (!row || row.exp < now()) return json({ error: 'This reset link has expired or was already used. Please ask for a new one.' }, 400)
    const pw = await hashPassword(body.password, Number(env.PBKDF2_ITER) || ITER_DEFAULT)
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pw_hash = ?, updated_at = ? WHERE id = ?').bind(pw, now(), row.uid),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(row.uid),        // every device is signed out
      env.DB.prepare('DELETE FROM reset_tokens WHERE user_id = ?').bind(row.uid),    // the link (and any other) is used up
      env.DB.prepare('DELETE FROM rate_limits WHERE k = ?').bind('login:e:' + await sha256b64(row.email)), // a lock from earlier wrong tries no longer applies
    ])
    const note = sendEmail(env, row.email, 'Your Noria password was changed', 'The password for your Noria account was just changed. If this was not you, reset it again straight away and contact us.', mailShell('<p style="margin:0">The password for your Noria account was just changed.</p><p style="margin:12px 0 0;color:#7A7264;font-size:13px">If this was not you, reset it again straight away.</p>'))
    if (ctx && ctx.waitUntil) ctx.waitUntil(note); else await note
    return json({ ok: true })
  }

  // everything below needs a valid session
  const me = await authed(request, env)
  if (!me) return json({ error: 'Please sign in.' }, 401)

  if (path === '/acct/me' && request.method === 'GET') return json({ ok: true, user: await userView(env, me.userId) })

  if (path === '/acct/logout' && request.method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(me.tokenHash).run()
    return json({ ok: true })
  }

  if (path === '/acct/profile' && request.method === 'POST') {
    await env.DB.prepare('UPDATE profiles SET display_name = ?, tz = ?, lang = ?, updated_at = ? WHERE user_id = ?')
      .bind(String(body.name || '').trim().slice(0, 60), String(body.tz || '').slice(0, 60), String(body.lang || '').slice(0, 20), now(), me.userId).run()
    return json({ ok: true, user: await userView(env, me.userId) })
  }

  if (path === '/acct/prefs' && request.method === 'POST') {
    const text = JSON.stringify(body.prefs && typeof body.prefs === 'object' ? body.prefs : {})
    if (text.length > MAX_PREFS) return json({ error: 'Preferences are too large.' }, 413)
    await env.DB.prepare('UPDATE profiles SET prefs = ?, updated_at = ? WHERE user_id = ?').bind(text, now(), me.userId).run()
    return json({ ok: true })
  }

  if (path === '/acct/password' && request.method === 'POST') {
    const u = await env.DB.prepare('SELECT pw_hash FROM users WHERE id = ?').bind(me.userId).first()
    if (!u || !(await verifyPassword(String(body.current || ''), u.pw_hash))) return json({ error: 'Your current password is not right.' }, 403)
    const problem = passwordProblem(body.next); if (problem) return json({ error: problem }, 400)
    const pw = await hashPassword(body.next, Number(env.PBKDF2_ITER) || ITER_DEFAULT)
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pw_hash = ?, updated_at = ? WHERE id = ?').bind(pw, now(), me.userId),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(me.userId, me.tokenHash), // every other device signs out
    ])
    return json({ ok: true })
  }

  // saved conversations: list (light), read, save (last write wins), delete
  if (path === '/acct/convos' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT id, title, updated_at, encrypted, length(payload) AS bytes FROM convos WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500').bind(me.userId).all()
    return json({ ok: true, convos: rows.results || [] })
  }
  if (path === '/acct/convos/get' && request.method === 'GET') {
    const id = url.searchParams.get('id') || ''
    const c = await env.DB.prepare('SELECT id, title, payload, updated_at, encrypted FROM convos WHERE user_id = ? AND id = ?').bind(me.userId, id).first()
    return c ? json({ ok: true, convo: c }) : json({ error: 'Not found.' }, 404)
  }
  if (path === '/acct/convos/put' && request.method === 'POST') {
    const id = String(body.id || ''), payload = typeof body.payload === 'string' ? body.payload : ''
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id) || !payload) return json({ error: 'A conversation needs an id and content.' }, 400)
    if (payload.length > MAX_PAYLOAD) return json({ error: 'That conversation is too large to save (250 KB at most).' }, 413)
    const t = Number(body.updated_at) || now()
    const stat = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(payload)), 0) AS bytes, COALESCE(SUM(CASE WHEN id = ? THEN 1 ELSE 0 END), 0) AS mine FROM convos WHERE user_id = ?').bind(id, me.userId).first()
    if (!stat.mine && stat.n >= MAX_CONVOS) return json({ error: 'You have reached the limit of ' + MAX_CONVOS + ' saved conversations. Delete some to save new ones.' }, 409)
    if (stat.bytes + payload.length > MAX_USER_BYTES + (stat.mine ? MAX_PAYLOAD : 0)) return json({ error: 'Your saved conversations have reached the storage limit.' }, 413)
    const res = await env.DB.prepare('INSERT INTO convos (user_id, id, title, payload, updated_at, encrypted) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, id) DO UPDATE SET title = excluded.title, payload = excluded.payload, updated_at = excluded.updated_at, encrypted = excluded.encrypted WHERE excluded.updated_at >= convos.updated_at')
      .bind(me.userId, id, String(body.title || '').slice(0, 120), payload, t, body.encrypted ? 1 : 0).run()
    return json({ ok: true, saved: (res.meta && res.meta.changes) > 0 })
  }
  if (path === '/acct/convos/delete' && request.method === 'POST') {
    await env.DB.prepare('DELETE FROM convos WHERE user_id = ? AND id = ?').bind(me.userId, String(body.id || '')).run()
    return json({ ok: true })
  }

  // a full copy of everything held about the person, and a full erase
  if (path === '/acct/export' && request.method === 'GET') {
    const [user, convos, sessions] = await Promise.all([
      userView(env, me.userId),
      env.DB.prepare('SELECT id, title, payload, updated_at, encrypted FROM convos WHERE user_id = ?').bind(me.userId).all(),
      env.DB.prepare('SELECT created_at, expires_at, last_seen, agent FROM sessions WHERE user_id = ?').bind(me.userId).all(),
    ])
    return json({ ok: true, exported_at: now(), user, convos: convos.results || [], sessions: sessions.results || [] })
  }
  if (path === '/acct/delete' && request.method === 'POST') {
    const u = await env.DB.prepare('SELECT pw_hash FROM users WHERE id = ?').bind(me.userId).first()
    if (!u || !(await verifyPassword(String(body.password || ''), u.pw_hash))) return json({ error: 'Your password is not right.' }, 403)
    await env.DB.batch([
      env.DB.prepare('DELETE FROM convos WHERE user_id = ?').bind(me.userId),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(me.userId),
      env.DB.prepare('DELETE FROM profiles WHERE user_id = ?').bind(me.userId),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(me.userId),
    ])
    return json({ ok: true })
  }
  return json({ error: 'Not found.' }, 404)
}
