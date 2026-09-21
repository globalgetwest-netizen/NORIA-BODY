/**
 * NORIA ACCOUNT — sign in, create an account, reset a forgotten password, and keep conversations in the account so they are
 * there on every device. Talks to the accounts service (/acct/…) on the noria-ai worker.
 *
 * Signed out, everything stays on this device exactly as before. Signed in, each conversation is also saved to the account
 * (a short pause after it changes) and the list is merged with the account whenever the app opens or "Sync now" is pressed.
 * The newest copy of a conversation wins; a conversation deleted on one device is removed from the others.
 */
const K = { token: 'noria.acct.token', user: 'noria.acct.user', synced: 'noria.acct.synced', pend: 'noria.acct.pending', last: 'noria.acct.last' }
const rd = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v } catch { return d } }
const wr = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }
const del = (k) => { try { localStorage.removeItem(k) } catch {} }
const base = () => { try { return localStorage.getItem('noria.acct.base') || 'https://noria-ai.insights-skyglobe.workers.dev' } catch { return 'https://noria-ai.insights-skyglobe.workers.dev' } }
const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const token = () => { try { return localStorage.getItem(K.token) || '' } catch { return '' } }
const user = () => rd(K.user, null)

async function api(method, path, body) {
  const t = token()
  let res
  try {
    res = await fetch(base() + path, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}), body: body ? JSON.stringify(body) : undefined })
  } catch { return { status: 0, error: 'You seem to be offline. Please check your connection and try again.' } }
  let j = null; try { j = await res.json() } catch {}
  if (res.status === 401 && t && path !== '/acct/login') { signedOutLocally() } // the session ended (another device reset the password, or it expired)
  return Object.assign({ status: res.status }, j || {})
}
function signedOutLocally() { del(K.token); del(K.user); render() }

// ── conversations ↔ account ────────────────────────────────────────────────────────────────────────────────────────
function pack(c) {
  const msgs = (c.messages || []).map((m) => (m.img ? { role: m.role, text: '[Image: ' + (m.cap || 'generated image') + ']' } : { role: m.role, text: m.text, sources: m.sources, files: m.files }))
  const make = () => JSON.stringify({ v: 1, titled: !!c.titled, created: c.created, messages: msgs })
  let payload = make()
  while (payload.length > 235000 && msgs.length > 2) { msgs.splice(0, 2); payload = make() } // keep the newest part of a very long conversation
  return { id: c.id, title: c.title || 'Conversation', payload, updated_at: c.updated || Date.now() }
}
function unpack(id, title, payload, updated) {
  let p = {}; try { p = JSON.parse(payload) } catch {}
  return { id, title: title || 'Conversation', titled: p.titled !== false, created: p.created || updated, updated, messages: Array.isArray(p.messages) ? p.messages : [] }
}
let hooks = null, syncing = false, pushTimers = {}
async function pushOne(c) {
  const r = await api('POST', '/acct/convos/put', pack(c))
  if (r.ok) { const s = new Set(rd(K.synced, [])); s.add(c.id); wr(K.synced, [...s]); return true }
  return false
}
export async function syncNow() {
  if (!token() || !hooks || syncing) return { ok: false }
  syncing = true; setStatus('Syncing…')
  try {
    const pend = rd(K.pend, [])
    for (const id of pend) await api('POST', '/acct/convos/delete', { id })
    wr(K.pend, [])
    const list = await api('GET', '/acct/convos')
    if (!list.ok) { setStatus(list.error || 'Could not sync just now.'); return { ok: false } }
    const remote = new Map(list.convos.map((r) => [r.id, r]))
    const synced = new Set(rd(K.synced, []))
    const local = hooks.getConvos().slice(), keep = [], pull = [], push = []
    let changed = false
    for (const c of local) {
      const r = remote.get(c.id)
      if (r) {
        if (r.updated_at > (c.updated || 0)) pull.push(r)
        else if ((c.updated || 0) > r.updated_at) push.push(c)
        keep.push(c)
      } else if (synced.has(c.id)) { changed = true } // it was in the account before and is gone: deleted on another device
      else { push.push(c); keep.push(c) } // new on this device
    }
    const have = new Set(local.map((c) => c.id))
    for (const r of list.convos) if (!have.has(r.id)) pull.push(r)
    for (const r of pull) {
      const g = await api('GET', '/acct/convos/get?id=' + encodeURIComponent(r.id))
      if (!g.ok) continue
      const nc = unpack(r.id, g.convo.title, g.convo.payload, g.convo.updated_at)
      const i = keep.findIndex((x) => x.id === r.id)
      if (i >= 0) keep[i] = nc; else keep.push(nc)
      changed = true
    }
    let failed = 0
    for (const c of push) if (!(await pushOne(c))) failed++
    const ids = new Set(keep.map((c) => c.id)); if (failed) for (const c of push) ids.delete(c.id)
    wr(K.synced, [...ids].filter((id) => remote.has(id) || push.some((c) => c.id === id) || pull.some((r) => r.id === id)))
    if (changed) hooks.setConvos(keep)
    wr(K.last, Date.now())
    setStatus(failed ? failed + ' conversation(s) will sync when the connection allows.' : 'All conversations are saved to your account.')
    return { ok: true }
  } finally { syncing = false; render() }
}
export function convoChanged(id) {
  if (!token() || !hooks) return
  clearTimeout(pushTimers[id])
  pushTimers[id] = setTimeout(async () => { delete pushTimers[id]; const c = hooks.getConvos().find((x) => x.id === id); if (c) await pushOne(c) }, 2500)
}
export async function convoDeleted(id) {
  if (!token()) return
  clearTimeout(pushTimers[id])
  const s = new Set(rd(K.synced, [])); s.delete(id); wr(K.synced, [...s])
  const r = await api('POST', '/acct/convos/delete', { id })
  if (!r.ok) { const p = new Set(rd(K.pend, [])); p.add(id); wr(K.pend, [...p]) }
}

