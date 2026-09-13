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

export function loadMemory() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null } catch { return null }
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
  const facts = (m.facts || []).slice(-12)
  if (!bits.length && !facts.length) return ''
  return (
    '\n\n[WHAT YOU REMEMBER ABOUT THIS PERSON — from previous conversations. Use it naturally to stay warm and consistent; do NOT recite it back verbatim]:\n' +
    bits.join('\n') +
    (facts.length ? '\nNotes:\n- ' + facts.join('\n- ') : '')
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
    m.facts = m.facts || []
    for (const f of upd.facts) {
      const s = String(f).trim().slice(0, 240)
      if (s && !m.facts.includes(s)) m.facts.push(s)
    }
    m.facts = m.facts.slice(-30)
  }
  save(m)
  return m
}

export function forgetMemory() { try { localStorage.removeItem(KEY) } catch {} }
