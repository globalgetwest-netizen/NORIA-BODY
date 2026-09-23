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

// ── Voice-in (Whisper) helpers ────────────────────────────────────────────────
// Off until switched on: open the app once with ?stt=1 to enable it on this device
// (?stt=0 turns it off again). The browser recognizer stays as the fallback.
function sttEnabled() {
  try {
    const q = new URLSearchParams(location.search).get('stt')
    if (q === '1') localStorage.setItem('noria_stt', '1')
    else if (q === '0') localStorage.removeItem('noria_stt')
    return localStorage.getItem('noria_stt') === '1'
  } catch { return false }
}
// The visitor's own time zone (so "what time is it?" with no place means THEIR time).
function userTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' } }
function pickAudioMime() {
  const c = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
  try { for (const m of c) if (MediaRecorder.isTypeSupported(m)) return m } catch {}
  return ''
}
// Provider chain: our own /stt (Groq Whisper) → the Cloudflare Whisper worker.
// Returns the text ('' if no speech), or null if every provider failed.
async function transcribeAudio(blob) {
  const urls = ['/stt', 'https://noria-ai.insights-skyglobe.workers.dev/stt']
  for (const u of urls) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    try {
      const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob, signal: ctrl.signal })
      if (r.ok) { const d = await r.json(); if (d && typeof d.text === 'string') return d.text.trim() }
    } catch {} finally { clearTimeout(timer) }
  }
  return null
}