// ── the account window ─────────────────────────────────────────────────────────────────────────────────────────────
let mode = 'signin', resetToken = '', status = '', busy = false
const $ = (id) => document.getElementById(id)
function setStatus(t) { status = t; const el = $('acctSync'); if (el) el.textContent = t }
function msg(text, kind) { const m = $('acctMsg'); if (m) { m.textContent = text || ''; m.className = 'pm-msg' + (kind ? ' ' + kind : '') } }
const field = (id, label, type, ph, extra) => '<div><label for="' + id + '">' + label + '</label><input id="' + id + '" type="' + type + '" placeholder="' + esc(ph || '') + '" ' + (extra || '') + '></div>'
function render() {
  const body = $('acctBody'); if (!body) return
  const u = user()
  const t = $('acctTitle'), sub = $('acctSub')
  if (token() && u) {
    t.textContent = 'Your account'; sub.textContent = u.email
    const last = rd(K.last, 0)
    body.innerHTML = '<p class="acct-note" id="acctSync">' + esc(status || (last ? 'Last synced ' + new Date(last).toLocaleString() + '.' : 'Your conversations are saved to your account.')) + '</p>' +
      '<p class="acct-note dim">Your conversations are kept in your Noria account on our servers, so they are there on every device and after a password reset. Only you can open them. What Noria remembers about you stays on this device.</p>' +
      '<div class="acct-row"><button class="acct-btn" id="acctSyncBtn" type="button">Sync now</button><button class="acct-btn" id="acctExport" type="button">Download my data</button></div>' +
      '<div class="acct-row"><button class="acct-btn" id="acctOut" type="button">Sign out</button><button class="acct-btn danger" id="acctDelBtn" type="button">Delete account</button></div>' +
      '<div id="acctDel" hidden class="guide-fields" style="margin-top:12px">' + field('acctDelPw', 'Enter your password to delete the account and everything saved in it', 'password', 'Your password', 'autocomplete="current-password"') + '<button class="acct-btn danger" id="acctDelGo" type="button">Delete my account for good</button></div>'
    $('acctCta').hidden = true; msg('')
    $('acctSyncBtn').onclick = () => syncNow()
    $('acctOut').onclick = async () => { await api('POST', '/acct/logout'); del(K.token); del(K.user); del(K.synced); del(K.pend); del(K.last); status = ''; mode = 'signin'; render() }
    $('acctExport').onclick = async () => {
      const r = await api('GET', '/acct/export'); if (!r.ok) return msg(r.error || 'Could not download just now.', 'err')
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' })); a.download = 'noria-my-data.json'; document.body.appendChild(a); a.click(); a.remove()
    }
    $('acctDelBtn').onclick = () => { $('acctDel').hidden = !$('acctDel').hidden }
    $('acctDelGo').onclick = async () => {
      const r = await api('POST', '/acct/delete', { password: $('acctDelPw').value }); if (!r.ok) return msg(r.error || 'Could not delete just now.', 'err')
      del(K.token); del(K.user); del(K.synced); del(K.pend); del(K.last); mode = 'signin'; render(); msg('Your account and everything saved in it have been deleted.', 'ok')
    }
    return
  }
  const cta = $('acctCta'); cta.hidden = false; cta.disabled = false
  if (mode === 'forgot') {
    t.textContent = 'Reset your password'; sub.textContent = 'Enter your email and we will send you a link to choose a new one.'
    body.innerHTML = field('acctEmail', 'Email', 'email', 'you@example.com', 'autocomplete="email"') + '<p class="acct-link"><a href="#" id="acctBack">Back to sign in</a></p>'
    cta.textContent = 'Send reset link'
  } else if (mode === 'reset') {
    t.textContent = 'Choose a new password'; sub.textContent = 'Use at least 10 characters. A short phrase of a few words works well.'
    body.innerHTML = field('acctPw', 'New password', 'password', 'A short phrase', 'autocomplete="new-password"') + field('acctPw2', 'Repeat it', 'password', '', 'autocomplete="new-password"')
    cta.textContent = 'Save new password'
  } else if (mode === 'create') {
    t.textContent = 'Create your account'; sub.textContent = 'Save your conversations and open them on any device.'
    body.innerHTML = field('acctName', 'Your name (optional)', 'text', 'e.g. Ama', 'autocomplete="name"') + field('acctEmail', 'Email', 'email', 'you@example.com', 'autocomplete="email"') + field('acctPw', 'Password', 'password', 'At least 10 characters', 'autocomplete="new-password"') +
      '<p class="acct-link">Already have an account? <a href="#" id="acctToSignin">Sign in</a></p>'
    cta.textContent = 'Create account'
  } else {
    t.textContent = 'Sign in'; sub.textContent = 'Open your conversations on this device.'
    body.innerHTML = field('acctEmail', 'Email', 'email', 'you@example.com', 'autocomplete="email"') + field('acctPw', 'Password', 'password', 'Your password', 'autocomplete="current-password"') +
      '<p class="acct-link"><a href="#" id="acctToForgot">Forgot your password?</a> &nbsp;·&nbsp; <a href="#" id="acctToCreate">Create an account</a></p>'
    cta.textContent = 'Sign in'
  }
  for (const [id, m] of [['acctToForgot', 'forgot'], ['acctToCreate', 'create'], ['acctToSignin', 'signin'], ['acctBack', 'signin']]) { const a = $(id); if (a) a.onclick = (e) => { e.preventDefault(); mode = m; render(); msg('') } }
  const first = body.querySelector('input'); if (first) setTimeout(() => first.focus(), 30)
  body.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); cta.click() } }))
  cta.onclick = submit
}
async function submit() {
  if (busy) return
  const v = (id) => ($(id) ? $(id).value.trim() : '')
  const cta = $('acctCta'); busy = true; cta.disabled = true; const label = cta.textContent; cta.textContent = 'One moment…'; msg('')
  try {
    if (mode === 'forgot') {
      const r = await api('POST', '/acct/reset/request', { email: v('acctEmail') })
      msg(r.ok ? r.message : (r.error || 'Could not send just now.'), r.ok ? 'ok' : 'err')
    } else if (mode === 'reset') {
      const pw = $('acctPw').value, pw2 = $('acctPw2').value
      if (pw !== pw2) return msg('The two passwords do not match.', 'err')
      const r = await api('POST', '/acct/reset/confirm', { token: resetToken, password: pw })
      if (r.ok) { resetToken = ''; try { history.replaceState(null, '', location.pathname) } catch {} mode = 'signin'; render(); msg('Your password has been changed. Please sign in with the new one.', 'ok') }
      else msg(r.error || 'Could not reset just now.', 'err')
    } else {
      const create = mode === 'create'
      const r = await api('POST', create ? '/acct/register' : '/acct/login', create ? { email: v('acctEmail'), password: $('acctPw').value, name: v('acctName'), tz: (Intl.DateTimeFormat().resolvedOptions().timeZone || '') } : { email: v('acctEmail'), password: $('acctPw').value })
      if (r.ok) { try { localStorage.setItem(K.token, r.token) } catch {} wr(K.user, r.user); mode = 'signin'; status = ''; render(); syncNow() }
      else msg(r.error || 'Could not sign in just now.', 'err')
    }
  } finally { busy = false; const c = $('acctCta'); if (c) { c.disabled = false; if (c.textContent === 'One moment…') c.textContent = label } }
}
export function openAccount(startMode) {
  const w = $('acctModal'); if (!w) return
  if (startMode) mode = startMode
  render(); w.hidden = false
}
export function closeAccount() { const w = $('acctModal'); if (w) w.hidden = true }
export function isSignedIn() { return !!token() }

// ── start-up ───────────────────────────────────────────────────────────────────────────────────────────────────────
export function initAccount(h) {
  hooks = h
  const w = $('acctModal')
  if (w) { $('acctClose').onclick = closeAccount; w.addEventListener('click', (e) => { if (e.target === w) closeAccount() }) }
  const link = new URLSearchParams(location.search).get('reset')
  if (link) { resetToken = link; mode = 'reset'; openAccount('reset') }
  if (token()) { api('GET', '/acct/me').then((r) => { if (r.ok) { wr(K.user, r.user); syncNow() } }) } // confirms the session is still good, then merges
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && token() && hooks) for (const c of hooks.getConvos()) if (pushTimers[c.id]) { clearTimeout(pushTimers[c.id]); delete pushTimers[c.id]; pushOne(c) } })
}
