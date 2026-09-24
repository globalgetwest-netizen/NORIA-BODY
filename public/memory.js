/**
 * NORIA MEMORY — real, honest persistence.
 *
 * Remembers a returning person across visits so Noria feels continuous ("she
 * knows me"). Stored in this browser (localStorage): private to the device,
 * survives visits, never leaves the browser. Not cross-device (that needs a
 * server DB) and not autonomous learning — it's durable memory + recall.
 *
 * Sensitive data is never stored (the persona is told not to emit it).
 */
const KEY = 'noria_memory_v1'
const PROFILE_KEYS = ['name', 'nationality', 'targetCountry', 'situation', 'goal']

// Facts used to be stored as bare strings, with no record of when they were learned — so a note
// from months ago looked exactly as current as one from five minutes ago, and there was no way to
// tell the model (or the person looking at their own memory) which was which. Facts are now
// { text, ts }; old bare-string facts already on someone's device are migrated in place, here, the
// first time they're loaded, so nothing already remembered is lost.
function normalizeFacts(facts) {
  return (Array.isArray(facts) ? facts : []).map((f) => (typeof f === 'string' ? { text: f, ts: null } : f)).filter((f) => f && f.text)
}
// A short, human relative age for a fact's timestamp — shared by the card (for the person) and
// memoryContext() (for the model), so the two can never disagree about how old something is.
// null (a fact migrated from before this existed, true age unknown) reads as "earlier".
export function factAge(ts) {
  if (!ts) return 'earlier'
  const days = Math.floor((Date.now() - ts) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return days + ' days ago'
  if (days < 30) { const w = Math.floor(days / 7); return w === 1 ? '1 week ago' : w + ' weeks ago' }
  if (days < 365) { const mo = Math.floor(days / 30); return mo === 1 ? '1 month ago' : mo + ' months ago' }
  return 'over a year ago'
}

export function loadMemory() {
  try {
    const m = JSON.parse(localStorage.getItem(KEY))
    if (!m) return null
    m.facts = normalizeFacts(m.facts)
    return m
  } catch { return null }
}
function save(m) { try { localStorage.setItem(KEY, JSON.stringify(m)) } catch {} }

// Call once on load. Bumps the visit counter and returns memory + whether this
// is a returning person.
export function initMemory() {
  let m = loadMemory()
  const firstTime = !m
  if (!m) m = { profile: {}, facts: [], visits: 0, firstSeen: Date.now(), lastSeen: 0 }
  const prevLast = m.lastSeen
  m.visits = (m.visits || 0) + 1
  m.lastSeen = Date.now()
  save(m)
  return { m, returning: !firstTime, prevLast }
}

// A short block injected into Noria's context so she uses what she remembers.
export function memoryContext(m) {
  if (!m) return ''
  const p = m.profile || {}
  const bits = PROFILE_KEYS.filter((k) => p[k]).map((k) => `${k}: ${p[k]}`)
  const facts = normalizeFacts(m.facts).slice(-12)
  if (!bits.length && !facts.length) return ''
  return (
    '\n\n[WHAT YOU REMEMBER ABOUT THIS PERSON — from previous conversations. Use it naturally to stay warm and consistent; do NOT recite it back verbatim. Each note shows how long ago it was learned — an older note may no longer be true, so treat it as a starting point to confirm, not a certainty, especially if the person now says something different]:\n' +
    bits.join('\n') +
    (facts.length ? '\nNotes:\n- ' + facts.map((f) => f.text + ' (' + factAge(f.ts) + ')').join('\n- ') : '')
  )
}

// Merge the `memory` object Noria returns into stored memory.
export function applyMemoryUpdate(m, upd) {
  if (!upd || typeof upd !== 'object') return m
  m.profile = m.profile || {}
  for (const k of PROFILE_KEYS) {
    const v = upd[k]
    if (typeof v === 'string' && v.trim()) m.profile[k] = v.trim().slice(0, 120)
  }
  if (Array.isArray(upd.facts)) {
    m.facts = normalizeFacts(m.facts)
    for (const f of upd.facts) {
      const s = String(f).trim().slice(0, 240)
      if (!s) continue
      const existing = m.facts.find((x) => x.text === s)
      if (existing) existing.ts = Date.now() // said again -> still true, refresh how current it is rather than add a duplicate row
      else m.facts.push({ text: s, ts: Date.now() })
    }
    m.facts = m.facts.slice(-30)
  }
  save(m)
  return m
}

// Let the person remove one wrong or outdated note without wiping everything else remembered.
export function forgetFact(m, text) {
  if (!m) return m
  m.facts = normalizeFacts(m.facts).filter((f) => f.text !== text)
  save(m)
  return m
}

export function forgetMemory() { try { localStorage.removeItem(KEY) } catch {} }