// Mono 16 kHz 16-bit WAV from raw microphone blocks (works in every browser, no encoder needed).
function encodeWav16k(blocks, rate) {
  let n = 0; for (const b of blocks) n += b.length
  const flat = new Float32Array(n); let o = 0
  for (const b of blocks) { flat.set(b, o); o += b.length }
  const ratio = rate / 16000, m = Math.floor(n / ratio), out = new Int16Array(m)
  for (let i = 0; i < m; i++) {
    const a = Math.floor(i * ratio), z = Math.min(n, Math.floor((i + 1) * ratio)); let s = 0
    for (let j = a; j < z; j++) s += flat[j]
    const v = Math.max(-1, Math.min(1, s / Math.max(1, z - a)))
    out[i] = Math.round(v * 32767)
  }
  const buf = new ArrayBuffer(44 + out.length * 2), d = new DataView(buf)
  const w = (p, t) => { for (let i = 0; i < t.length; i++) d.setUint8(p + i, t.charCodeAt(i)) }
  w(0, 'RIFF'); d.setUint32(4, 36 + out.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true)
  d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, 16000, true); d.setUint32(28, 32000, true)
  d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, out.length * 2, true)
  new Int16Array(buf, 44).set(out)
  return new Blob([buf], { type: 'audio/wav' })
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
  // historyOverride: an optional { role, content }[] replacing the default "last 8 messages" — set by the
  // conversation-state context builder (conversation-state.js's buildContext()) when it is wired in by the caller.
  // Left unset, behaviour is exactly what it always was: the last 8 messages, nothing more.
  async ask(query, { onToken = () => {}, system = '', signal = null, ground = false, voice = false, historyOverride = null } = {}) {
    // Own timeout (aborts a stalled stream) merged with any caller signal (Stop button).
    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), 90000)
    if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', () => ac.abort(), { once: true }) }
    // ground: false = the client already grounded (skip server search); 'auto' =
    // the client did NOT ground, so let the ROUTER decide and search if the query
    // needs live facts (a second safety-net layer so nothing current slips through).
    const payload = { query, history: historyOverride || this.history.slice(-8), system, tz: userTz() }
    if (voice) payload.voice = true // a spoken turn: the server answers briefly and with less deliberation
    if (ground === false) payload.ground = false
    else if (ground === true) payload.ground = true // 'auto' → omit → server uses serverNeedsWeb
    let res
    try {
      // one quiet retry if the server briefly fails (a 5xx from a momentary platform limit), so a hiccup never reaches the person
      for (let attempt = 0; attempt < 2; attempt++) {
        res = await fetch('/brain/ask/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ac.signal,
        })
        if (res.status < 500 || attempt) break
        try { await res.body.cancel() } catch (_) {}
        await new Promise((r) => setTimeout(r, 700))
      }
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

  // A model that has lost its thread (repeats itself, argues with its own list) must never reach the user.
  isRambling(text) {
    const t = String(text || '')
    if (t.length < 400) return false
    const seen = {}
    for (const raw of t.split('\n')) {
      const l = raw.toLowerCase().replace(/^[\s>*#\-|\d.)]+/, '').replace(/[*_`|]/g, '').trim()
      if (l.length < 6) continue
      if ((seen[l] = (seen[l] || 0) + 1) >= 4) return true
    }
    if ((t.match(/\((?:again|duplicate)[^)]{0,40}\)/gi) || []).length >= 3) return true
    return (t.match(/let'?s (?:correct|restructure|adjust|choose|pick|use)/gi) || []).length >= 3
  }
  // If the structured reply was cut short, its JSON cannot be parsed — pull the text out anyway, never show the braces.
  _recoverDisplay(raw) {
    const m = /"display_text"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw)
    if (!m) return null
    try { return JSON.parse('"' + m[1] + '"') } catch (_) { return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') }
  }

  // Structured ask: returns { reply, controls } where controls is the full
  // PHYSICAL HUMAN PRESENCE JSON (situation/condition/face/eyes/body/voice).
  // Falls back gracefully to plain text if the model doesn't return clean JSON.
  async ask2(query, { system = '', historyOverride = null } = {}) {
    // Bounded so a stalled model shows an error instead of an endless spinner.
    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), 70000)
    let res
    try {
      res = await fetch('/brain/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // ground:false — the workspace already injected live web + vector memory.
        body: JSON.stringify({ query, history: historyOverride || this.history.slice(-8), system, ground: false, tz: userTz() }),
        signal: ac.signal,
      })
    } catch (e) { clearTimeout(to); throw new Error(ac.signal.aborted ? 'Brain timed out' : 'Brain unreachable') }
    clearTimeout(to)
    if (!res.ok) throw new Error('Brain unreachable (' + res.status + ')')
    const data = await res.json()
    const raw = data.answer ?? data.reply ?? ''
    const parsed = this._parseControls(raw)
    // display_text is shown in chat; spoken_text is voiced. Fall back gracefully.
    const display = (parsed && (parsed.display_text || parsed.reply || parsed.spoken_text)) || (/^\s*\{/.test(raw) && this._recoverDisplay(raw)) || raw || "I'm here."
    const spoken = (parsed && parsed.spoken_text) || speechify(display)
    this.history.push({ role: 'user', content: query }, { role: 'assistant', content: display })
    return { display, spoken, controls: parsed, sources: Array.isArray(data.sources) ? data.sources : [] }
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
  //
  // Layered: Whisper first (records the mic, transcribes on the server — far better
  // with accents/noise), and the browser's own recognizer below is the last resort,
  // used unchanged whenever Whisper is off, unsupported, or every provider fails.
  listen(opts = {}) {
    if (!sttEnabled() || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') return this._listenBrowser(opts)
    return this._listenWhisper(opts)
  }

  _listenWhisper({ onResult = () => {}, onEnd = () => {}, silenceMs = 2200 } = {}) {
    let finished = false, mr = null
    const ctl = {
      inner: null, stopped: false,
      stop() { this.stopped = true; if (this.inner) { try { this.inner.stop() } catch {} } else if (mr && mr.state !== 'inactive') { try { mr.stop() } catch {} } },
    }
    // iPhone/Safari: an AudioContext only runs if it is created/resumed inside the tap itself, so
    // make it here (synchronously, before the microphone permission wait) or the voice-activity
    // detector below would hear pure silence and never notice you speaking.
    let pre = null
    try { const AC = window.AudioContext || window.webkitAudioContext; pre = new AC(); if (pre.resume) pre.resume().catch(() => {}) } catch {}
    const finish = (text, err) => { if (finished) return; finished = true; onEnd(text, err) }
    // Last resort: the browser's own recognizer, exactly as before.
    const fallBack = () => { if (finished) return; ctl.inner = this._listenBrowser({ onResult, onEnd: finish, silenceMs }); if (!ctl.inner) finish('', 'unsupported') }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(async (stream) => {
      const release = () => { try { stream.getTracks().forEach((t) => t.stop()) } catch {} ; try { pre && pre.close() } catch {} }
      if (ctl.stopped) { release(); finish(''); return }
      // Cannot measure the voice (context not running)? Don't record blind — use the browser recognizer.
      try { if (pre && pre.state !== 'running') await pre.resume() } catch {}
      if (!pre || pre.state !== 'running') { release(); fallBack(); return }
      const mime = pickAudioMime()
      try { mr = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 }) : new MediaRecorder(stream) } catch { release(); fallBack(); return }
      const chunks = []
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
      // Voice-activity detection: know when the user is speaking, and when they have
      // finished, so we only ever send real speech (saves free quota, adds no lag).
      const ac = pre; let an = null, samples = null
      try { an = ac.createAnalyser(); an.fftSize = 1024; ac.createMediaStreamSource(stream).connect(an); samples = new Uint8Array(an.fftSize) } catch {}
      if (!an) { release(); fallBack(); return }
      const t0 = Date.now()
      let heard = 0, lastVoice = 0, floor = 0.01, lastBeat = 0
      const quiet = Math.min(silenceMs, 1700)
      const tick = setInterval(() => {
        if (mr.state === 'inactive') return
        const now = Date.now()
        if (an) {
          an.getByteTimeDomainData(samples)
          let s = 0; for (let i = 0; i < samples.length; i++) { const v = (samples[i] - 128) / 128; s += v * v }
          const rms = Math.sqrt(s / samples.length)
          if (now - t0 < 600) floor = Math.max(floor, Math.min(rms, 0.05))          // learn the room's noise
          if (rms > Math.max(0.02, floor * 2.5)) { heard += 100; lastVoice = now; if (now - lastBeat > 400) { lastBeat = now; onResult('', '') } } // heartbeat keeps the UI awake
        } else { heard = 1000; lastVoice = now }                                       // no analyser → rely on manual stop
        if (heard >= 200 && now - lastVoice > quiet) { try { mr.stop() } catch {} }
        else if (heard < 200 && now - t0 > 8000) { try { mr.stop() } catch {} }        // never spoke
        else if (now - t0 > 60000) { try { mr.stop() } catch {} }                      // hard cap
      }, 100)
      mr.onstop = async () => {
        clearInterval(tick); release(); try { ac && ac.close() } catch {}
        const dur = Date.now() - t0
        const blob = new Blob(chunks, { type: (mr.mimeType || mime || 'audio/webm').split(';')[0] })
        if (heard < 200 || blob.size < 1500) { finish(''); return }
        onResult('', '')
        const text = await transcribeAudio(blob)
        if (finished) return
        if (text === null) { fallBack(); return }                                      // every provider failed → browser recognizer
        const t = /^(thank you\.?|thanks for watching\.?|you\.?|bye\.?)$/i.test(text) && dur < 2500 ? '' : text // Whisper's silence hallucinations
        if (t) onResult(t, t)
        finish(t)
      }
      mr.start()
    }).catch(() => { try { pre && pre.close() } catch {} ; if (!ctl.stopped) fallBack(); else finish('') })                  // mic denied/unavailable → browser path reports it
    return ctl
  }

  // ── Hands-free voice conversation ─────────────────────────────────────────
  // One tap starts it; after that nobody presses anything. The microphone stays open and a voice-
  // activity detector (energy vs. the room's own noise level) notices when you start talking,
  // captures your words, and cuts off when you naturally finish. The words are transcribed
  // (Whisper), handed to `onUtterance` (the app answers AND speaks; the promise it returns resolves
  // when she has finished talking), and then she listens again. While she thinks/speaks the mic is
  // muted, so she never hears herself.
  //   states: 'listening' → 'hearing' → 'thinking' → 'speaking' → 'listening' …
  // Returns null if this browser can't do it (caller then uses the older tap-to-talk path).
  // onEnd(reason): 'stopped' | 'idle' | 'hidden' | 'denied' | 'unsupported' | 'stt-failed'
  converse({ onState = () => {}, onLevel = () => {}, onHeard = () => {}, onUtterance = async () => {}, onEnd = () => {}, endSilenceMs = 700, idleMs = 120000 } = {}) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !AC.prototype.createScriptProcessor) return null
    let ctx
    try { ctx = new AC(); if (ctx.resume) ctx.resume().catch(() => {}) } catch { return null } // made inside the tap, so iPhone lets it run
    let stream = null, proc = null, srcNode = null, ended = false, state = 'starting'
    const setState = (s) => { if (s !== state && !ended) { state = s; try { onState(s) } catch {} } }
    const vis = () => { if (document.hidden) end('hidden') }
    const end = (why) => {
      if (ended) return; ended = true
      try { document.removeEventListener('visibilitychange', vis) } catch {}
      try { proc && (proc.onaudioprocess = null, proc.disconnect()) } catch {}
      try { srcNode && srcNode.disconnect() } catch {}
      try { stream && stream.getTracks().forEach((t) => t.stop()) } catch {}
      try { ctx.close() } catch {}
      try { onEnd(why) } catch {}
    }
    document.addEventListener('visibilitychange', vis)
    const ctl = { stop: () => end('stopped'), mark: (s) => setState(s), get state() { return state } }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(async (s) => {
      if (ended) { s.getTracks().forEach((t) => t.stop()); return }
      stream = s
      try { if (ctx.state !== 'running') await ctx.resume() } catch {}
      if (ctx.state !== 'running') { end('unsupported'); return }
      srcNode = ctx.createMediaStreamSource(stream)
      proc = ctx.createScriptProcessor(2048, 1, 1)
      // Wake the transcription service now (a cold start costs seconds) so your first sentence isn't slow.
      try { transcribeAudio(encodeWav16k([new Float32Array(4096)], ctx.sampleRate)).catch(() => {}) } catch {}
      const rate = ctx.sampleRate, PRE = 8, MAXBLOCKS = Math.ceil(30 * rate / 2048)
      let floor = 0.01, run = 0, active = false, voiced = 0, lastVoice = 0, utter = [], pre = []
      let busy = false, resumeAt = 0, lastHeard = Date.now(), lastBeat = 0, fails = 0
      const finish = async () => {
        const blocks = utter, v = voiced
        active = false; utter = []; run = 0; voiced = 0
        if (v < 6) { setState('listening'); return } // a click, a cough or room noise — not speech
        busy = true
        try { stream.getAudioTracks().forEach((t) => { t.enabled = false }) } catch {} // muted while she works/talks
        setState('thinking')
        try {
          let text = await transcribeAudio(encodeWav16k(blocks, rate))
          if (text === null) { if (++fails >= 2) { end('stt-failed'); return } }
          else {
            fails = 0; text = text.trim()
            const phantom = /^(thank you\.?|thanks for watching\.?|you\.?|bye\.?)$/i.test(text) && v < 14 // Whisper's silence hallucinations
            if (text && !phantom) { lastHeard = Date.now(); try { onHeard(text) } catch {} await onUtterance(text, ctl) }
          }
        } catch {}
        if (ended) return
        try { stream.getAudioTracks().forEach((t) => { t.enabled = true }) } catch {}
        resumeAt = Date.now() + 500; lastHeard = Date.now(); busy = false
        setState('listening')
      }
      proc.onaudioprocess = (e) => {
        if (ended) return
        const x = e.inputBuffer.getChannelData(0)
        let sum = 0; for (let i = 0; i < x.length; i++) sum += x[i] * x[i]
        const rms = Math.sqrt(sum / x.length), now = Date.now()
        if (busy || now < resumeAt) { if (now - lastBeat > 60) { lastBeat = now; onLevel(0) } return }
        const voice = rms > Math.max(0.018, floor * 3)
        if (!active) {
          floor = Math.min(0.05, Math.max(0.004, floor * 0.95 + rms * 0.05)) // learn the room's noise
          pre.push(new Float32Array(x)); if (pre.length > PRE) pre.shift()
          run = voice ? run + 1 : 0
          if (run >= 2) { active = true; utter = pre; pre = []; voiced = run; lastVoice = now; setState('hearing') }
          else if (now - lastHeard > idleMs) { end('idle'); return }
        } else {
          utter.push(new Float32Array(x))
          if (voice) { voiced++; lastVoice = now }
          if (now - lastVoice > endSilenceMs || utter.length > MAXBLOCKS) finish()
        }
        if (now - lastBeat > 60) { lastBeat = now; onLevel(Math.min(1, rms * 8)) }
      }
      srcNode.connect(proc); proc.connect(ctx.destination) // we never write output, so this stays silent
      setState('listening')
    }).catch(() => end('denied'))
    return ctl
  }

  _listenBrowser({ onResult = () => {}, onEnd = () => {}, silenceMs = 2200 } = {}) {
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
