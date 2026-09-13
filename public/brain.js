/**
 * NORIA AUDIO (System 3) + brain link.
 *   - ask():   streams from the Noria Engine THROUGH our Body-OS proxy (/brain).
 *   - speak(): browser TTS, and reports word boundaries so the face lip-syncs.
 *   - listen(): browser STT (mic) for voice input.
 * The Engine is never called cross-origin; only our own server is.
 */
export class Brain {
  constructor() {
    this.history = []
    this.voices = []
    if ('speechSynthesis' in window) {
      const load = () => (this.voices = speechSynthesis.getVoices())
      load(); speechSynthesis.onvoiceschanged = load
    }
  }

  async health() {
    try { const r = await fetch('/brain/health'); return await r.json() } catch (e) { return { status: 'unreachable', error: e.message } }
  }

  // Stream an answer. Calls onToken(delta) as text arrives; resolves to full text.
  async ask(query, { onToken = () => {}, system = '' } = {}) {
    const res = await fetch('/brain/ask/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, history: this.history.slice(-8), system }),
    })
    if (!res.ok || !res.body) throw new Error('Brain unreachable (' + res.status + ')')
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = '', full = '', meta = {}
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        try {
          const obj = JSON.parse(payload)
          if (obj.token) { full += obj.token; onToken(obj.token) }
          if (obj.done) meta = obj
          if (obj.error) throw new Error(obj.error)
        } catch (e) { if (e.message && !/JSON/.test(e.message)) throw e }
      }
    }
    this.history.push({ role: 'user', content: query }, { role: 'assistant', content: full })
    return { text: full, ...meta }
  }

  // Structured ask: returns { reply, controls } where controls is the full
  // PHYSICAL HUMAN PRESENCE JSON (situation/condition/face/eyes/body/voice).
  // Falls back gracefully to plain text if the model doesn't return clean JSON.
  async ask2(query, { system = '' } = {}) {
    const res = await fetch('/brain/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, history: this.history.slice(-8), system }),
    })
    if (!res.ok) throw new Error('Brain unreachable (' + res.status + ')')
    const data = await res.json()
    const raw = data.answer ?? data.reply ?? ''
    const parsed = this._parseControls(raw)
    const reply = (parsed && parsed.reply) || raw || "I'm here."
    this.history.push({ role: 'user', content: query }, { role: 'assistant', content: reply })
    return { reply, controls: parsed }
  }

  _parseControls(raw) {
    if (!raw) return null
    let s = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a >= 0 && b > a) s = s.slice(a, b + 1)
    try { const o = JSON.parse(s); return typeof o === 'object' ? o : null } catch { return null }
  }

  // ── Speech out ──────────────────────────────────────────────────────────
  pickVoice(variant) {
    const v = this.voices
    if (!v.length) return null
    const en = v.filter((x) => /^en/i.test(x.lang))
    const wantFemale = variant !== 'M'
    const byName = en.find((x) => (wantFemale ? /female|zira|samantha|aria|jenny|libby|sonia/i : /male|david|guy|mark|ryan/i).test(x.name))
    return byName || en[0] || v[0]
  }

  speak(text, { variant = 'F', emotion = 'warm', pace = '', tone = '', onStart = () => {}, onWord = () => {}, onEnd = () => {} } = {}) {
    if (!('speechSynthesis' in window)) { onStart(); onEnd(); return }
    speechSynthesis.cancel()
    // Voice control: pace → rate, tone → pitch feel (falls back to emotion).
    const TONE = { calm: -0.05, warm: 0.05, curious: 0.08, playful: 0.12, focused: 0, supportive: -0.03, concerned: -0.08 }
    const PACE = { slow: 0.9, natural: 1.0, energetic: 1.1 }
    const EMO = { joy: { r: 1.08, p: 0.12 }, warm: { r: 1.0, p: 0.05 }, neutral: { r: 1.0, p: 0 }, concern: { r: 0.92, p: -0.06 } }
    const pr = { r: PACE[pace] ?? (EMO[emotion] || EMO.warm).r, p: (tone in TONE) ? TONE[tone] : (EMO[emotion] || EMO.warm).p }
    // Split into sentences so long answers start talking sooner.
    const parts = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*/g) || [text]
    let started = false, idx = 0
    const speakPart = () => {
      if (idx >= parts.length) { onEnd(); return }
      const u = new SpeechSynthesisUtterance(parts[idx++].trim())
      const voice = this.pickVoice(variant)
      if (voice) u.voice = voice
      u.rate = pr.r; u.pitch = (variant === 'M' ? 0.9 : 1.05) + pr.p
      u.onstart = () => { if (!started) { started = true; onStart() } }
      u.onboundary = () => onWord()
      u.onend = () => speakPart()
      u.onerror = () => speakPart()
      speechSynthesis.speak(u)
    }
    speakPart()
  }

  stopSpeaking() { if ('speechSynthesis' in window) speechSynthesis.cancel() }

  // ── Speech in ─────────────────────────────────────────────────────────────
  listen({ onResult = () => {}, onEnd = () => {} } = {}) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { onEnd('unsupported'); return null }
    const rec = new SR()
    rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false
    let finalText = ''
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript
      }
      onResult(finalText + interim, finalText)
    }
    rec.onend = () => onEnd(finalText.trim())
    rec.onerror = (e) => onEnd(finalText.trim(), e.error)
    rec.start()
    return rec
  }
}
