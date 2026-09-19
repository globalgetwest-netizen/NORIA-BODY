/**
 * NORIA AUDIO (System 3) + brain link.
 *   - ask():   streams from the Noria Engine THROUGH our Body-OS proxy (/brain).
 *   - speak(): browser TTS, and reports word boundaries so the face lip-syncs.
 *   - listen(): browser STT (mic) for voice input.
 * The Engine is never called cross-origin; only our own server is.
 */
// Fallback: turn chat/markdown text into clean speech if the model omits
// spoken_text — strip code, markdown, links, URLs and emoji so TTS doesn't
// read symbols aloud like a screen reader.
function speechify(t) {
  return String(t || '')
    .replace(/```[\s\S]*?```/g, ' (code is shown in the chat) ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#*_>~|]+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ' ')
    .replace(/[←-⇿⌀-➿⬀-⯿️‍]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Expand things a TTS voice reads awkwardly, so speech sounds natural and human
// rather than like a screen reader. Applied to the browser-voice path.
function normalizeForSpeech(t) {
  return normalizeSpokenText(t)
}

// Shared spoken-text normalizer: turns things a TTS reads awkwardly (money,
// dates, abbreviations, symbols) into natural spoken English, so Noria sounds
// human rather than like a screen reader. Chat text is untouched — only speech.
const _MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const _CUR = { '$': 'dollars', '€': 'euros', '£': 'pounds' }
function _ord(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
export function normalizeSpokenText(t) {
  return String(t || '')
    // ISO dates 2026-09-13 → "September 13th, 2026"
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => {
      const mi = +mo - 1; return _MONTHS[mi] ? `${_MONTHS[mi]} ${_ord(+d)}, ${y}` : m
    })
    // Money $1,200.50 → "1200 dollars and 50 cents"; $300 → "300 dollars"
    .replace(/([$€£])\s?(\d[\d,]*)(?:\.(\d{2}))?/g, (m, sym, whole, cents) => {
      const unit = _CUR[sym] || ''; const n = whole.replace(/,/g, '')
      return cents ? `${n} ${unit} and ${cents} cents` : `${n} ${unit}`
    })
    .replace(/\be\.g\.\s*/gi, 'for example ')
    .replace(/\bi\.e\.\s*/gi, 'that is ')
    .replace(/\betc\.?/gi, 'etcetera')
    .replace(/\bvs\.?\b/gi, 'versus')
    .replace(/\bapprox\.?\b/gi, 'approximately')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/(\d)\s*%/g, '$1 percent')
    // Brand names: read as words, never spelled letter-by-letter (all-caps and
    // joined forms are what TTS engines spell out).
    .replace(/\bSKY\s*GLOBE\s*GROUP\b/gi, 'Sky Globe Group')
    .replace(/\bSKY\s*GLOBE\b/gi, 'Sky Globe')
    .replace(/\bSkyGlobe\b/g, 'Sky Globe')
    .replace(/\bNORIA\b/g, 'Noria')
    .replace(/\bTERRA\b/g, 'Terra')
    .replace(/\bYUNEX\b/g, 'Yunex')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

// Clean chat/markdown text into natural speech (strip code/markdown/links/symbols/
// emoji, then naturalize money/dates/abbreviations/brands). Apply this to ANY text
// before sending it to a TTS voice, so symbols like ** and # are never read aloud.
export function toSpeech(t) { return normalizeSpokenText(speechify(t)) }

// Detect the language of text (script + common-word heuristic) so speech reads
// WORDS in the right language instead of spelling out letters. LANG_BCP maps the
// short code to a speech-synthesis locale.
export const LANG_BCP = { en: 'en-US', fr: 'fr-FR', es: 'es-ES', pt: 'pt-BR', de: 'de-DE', it: 'it-IT', ar: 'ar-SA', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', ru: 'ru-RU', hi: 'hi-IN', tr: 'tr-TR', nl: 'nl-NL' }
export function detectLang(text) {
  const s = String(text || '')
  if (/[؀-ۿ]/.test(s)) return 'ar'
  if (/[一-鿿]/.test(s)) return 'zh'
  if (/[぀-ヿ]/.test(s)) return 'ja'
  if (/[가-힯]/.test(s)) return 'ko'
  if (/[Ѐ-ӿ]/.test(s)) return 'ru'
  if (/[ऀ-ॿ]/.test(s)) return 'hi'
  const l = ' ' + s.toLowerCase() + ' '
  // Unambiguous letters/punctuation first
  if (/[¿¡ñ]/.test(l)) return 'es'
  if (/[œ]|ç/.test(l)) return 'fr'
  if (/ß/.test(l)) return 'de'
  if (/[ãõ]/.test(l)) return 'pt'
  if (/[ğş]/.test(l) || /\b(merhaba|teşekkür|evet|için)\b/.test(l)) return 'tr'
  // Common-word signals
  if (/\b(le|la|les|des|une|est|vous|bonjour|merci|avec|pour|pas|je|tu|nous|oui)\b/.test(l)) return 'fr'
  if (/\b(el|los|una|está|gracias|hola|pero|porque|usted|con|cómo|qué|muy)\b/.test(l)) return 'es'
  if (/\b(você|obrigado|não|isso|uma|com)\b/.test(l)) return 'pt'
  if (/\b(und|der|die|das|ist|nicht|danke|hallo|mit|ich|guten|wie|geht)\b/.test(l)) return 'de'
  if (/\b(ciao|grazie|perché|sono|questo|come|che)\b/.test(l)) return 'it'
  // Accented-letter fallback
  if (/[àâéèêëîïôûùüÿ]/.test(l)) return 'fr'
  if (/[áíóú]/.test(l)) return 'es'
  if (/[äöü]/.test(l)) return 'de'
  return 'en'
}

export class Brain {
  constructor() {
    this.history = []
    this.voices = []
    if ('speechSynthesis' in window) {
      const load = () => (this.voices = speechSynthesis.getVoices())
      load(); speechSynthesis.onvoiceschanged = load
    }
    // Console voice test: run  __testVoice()  in DevTools to check TTS directly.
    try { window.__testVoice = (t) => this.speak(t || 'Hello, this is a Noria voice test. If you can hear me, the voice works.', {}) } catch {}
  }

  async health() {
    try { const r = await fetch('/brain/health'); return await r.json() } catch (e) { return { status: 'unreachable', error: e.message } }
  }

  // Stream an answer. Calls onToken(delta) as text arrives; resolves to full text.
  async ask(query, { onToken = () => {}, system = '', signal = null, ground = false } = {}) {
    // Own timeout (aborts a stalled stream) merged with any caller signal (Stop button).
    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), 90000)
    if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true }) }
    // ground: false = the client already grounded (skip server search); 'auto' =
    // the client did NOT ground, so let the ROUTER decide and search if the query
    // needs live facts (a second safety-net layer so nothing current slips through).
    const payload = { query, history: this.history.slice(-8), system }
    if (ground === false) payload.ground = false
    else if (ground === true) payload.ground = true // 'auto' → omit → server uses serverNeedsWeb
    let res
    try {
      res = await fetch('/brain/ask/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      })
    } catch (e) { clearTimeout(to); throw new Error(ac.signal.aborted ? 'aborted' : 'Brain unreachable') }
    if (!res.ok || !res.body) { clearTimeout(to); throw new Error('Brain unreachable (' + res.status + ')') }
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
    clearTimeout(to)
    this.history.push({ role: 'user', content: query }, { role: 'assistant', content: full })
    return { text: full, ...meta }
  }

  // Structured ask: returns { reply, controls } where controls is the full
  // PHYSICAL HUMAN PRESENCE JSON (situation/condition/face/eyes/body/voice).
  // Falls back gracefully to plain text if the model doesn't return clean JSON.
  async ask2(query, { system = '' } = {}) {
    // Bounded so a stalled model shows an error instead of an endless spinner.
    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), 70000)
    let res
    try {
      res = await fetch('/brain/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // ground:false — the workspace already injected live web + vector memory.
        body: JSON.stringify({ query, history: this.history.slice(-8), system, ground: false }),
        signal: ac.signal,
      })
    } catch (e) { clearTimeout(to); throw new Error(ac.signal.aborted ? 'Brain timed out' : 'Brain unreachable') }
    clearTimeout(to)
    if (!res.ok) throw new Error('Brain unreachable (' + res.status + ')')
    const data = await res.json()
    const raw = data.answer ?? data.reply ?? ''
    const parsed = this._parseControls(raw)
    // display_text is shown in chat; spoken_text is voiced. Fall back gracefully.
    const display = (parsed && (parsed.display_text || parsed.reply)) || raw || "I'm here."
    const spoken = (parsed && parsed.spoken_text) || speechify(display)
    this.history.push({ role: 'user', content: query }, { role: 'assistant', content: display })
    return { display, spoken, controls: parsed }
  }

  // Send a 👍/👎 on an answer to the Engine's feedback/review pipeline.
  async sendFeedback(rating, question, answer) {
    try {
      await fetch('/brain/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, question: (question || '').slice(0, 2000), answer: (answer || '').slice(0, 2000) }),
      })
      return true
    } catch { return false }
  }

  _parseControls(raw) {
    if (!raw) return null
    let s = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
    const a = s.indexOf('{'), b = s.lastIndexOf('}')
    if (a >= 0 && b > a) s = s.slice(a, b + 1)
    try { const o = JSON.parse(s); return typeof o === 'object' ? o : null } catch { return null }
  }

  // ── Speech out ──────────────────────────────────────────────────────────
  // Pick the MOST NATURAL voice the device offers — strongly prefer modern
  // neural/"Natural"/online voices over the old robotic "Desktop" ones.
  pickVoice(variant, lang = 'en') {
    const v = this.voices
    if (!v.length) return null
    const base = (lang || 'en').slice(0, 2).toLowerCase()
    // Only choose from voices that actually speak this language — forcing an
    // English voice onto foreign text is what makes it spell letters. If the
    // device has no voice for the language, return null and let the engine pick
    // via utterance.lang.
    const pool = v.filter((x) => (x.lang || '').slice(0, 2).toLowerCase() === base)
    if (!pool.length) return null
    const wantF = variant !== 'M'
    const fNames = /aria|jenny|libby|sonia|michelle|emma|ava|clara|natasha|nicole|samantha|a(ria|va)|female|zira/i
    const mNames = /guy|ryan|eric|christopher|brian|liam|andrew|steffan|davis|tony|male|mark|david/i
    const score = (x) => {
      const n = (x.name || '').toLowerCase(); let s = 0
      if (/natural/.test(n)) s += 160        // Microsoft "…(Natural)" = the most human
      if (/neural/.test(n)) s += 120
      if (/online/.test(n)) s += 60          // Edge online neural voices
      if (/google/.test(n)) s += 35
      if (/microsoft/.test(n)) s += 12
      if (/desktop|david|zira|mark|hazel/.test(n)) s -= 60   // old robotic SAPI voices
      if (wantF && fNames.test(n)) s += 40
      if (!wantF && mNames.test(n)) s += 40
      if (wantF && mNames.test(n)) s -= 45   // never a male voice for Noria-F
      if (!wantF && fNames.test(n)) s -= 45   // never a female voice for Noria-M
      if (/en-us/i.test(x.lang)) s += 8
      if (x.localService === false) s += 10  // network neural voices sound better
      return s
    }
    return [...pool].sort((a, b) => score(b) - score(a))[0]
  }

  speak(text, { variant = 'F', emotion = 'warm', pace = '', tone = '', onStart = () => {}, onWord = () => {}, onEnd = () => {} } = {}) {
    const synth = window.speechSynthesis
    if (!synth) { console.warn('[Noria voice] speechSynthesis is not available in this browser.'); onStart(); onEnd(); return }
    text = normalizeForSpeech(speechify(text)) // never voice emoji/symbols/markdown; read naturally
    if (!text) { onStart(); onEnd(); return }
    if (!this.voices || !this.voices.length) this.voices = synth.getVoices() // ensure voices loaded
    const lang = detectLang(text)                 // read words in the right language, not letter-by-letter
    const uLang = LANG_BCP[lang] || 'en-US'
    try { synth.cancel() } catch {}
    const TONE = { calm: -0.05, warm: 0.05, curious: 0.08, playful: 0.12, focused: 0, supportive: -0.03, concerned: -0.08 }
    const PACE = { slow: 0.9, natural: 1.0, energetic: 1.1 }
    const EMO = { joy: { r: 1.08, p: 0.12 }, warm: { r: 1.0, p: 0.05 }, neutral: { r: 1.0, p: 0 }, concern: { r: 0.92, p: -0.06 } }
    const pr = { r: PACE[pace] ?? (EMO[emotion] || EMO.warm).r, p: (tone in TONE) ? TONE[tone] : (EMO[emotion] || EMO.warm).p }
    // Split into sentences, then break any long sentence into <=180-char pieces
    // at a comma/space — Chrome silently cuts speech after ~15s, so short chunks
    // keep her from dropping out mid-sentence.
    const sentences = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]*/g) || [text]
    const parts = []
    for (const s of sentences) {
      let t = s.trim(); if (!t) continue
      while (t.length > 180) {
        let cut = t.lastIndexOf(',', 180); if (cut < 80) cut = t.lastIndexOf(' ', 180); if (cut < 80) cut = 180
        parts.push(t.slice(0, cut + 1).trim()); t = t.slice(cut + 1).trim()
      }
      if (t) parts.push(t)
    }
    if (!parts.length) parts.push(text)
    let started = false, idx = 0, keepAlive = null
    const stop = () => { if (keepAlive) { clearInterval(keepAlive); keepAlive = null } }
    const speakPart = () => {
      if (idx >= parts.length) { stop(); onEnd(); return }
      const u = new SpeechSynthesisUtterance(parts[idx++].trim())
      const voice = this.pickVoice(variant, lang)
      if (voice) u.voice = voice
      u.lang = (voice && voice.lang) || uLang    // correct locale → reads words, not letters
      u.rate = pr.r; u.pitch = (variant === 'M' ? 0.9 : 1.05) + pr.p; u.volume = 1
      let advanced = false, wd = null
      const next = () => { if (advanced) return; advanced = true; if (wd) clearTimeout(wd); speakPart() }
      u.onstart = () => { if (wd) { clearTimeout(wd); wd = null }; if (!started) { started = true; console.log('[Noria voice] speaking with:', (voice && voice.name) || 'default voice'); onStart() } }
      u.onboundary = () => onWord()
      u.onend = () => next()
      u.onerror = (e) => { console.warn('[Noria voice] utterance error:', e && e.error); next() }
      try {
        synth.speak(u)
        // Watchdog: if this piece never STARTS within ~3.5s, the speech engine is
        // wedged (a known Chrome bug after cancel/resume). Reset it and move on so
        // she doesn't go silent for the rest of the reply.
        wd = setTimeout(() => { try { synth.cancel(); synth.resume() } catch {} next() }, 3500)
      } catch (e) { console.warn('[Noria voice] speak() threw:', e); next() }
    }
    // Chrome bugs: synth can be silently "paused", and long speech stalls ~15s.
    // resume() now + a keep-alive resume, and start just after cancel settles.
    try { synth.resume() } catch {}
    keepAlive = setInterval(() => { try { if (synth.speaking) synth.resume() } catch {} }, 4000)
    setTimeout(speakPart, 60)
  }

  stopSpeaking() { try { window.speechSynthesis && window.speechSynthesis.cancel() } catch {} }

  // ── Speech in ─────────────────────────────────────────────────────────────
  // Voice input. continuous=true + a silence timer means a natural pause mid-
  // sentence no longer ends recognition early (the old continuous=false cut the
  // user off at the first pause, so Noria received only a fragment and seemed not
  // to understand). We keep listening and only submit after `silenceMs` of quiet,
  // so she gets the WHOLE sentence.
  listen({ onResult = () => {}, onEnd = () => {}, silenceMs = 2200 } = {}) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { onEnd('unsupported'); return null }
    const rec = new SR()
    rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = true
    let finalText = '', done = false, timer = null
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { try { rec.stop() } catch {} }, silenceMs) }
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); onEnd(finalText.trim(), err) }
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript
      }
      onResult(finalText + interim, finalText)
      arm() // restart the silence countdown every time speech arrives
    }
    rec.onend = () => finish()
    rec.onerror = (e) => finish(e.error)
    try { rec.start() } catch (_) { finish('start') }
    arm() // if they never speak, stop after the silence window
    return rec
  }
}
