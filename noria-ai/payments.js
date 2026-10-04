// NORIA AGENT (BUSINESS) — the real, billed, $1000/month subscription, via Paystack.
//
// This is a SEPARATE product from "Noria Pro" ($35/month): Pro is unlocked today by a stateless,
// never-expiring access code (worker.js validCode/isOwnerKey — no database row, no billing). A real
// recurring subscription needs actual state, because its status changes over time (a card can fail, a
// subscription can renew or be cancelled) in a way a one-time code never has to represent — see
// schema-subscriptions.sql for the `subscriptions` table this writes to.
//
// Secrets this needs (set with `wrangler secret put <NAME>` from this noria-ai directory — the value is
// never pasted into chat, never seen by the assistant that wrote this file):
//   PAYSTACK_SECRET_KEY   the secret key from the Paystack dashboard (Settings -> API Keys & Webhooks).
//                         Use the TEST key while verifying this end to end; switch to LIVE only when ready
//                         for real customers.
//   PAYSTACK_PLAN_CODE    the plan code for the $1000/month plan. Created ONCE, by the owner, either in
//                         the Paystack dashboard (Billing -> Plans -> Create Plan) or via their own API
//                         call with their own secret key — never by this code, which only ever
//                         REFERENCES a plan that already exists. Paystack bills in the account's
//                         configured settlement currency: pick whichever currency the account supports
//                         and set the plan amount to its equivalent of $1000, since this file does not
//                         assume USD is available.
//
// Flow:
//   1. POST /pay/initialize {email} — calls Paystack's own /transaction/initialize with the plan code;
//      returns {authorization_url}. The browser is redirected there; Noria never collects or sees a
//      card number at any point — Paystack's own hosted page does that.
//   2. GET /pay/callback?reference=... — Paystack redirects the browser back here after checkout. The
//      transaction is verified SERVER-SIDE via /transaction/verify/:reference (the reference alone,
//      taken from a redirect, is never trusted on its own) before the subscription is marked active.
//   3. POST /pay/webhook — every later lifecycle event (renewal, a failed charge, cancellation) arrives
//      here. The request is signature-checked (HMAC-SHA512 of the exact raw body, same secret key,
//      compared to the x-paystack-signature header) BEFORE anything in it is read or trusted — an
//      unsigned or mismatched body is rejected outright, the same "never act on an unverified claim"
//      discipline the rest of this codebase holds every other input to.
//   4. GET /pay/status?email=... — lets the app check whether an email currently has an active
//      subscription, to gate the Agent tier's features.
//
// HONESTY NOTE for whoever wires this up: Paystack's exact webhook event names and payload shapes
// (charge.success, subscription.create, subscription.disable, subscription.not_renew,
// invoice.payment_failed, and the exact fields on each) are implemented here from general knowledge of
// their API, not from a live-verified call — verify each one against a real test-mode webhook delivery
// (Paystack's dashboard can replay a sample event) before relying on this in production, the same way
// every other external-data claim in this project gets verified live before being trusted.

const PAYSTACK_API = 'https://api.paystack.co'
const now = () => Math.floor(Date.now() / 1000)
const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)

async function hmacSha512Hex(key, msg) {
  const enc = new TextEncoder()
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(msg))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
// Timing-safe comparison of two equal-length hex strings (a webhook signature check must never
// short-circuit on the first mismatched character, the same reasoning as a password comparison).
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

async function paystack(env, path, opts = {}) {
  let r, d
  try {
    r = await fetch(PAYSTACK_API + path, {
      method: opts.method || 'GET',
      // .trim(): found live — "Format is Authorization Bearer [secret key]" from Paystack points to a
      // stray whitespace/newline character in the stored secret (an easy slip when pasting into an
      // interactive `wrangler secret put` prompt). Trimming is ordinary input hygiene, not a security
      // change — it does not alter what key is accepted, only strips accidental surrounding whitespace.
      headers: Object.assign({ Authorization: 'Bearer ' + String(env.PAYSTACK_SECRET_KEY || '').trim(), 'Content-Type': 'application/json' }, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
    d = await r.json()
  } catch (e) { return { ok: false, status: 0, data: { message: String((e && e.message) || e) } } }
  return { ok: r.ok && d && d.status !== false, status: r.status, data: d || {} }
}

// Reads the existing row (if any) and merges `patch` on top of it before writing, so a PARTIAL update
// (a webhook that only ever reports a status change) never blanks out fields it was not told about.
async function upsertSubscription(env, email, patch) {
  const t = now()
  const existing = await env.DB.prepare('SELECT * FROM subscriptions WHERE email = ?').bind(email).first()
  const base = existing || { plan: 'noria_agent_business_monthly', status: 'pending', paystack_customer_code: '', paystack_subscription_code: '', paystack_email_token: '', last_reference: '', current_period_end: 0, created_at: t }
  const m = Object.assign({}, base, patch)
  await env.DB.prepare(
    `INSERT INTO subscriptions (email, plan, status, paystack_customer_code, paystack_subscription_code, paystack_email_token, last_reference, current_period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET plan = excluded.plan, status = excluded.status, paystack_customer_code = excluded.paystack_customer_code,
       paystack_subscription_code = excluded.paystack_subscription_code, paystack_email_token = excluded.paystack_email_token,
       last_reference = excluded.last_reference, current_period_end = excluded.current_period_end, updated_at = excluded.updated_at`
  ).bind(email, m.plan, m.status, m.paystack_customer_code, m.paystack_subscription_code, m.paystack_email_token, m.last_reference, m.current_period_end, base.created_at, t).run()
}
async function logEvent(env, email, event, reference, payload) {
  try {
    const text = JSON.stringify(payload)
    await env.DB.prepare('INSERT INTO payment_events (email, event, reference, payload, received_at) VALUES (?, ?, ?, ?, ?)')
      .bind(email || '', event, reference || '', text.slice(0, 20000), now()).run()
  } catch (_) { /* the event itself still gets acted on even if the audit write fails */ }
}

export async function handlePayments(request, env, url, json) {
  const path = url.pathname
  if (!path.startsWith('/pay/')) return null
  if (!env.DB) return json({ error: 'Subscriptions are not switched on yet.' }, 503)
  if (!env.PAYSTACK_SECRET_KEY) return json({ error: 'Payments are not configured yet.' }, 503)

  if (path === '/pay/initialize' && request.method === 'POST') {
    let body = {}; try { body = await request.json() } catch (_) {}
    const email = String((body && body.email) || '').trim().toLowerCase()
    if (!validEmail(email)) return json({ error: 'A valid email is required.' }, 400)
    if (!env.PAYSTACK_PLAN_CODE) return json({ error: 'The Agent plan is not set up yet.' }, 503)
    // BUG FOUND live (2026-10-04) setting this up: /pay/callback is a route on THIS worker
    // (noria-ai), not on noria.africa (the separate main site) - env.APP_URL's default was pointing
    // Paystack's post-checkout redirect at the wrong domain entirely. url.origin is always correct
    // regardless of where this worker is deployed or renamed, so it replaces the env-var default here.
    const callback_url = url.origin + '/pay/callback'
    const r = await paystack(env, '/transaction/initialize', { method: 'POST', body: { email, plan: env.PAYSTACK_PLAN_CODE, callback_url } })
    if (!r.ok || !r.data.data) return json({ error: 'Could not start checkout right now. Please try again.', detail: env.DEV_MODE === '1' ? r.data.message : undefined }, 502)
    await upsertSubscription(env, email, { status: 'pending', last_reference: r.data.data.reference })
    return json({ ok: true, authorization_url: r.data.data.authorization_url, reference: r.data.data.reference })
  }

  if (path === '/pay/callback' && request.method === 'GET') {
    const reference = url.searchParams.get('reference') || ''
    const appUrl = env.APP_URL || 'https://noria.africa'
    if (!reference) return Response.redirect(appUrl + '/workspace.html?agent=error', 302)
    // The reference is only ever a lookup key here — what it means is decided by asking Paystack
    // directly (server-side), never by trusting the redirect's own query string on its own.
    const r = await paystack(env, '/transaction/verify/' + encodeURIComponent(reference))
    const d = r.data && r.data.data
    if (!r.ok || !d || d.status !== 'success') return Response.redirect(appUrl + '/workspace.html?agent=failed', 302)
    const email = String((d.customer && d.customer.email) || '').trim().toLowerCase()
    await upsertSubscription(env, email, {
      status: 'active',
      paystack_customer_code: (d.customer && d.customer.customer_code) || '',
      paystack_subscription_code: (d.plan_object && d.plan_object.plan_code) || env.PAYSTACK_PLAN_CODE || '',
      last_reference: reference,
    })
    await logEvent(env, email, 'checkout_verified', reference, d)
    return Response.redirect(appUrl + '/workspace.html?agent=active', 302)
  }

  if (path === '/pay/webhook' && request.method === 'POST') {
    const raw = await request.text()
    const sig = request.headers.get('x-paystack-signature') || ''
    const expected = await hmacSha512Hex(env.PAYSTACK_SECRET_KEY, raw)
    if (!sig || !safeEqualHex(sig, expected)) return json({ error: 'invalid signature' }, 401) // an unverified body is never read, let alone acted on
    let evt; try { evt = JSON.parse(raw) } catch (_) { return json({ error: 'bad payload' }, 400) }
    const d = evt.data || {}, email = String((d.customer && d.customer.email) || d.email || '').trim().toLowerCase()
    await logEvent(env, email, evt.event || 'unknown', d.reference || '', evt)
    if (evt.event === 'charge.success' || evt.event === 'subscription.create') {
      await upsertSubscription(env, email, { status: 'active', paystack_subscription_code: d.subscription_code || (d.plan && d.plan.plan_code) || '' })
    } else if (evt.event === 'subscription.disable' || evt.event === 'subscription.not_renew') {
      await upsertSubscription(env, email, { status: 'cancelled' })
    } else if (evt.event === 'invoice.payment_failed') {
      await upsertSubscription(env, email, { status: 'past_due' })
    }
    return json({ ok: true })
  }

  if (path === '/pay/status' && request.method === 'GET') {
    const email = String(url.searchParams.get('email') || '').trim().toLowerCase()
    if (!validEmail(email)) return json({ active: false, status: 'none' })
    const row = await env.DB.prepare('SELECT status FROM subscriptions WHERE email = ?').bind(email).first()
    return json({ active: !!row && row.status === 'active', status: row ? row.status : 'none' })
  }

  // TEMPORARY DIAGNOSTIC — only live when DEV_MODE=1 is explicitly set (already true, per the earlier
  // debugging step). Reveals ONLY metadata about the stored secret (length, whether it carries stray
  // whitespace/quotes/the literal word "Bearer", its first 8 characters — the public "sk_test_"/
  // "sk_live_" marker every Paystack key starts with, not sensitive on its own) — never the key value
  // itself or any portion of its actual secret portion. Built specifically to diagnose a live, repeated
  // "Format is Authorization Bearer [secret key]" rejection without ever asking for or seeing the real
  // key. Remove this route once the real root cause is confirmed and fixed.
  if (path === '/pay/debug-key' && env.DEV_MODE === '1') {
    const raw = String(env.PAYSTACK_SECRET_KEY || '')
    return json({
      length: raw.length,
      trimmedLength: raw.trim().length,
      first8: raw.slice(0, 8),
      startsWithSk: /^sk_(test|live)_/.test(raw.trim()),
      containsBearerWord: /bearer/i.test(raw),
      containsWhitespaceInside: /\s/.test(raw.trim()),
      containsQuotes: /["'`]/.test(raw),
      containsNewline: /[\r\n]/.test(raw),
      planCodeLength: String(env.PAYSTACK_PLAN_CODE || '').length,
      planCodeFirst4: String(env.PAYSTACK_PLAN_CODE || '').slice(0, 4),
    })
  }

  return json({ error: 'Not found.' }, 404)
}
