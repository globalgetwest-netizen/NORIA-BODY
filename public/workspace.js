/**
 * Noria Workspace — the premium conversation UI wired to the REAL engine and the
 * NoriaPresenceEngine. Answers come from the live Noria brain (via the /brain
 * proxy, same as the classic app); the presence engine shapes delivery timing,
 * memory suggestions, and emotional state. The engine is never modified.
 */
import { Brain, toSpeech } from './brain.js'
import { noriaSystem } from './persona.js'
import { initMemory, memoryContext, applyMemoryUpdate, forgetMemory } from './memory.js'
import { retrieveKnowledge } from './knowledge.js?v=3'
import { NoriaPresenceEngine } from './noria-presence.js'

const $ = (id) => document.getElementById(id)
const brain = new Brain()
const { m: mem } = initMemory()

// One presence engine per conversation; its state is persisted on this device.
let saved = null
try { saved = JSON.parse(localStorage.getItem('noria.presence') || 'null') } catch {}
const presence = new NoriaPresenceEngine({ name: 'Noria', warmth: 0.78, expressiveness: 0.62 }, saved || undefined)
const savePresence = () => { try { localStorage.setItem('noria.presence', JSON.stringify(presence.getState())) } catch {} }

const thread = $('thread'), stream = $('stream'), input = $('input'),
      send = $('send'), stop = $('stop'), status = $('status'), empty = $('empty'),
      memCard = $('memCard')
const DOTS = '<span class="dots"><i></i><i></i><i></i></span>'
let busy = false, cancelled = false, curStream = null

// Brain status → the discreet presence line
brain.health().then((h) => {
  const up = h && h.status === 'ok'
  const el = $('presenceState'); if (el) el.textContent = up ? 'Attentive · ready' : 'reconnecting…'
  const dot = $('liveDot'); if (dot && !up) dot.style.background = 'var(--faint)'
}).catch(() => {})

// ── Text helpers ──────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) }
function mdInlineHtml(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
}
// Lightweight block-level markdown -> HTML: headings, bullet/number lists, code
// blocks and paragraphs, so structured answers (like guided documents) read as
// clean formatted text rather than raw "## ..." and "- ...".
function renderMd(el, text) {
  const blocks = [], S0 = '\uE000', S1 = '\uE001'
  const src = String(text).replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, c) => { blocks.push({ lang: (lang || '').toLowerCase(), code: c.replace(/\n$/, '') }); return S0 + (blocks.length - 1) + S1 })
  const cbRe = new RegExp('^' + S0 + '(\\d+)' + S1 + '$')
  let html = '', list = null, para = []
  const flushPara = () => { if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = [] } }
  const closeList = () => { if (list) { html += '</' + list + '>'; list = null } }
  const flush = () => { flushPara(); closeList() }
  const rowCells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
  const lines = src.split('\n')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].replace(/\s+$/, ''); let m
    // GFM table: a "| … |" header row followed by a "| --- | --- |" separator.
    if (/^\s*\|.*\|\s*$/.test(line) && li + 1 < lines.length && /-/.test(lines[li + 1]) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[li + 1])) {
      flush()
      const headers = rowCells(line); li++
      let body = ''
      while (li + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[li + 1])) { li++; const cells = rowCells(lines[li]); body += '<tr>' + headers.map((_, k) => '<td>' + mdInlineHtml(cells[k] || '') + '</td>').join('') + '</tr>' }
      html += '<div class="tablewrap"><table><thead><tr>' + headers.map((h) => '<th>' + mdInlineHtml(h) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table></div>'
      continue
    }
    if ((m = line.match(cbRe))) {
      flush(); const b = blocks[+m[1]]
      if (b.lang === 'chart') { html += '<div class="noria-chart" data-spec="' + esc(b.code).replace(/"/g, '&quot;') + '"><canvas></canvas></div>' }
      else { html += '<pre class="code"><code' + (b.lang ? ' class="language-' + esc(b.lang) + '"' : '') + '>' + esc(b.code) + '</code></pre>' }
      continue
    }
    if (!line.trim()) { flush(); continue }
    if ((m = line.match(/^\s*#{3,}\s+(.*)/))) { flush(); html += '<h3>' + mdInlineHtml(m[1]) + '</h3>'; continue }
    if ((m = line.match(/^\s*##\s+(.*)/))) { flush(); html += '<h2>' + mdInlineHtml(m[1]) + '</h2>'; continue }
    if ((m = line.match(/^\s*#\s+(.*)/))) { flush(); html += '<h1>' + mdInlineHtml(m[1]) + '</h1>'; continue }
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) { flushPara(); if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul' } html += '<li>' + mdInlineHtml(m[1]) + '</li>'; continue }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flushPara(); if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol' } html += '<li>' + mdInlineHtml(m[1]) + '</li>'; continue }
    closeList(); para.push(mdInlineHtml(line))
  }
  flush()
  el.innerHTML = html
  enhance(el)
}
// Progressive enhancement of a rendered message: syntax-highlight code, render
// ```chart blocks as live charts, and typeset LaTeX math. Each step lazy-loads its
// library only when needed and is fully guarded so a load hiccup never breaks text.
async function enhance(el) {
  try {
    const codes = el.querySelectorAll('pre.code code[class^="language-"]')
    if (codes.length) {
      await lazyStyle('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css')
      await lazyScript('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js')
      codes.forEach((c) => { try { window.hljs.highlightElement(c) } catch (_) {} })
    }
  } catch (_) {}
  try {
    const charts = el.querySelectorAll('.noria-chart')
    if (charts.length) {
      await lazyScript('https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.0/chart.umd.min.js')
      charts.forEach((d) => renderChart(d))
    }
  } catch (_) {}
  try {
    if (/\$\$|\\\(|\\\[/.test(el.textContent || '')) {
      await lazyStyle('https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css')
      await lazyScript('https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.js')
      await lazyScript('https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/contrib/auto-render.min.js')
      if (window.renderMathInElement) window.renderMathInElement(el, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false }], throwOnError: false })
    }
  } catch (_) {}
}
function renderChart(div) {
  try {
    if (div.dataset.rendered) return
    const spec = JSON.parse(div.dataset.spec || '{}')
    if (!spec || !spec.type || !spec.data) { div.remove(); return }
    const canvas = div.querySelector('canvas'); if (!canvas) return
    div.dataset.rendered = '1'
    spec.options = Object.assign({ responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: getComputedStyle(document.body).getPropertyValue('--ink') || '#222' } } } }, spec.options || {})
    new window.Chart(canvas, spec)
  } catch (_) { try { div.remove() } catch (__) {} }
}
// Deterministic chart when the user asked for one — no reliance on the model.
// Source the data from the answer's first table, or if there is none, extract
// "label number" pairs straight from the user's request. Then draw it with Chart.js.
const CHART_PALETTE = ['#B0812A', '#12325A', '#3E9E6D', '#BE5238', '#8C651C', '#6E6656']
async function maybeChartFromTable(el, q) {
  try {
    if (!el || el.querySelector('.noria-chart')) return
    let labels = [], datasets = []
    const table = el.querySelector('.tablewrap table')
    if (table) {
      const headers = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim())
      const rows = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()))
      const parseNum = (s) => { const n = parseFloat(String(s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n }
      if (rows.length >= 2 && headers.length >= 2) {
        labels = rows.map((r) => r[0])
        for (let c = 1; c < headers.length; c++) {
          const vals = rows.map((r) => parseNum(r[c]))
          if (vals.filter((v) => v !== null).length >= Math.ceil(rows.length * 0.6)) {
            const color = CHART_PALETTE[datasets.length % CHART_PALETTE.length]
            datasets.push({ label: headers[c] || ('Series ' + c), data: vals.map((v) => (v == null ? 0 : v)), backgroundColor: color, borderColor: color })
          }
        }
      }
    }
    if (!datasets.length && q) {
      // Pull "Label 12,000" / "Label: 12k" pairs out of the user's request.
      const pairs = []; let m; const re = /([A-Za-z][A-Za-z0-9]{0,11})\s*[:=]?\s*\$?(\d[\d,]{2,}(?:\.\d+)?)\s*(k|m|bn|b)?\b/gi
      while ((m = re.exec(q))) { let n = parseFloat(m[2].replace(/,/g, '')); const u = (m[3] || '').toLowerCase(); if (u === 'k') n *= 1e3; else if (u === 'm') n *= 1e6; else if (u === 'b' || u === 'bn') n *= 1e9; if (!isNaN(n)) pairs.push({ label: m[1], value: n }) }
      if (pairs.length >= 2) { labels = pairs.map((p) => p.label); datasets = [{ label: 'Value', data: pairs.map((p) => p.value), backgroundColor: CHART_PALETTE[0], borderColor: CHART_PALETTE[0] }] }
    }
    if (!datasets.length) return
    const type = /\bpie\b|\bdonut\b/i.test(q || '') ? 'doughnut' : (/\bline\b|\btrend\b|over time/i.test(q || '') ? 'line' : 'bar')
    if (type === 'doughnut' && datasets[0]) datasets[0].backgroundColor = labels.map((_, i) => CHART_PALETTE[i % CHART_PALETTE.length])
    const div = document.createElement('div'); div.className = 'noria-chart'
    div.setAttribute('data-spec', JSON.stringify({ type, data: { labels, datasets } }))
    div.innerHTML = '<canvas></canvas>'
    el.appendChild(div)
    await lazyScript('https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.0/chart.umd.min.js')
    renderChart(div)
  } catch (_) {}
}
function scrollDown() { stream.scrollTop = stream.scrollHeight }

function addUser(t, files) {
  if (empty) empty.style.display = 'none'
  stream.classList.remove('is-empty')
  const m = document.createElement('div'); m.className = 'msg user'
  m.innerHTML = '<span class="who">You</span><div class="body"><div class="name">You</div><div class="text"></div></div>'
  m.querySelector('.text').textContent = t
  if (files && files.length) {
    const fr = document.createElement('div'); fr.className = 'ufiles'
    fr.innerHTML = files.map((f) => f.preview
      ? '<span class="uimg"><img src="' + f.preview + '" alt="' + esc(f.name) + '"></span>'
      : '<span class="uf">' + paperclip() + esc(f.name) + '</span>').join('')
    m.querySelector('.body').appendChild(fr)
  }
  thread.appendChild(m); scrollDown()
}
function addNoria() {
  const m = document.createElement('div'); m.className = 'msg noria'
  m.innerHTML = '<span class="who"><img src="assets/noria-f-avatar.png" alt=""></span><div class="body"><div class="name">Noria</div><div class="text"></div></div>'
  thread.appendChild(m); scrollDown(); return m.querySelector('.text')
}

// ── Voice (optional, off by default — a text-first workspace) ─────────────────
let voiceOn = false
const vt = $('voiceToggle')
// Natural neural voice (Cloudflare MeloTTS), with the browser voice as fallback.
const TTS_URL = 'https://noria-ai.insights-skyglobe.workers.dev/tts'
const ttsAudio = new Audio()
// Web Audio playback: decoding each Aura clip into a buffer and playing it through
// one persistent AudioContext is far more reliable on mobile than swapping .src on
// an <audio> element (where the 2nd+ .play() is often rejected → she cut off mid-
// sentence). Same neural voice — only the playback mechanism changes.
let audioCtx = null
let curSrc = null
function ensureCtx() {
  if (audioCtx) return audioCtx
  try { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC() } catch {}
  return audioCtx
}
function stopWebAudio() { try { if (curSrc) { curSrc.onended = null; curSrc.stop() } } catch {} curSrc = null }

// ── Media Session + background audio ──────────────────────────────────────────
// Register Noria's speech as an OS media session so mobile lock-screens show her as
// playing and are less likely to freeze the audio, and keep a silent looping media
// element alive during speech so the tab stays an "active media" tab in the
// background. iOS Safari still aggressively suspends Web Audio on a hard screen lock
// (a true always-on locked voice belongs to the native app), but this keeps her
// playing across app-switches / brief backgrounding and restores instantly on unlock.
let mediaHandlersSet = false
let keepAlive = null // silent looping <audio> that holds the media session open
// Build a guaranteed-valid 1s silent WAV so the keep-alive element actually plays
// (a malformed data URI silently fails and holds nothing open).
function silentWavUrl(seconds = 1) {
  try {
    const sr = 8000, n = sr * seconds, buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf)
    const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true)
    dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true)
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true)
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })) // samples default to 0 = silence
  } catch (_) { return '' }
}
function keepAliveEl() {
  if (keepAlive) return keepAlive
  try {
    const u = silentWavUrl(1)
    if (u) { keepAlive = new Audio(u); keepAlive.loop = true; keepAlive.volume = 0; keepAlive.setAttribute('playsinline', '') }
  } catch {}
  return keepAlive
}
function mediaSessionStart() {
  try {
    // The voice now plays through the ttsAudio media element itself, which IS the
    // media session — no separate keep-alive (two media elements fight on mobile).
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Noria', artist: 'Noria — your AI companion',
      artwork: [{ src: location.origin + '/assets/icon-192.png?v=2', sizes: '192x192', type: 'image/png' }],
    })
    navigator.mediaSession.playbackState = 'playing'
    if (!mediaHandlersSet) {
      mediaHandlersSet = true
      const stopH = () => { stopSpeaking() }
      try { navigator.mediaSession.setActionHandler('pause', stopH) } catch {}
      try { navigator.mediaSession.setActionHandler('stop', stopH) } catch {}
      try { navigator.mediaSession.setActionHandler('play', () => { const c = ensureCtx(); if (c && c.state === 'suspended') c.resume() }) } catch {}
    }
  } catch {}
}
function mediaSessionEnd() {
  try { if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none' } catch {}
}
// When the tab returns to the foreground (unlock / app-switch back), resume the
// context so any queued speech keeps flowing instead of staying silent.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { try { const c = ensureCtx(); if (c && c.state === 'suspended') c.resume() } catch {} }
})
let audioUnlocked = false
function unlockAudio() {
  if (audioUnlocked) return
  audioUnlocked = true
  // Resume the AudioContext inside the user gesture so later chunks play on iOS.
  try { const c = ensureCtx(); if (c && c.state === 'suspended') c.resume() } catch {}
  // Play a silent clip inside the user gesture so the <audio> fallback can play too.
  try { ttsAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='; ttsAudio.play().catch(() => {}) } catch {}
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u) } catch {}
}
window.addEventListener('pointerdown', unlockAudio, { once: true })
let speakGen = 0
function stopSpeaking() { speakGen++; stopWebAudio(); try { ttsAudio.pause() } catch {} mediaSessionEnd(); brain.stopSpeaking() }
// Split cleaned text into <=maxLen chunks at sentence/line boundaries. The trailing
// remainder is always included (force-flush) so the last words are never dropped.
function chunkForSpeech(t, maxLen = 1400) {
  const parts = t.match(/\s*[^.!?;\n]+[.!?;\n]*|\n+/g) || [t]
  const chunks = []; let cur = ''
  for (let s of parts) {
    while (s.length > maxLen) { if (cur) { chunks.push(cur); cur = '' } chunks.push(s.slice(0, maxLen)); s = s.slice(maxLen) }
    if ((cur + s).length > maxLen && cur) { chunks.push(cur); cur = '' }
    cur += s
  }
  if (cur.trim()) chunks.push(cur)
  return chunks.map((c) => c.trim()).filter(Boolean)
}
// Chunks are fetched one at a time (single 1-chunk prefetch), so we never open
// parallel connections. This adds a short backoff-retry purely as defence against
// a transient 429 (rate) or network hiccup on a middle chunk, so a long document
// never drops to the browser voice over one blip.
async function ttsBlob(text) {
  for (let attempt = 0; ; attempt++) {
    let r
    try { r = await fetch(TTS_URL + '?text=' + encodeURIComponent(text)) }
    catch (e) { if (attempt >= 2) throw e; await new Promise((res) => setTimeout(res, 400 + attempt * 500)); continue }
    if (r.ok) return await r.blob()
    if (r.status === 429 && attempt < 2) { await new Promise((res) => setTimeout(res, 600 + attempt * 700)); continue }
    throw new Error('tts ' + r.status)
  }
}
// Play the <audio> MEDIA ELEMENT first: unlike Web Audio (which the OS suspends
// when the tab/app is backgrounded), a media element keeps playing in the
// background — so this is what lets Noria keep talking while the user multitasks.
// It's unlocked on the first tap, so mid-sequence play() is allowed. Web Audio is
// the fallback if the element is ever blocked. `gen` lets a newer speak/stop abort.
// Loudness: the voice is used exactly as it is — same voice, same pace, same tone — but the clips arrive quiet
// (about -22.6 dBFS average, against -16 for a normal assistant), and the player is already at full volume, so the
// only way to a louder voice is a level lift. Each clip is brought up to a steady average level, and any peak that
// would go past full scale is rounded off gently instead of cracking. If anything at all goes wrong, the untouched
// clip plays, so this can never silence her.
const LOUD_RMS = 0.14, LOUD_MAX_GAIN = 2.4
async function loudenBlob(blob) {
  try {
    const ctx = ensureCtx()
    if (!ctx) return blob
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    const ch = buf.getChannelData(0), n = ch.length
    if (!n) return blob
    let ss = 0
    for (let i = 0; i < n; i++) ss += ch[i] * ch[i]
    const rms = Math.sqrt(ss / n)
    if (!(rms > 0.0005) || rms >= LOUD_RMS) return blob
    const gain = Math.min(LOUD_MAX_GAIN, LOUD_RMS / rms)
    const knee = 0.7, out = new DataView(new ArrayBuffer(44 + n * 2))
    const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)) }
    w(0, 'RIFF'); out.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true)
    out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * 2, true)
    out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, n * 2, true)
    for (let i = 0; i < n; i++) {
      let x = ch[i] * gain
      const a = Math.abs(x)
      if (a > knee) x = Math.sign(x) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)))
      out.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x * 32767))), true)
    }
    return new Blob([out], { type: 'audio/wav' })
  } catch (_) { return blob }
}
async function playBlob(blob, gen) {
  blob = await loudenBlob(blob)
  const url = URL.createObjectURL(blob)
  try {
    await new Promise((resolve, reject) => {
      ttsAudio.onended = () => resolve()
      ttsAudio.onerror = () => reject(new Error('audio'))
      try { ttsAudio.pause() } catch {}
      // If she is interrupted (stopSpeaking pauses the element) 'ended' never fires — settle here so the
      // caller (and hands-free voice mode) is released instead of waiting forever.
      ttsAudio.onpause = () => { if (gen !== undefined && gen !== speakGen) resolve() }
      ttsAudio.src = url
      const p = ttsAudio.play()
      if (p && p.catch) p.catch(reject)
    })
    URL.revokeObjectURL(url)
    return
  } catch (_) {
    URL.revokeObjectURL(url)
  }
  // Fallback — Web Audio (foreground only; suspends in background).
  const ctx = ensureCtx()
  if (ctx) {
    try {
      if (ctx.state === 'suspended') { try { await ctx.resume() } catch {} }
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
      if (gen !== undefined && gen !== speakGen) return
      await new Promise((resolve) => {
        const src = ctx.createBufferSource()
        src.buffer = buf
        src.connect(ctx.destination)
        src.onended = () => { if (curSrc === src) curSrc = null; resolve() }
        curSrc = src
        try { src.start(0) } catch (_) { resolve() }
      })
    } catch (_) { /* give up on this chunk */ }
  }
}
// Speak the FULL text (no truncation), same neural voice. Every chunk is fetched
// UP FRONT (pre-buffered) so, once playback starts, the whole response already
// lives in memory — a throttled background tab / locked screen can't stall the
// queue on the network. Chunks then play in strict order through the persistent
// <audio> media element, which keeps running in the background.
async function speakNeural(text) {
  const t = toSpeech(text) // strip markdown/symbols/emoji so the voice never reads them
  if (!t) return
  const gen = ++speakGen
  brain.stopSpeaking()
  const chunks = chunkForSpeech(t)
  if (!chunks.length) return
  let i = 0
  mediaSessionStart() // register her voice as an active media session (background + lock-screen)
  // Kick off ALL chunk fetches immediately (parallel, rotated across Deepgram keys),
  // then await them IN ORDER so playback is sequential and gapless regardless of
  // which fetch finishes first.
  const buffered = chunks.map((c) => ttsBlob(c))
  try {
    for (; i < chunks.length; i++) {
      const blob = await buffered[i]
      if (gen !== speakGen) return // a newer speak() or stopSpeaking() superseded this one
      await playBlob(blob, gen)
      if (gen !== speakGen) return
    }
  } catch (e) {
    // Never go silent: read whatever hasn't been spoken yet with the browser voice.
    if (gen === speakGen) { try { ttsAudio.pause() } catch {} brain.speak(chunks.slice(i).join(' '), {}) }
  } finally {
    if (gen === speakGen) mediaSessionEnd()
  }
}
// Speak WHILE she is still writing: feed() takes the streamed text as it arrives and sends each finished
// sentence to the same neural voice straight away, so the first words are heard after ~1 sentence instead
// of after the whole answer. Sentences play in strict order; end() resolves when the last one has been
// spoken (or she was interrupted). Uses the same ttsBlob / playBlob / speakGen as speakNeural.
function newSpeechStream(onStart) {
  const gen = ++speakGen
  brain.stopSpeaking()
  mediaSessionStart()
  let buf = '', count = 0, chain = Promise.resolve(), started = false
  const enqueue = (raw) => {
    const t = toSpeech(raw.replace(/(^|\n)[ \t]*(?:[-*•]|\d+[.)])[ \t]+/g, '$1')) // list markers ("- ", "1. ") are shown, not spoken
    if (!t) return
    count++
    const blobP = ttsBlob(t); blobP.catch(() => {}) // start fetching right now; awaited in order below
    chain = chain.then(async () => {
      if (gen !== speakGen) return
      try { const blob = await blobP; if (gen !== speakGen) return; if (!started) { started = true; try { onStart && onStart() } catch {} } await playBlob(blob, gen) }
      catch (e) { if (gen === speakGen) { try { ttsAudio.pause() } catch {} brain.speak(t, {}) } } // never go silent
    })
  }
  const drain = (final) => {
    for (;;) {
      const min = count === 0 ? 20 : 45 // first sentence goes out early; later short ones are merged
      let cut = -1, m
      const re = /[.!?]["')\]]*(?=\s)|\n+/g
      while ((m = re.exec(buf))) { const end = m.index + m[0].length; if (end >= min) { cut = end; break } }
      if (cut < 0 && buf.length > 240) { const sp = buf.lastIndexOf(' ', 200); cut = sp > 40 ? sp : 200 } // very long run with no punctuation
      if (cut < 0) break
      enqueue(buf.slice(0, cut)); buf = buf.slice(cut)
    }
    if (final && buf.trim()) { enqueue(buf); buf = '' }
  }
  return {
    feed(d) { buf += d; drain(false) },
    end() { drain(true); return chain.then(() => { if (gen === speakGen) mediaSessionEnd() }) },
  }
}
if (vt) vt.addEventListener('click', () => {
  voiceOn = !voiceOn; vt.classList.toggle('on', voiceOn); vt.title = voiceOn ? 'Voice on' : 'Voice off'
  if (voiceOn) { unlockAudio(); speakNeural('Voice on.') } else stopSpeaking()
})

// ── Voice input (mic) — speak to Noria; auto-sends, and she speaks back ────────
// Hardened so the button can never hang in "Listening…": a `listening` flag plus a
// watchdog that force-resets the UI if the browser's recognizer ever gets stuck
// (mic busy, permission pending, or onend never firing after a start error).
let micRec = null, listening = false, micWatch = null
const micBtn = $('micBtn')
function setRec(on) { if (micBtn) micBtn.classList.toggle('rec', on) }
function endMic() {
  listening = false; micRec = null
  clearTimeout(micWatch); micWatch = null
  setRec(false); input.placeholder = 'Ask Noria anything…'
}
function bumpMicWatch() {
  clearTimeout(micWatch)
  // No speech recognised within 12s → assume a stuck recognizer and reset the UI.
  micWatch = setTimeout(() => { try { micRec && micRec.stop() } catch {} endMic() }, 12000)
}
// Older tap-to-talk path — now only the fallback for browsers that can't do hands-free voice mode.
function legacyMic() {
  if (listening) { try { micRec && micRec.stop() } catch {} endMic(); return } // tap again = stop
  try {
    unlockAudio(); stopSpeaking()
    if (!voiceOn) { voiceOn = true; if (vt) { vt.classList.add('on'); vt.title = 'Voice on' } } // talk → she talks back
    listening = true; setRec(true); input.value = ''; input.placeholder = 'Listening…'; bumpMicWatch()
    let done = false
    const rec = brain.listen({
      onResult: (text) => { input.value = text; grow(); bumpMicWatch() },
      onEnd: (finalText) => {
        if (done) return; done = true
        endMic()
        if (finalText && finalText.trim()) respond(finalText)
      },
    })
    if (!listening) { try { rec && rec.stop() } catch {} return } // onEnd already fired synchronously
    micRec = rec
    if (!rec) { endMic(); note('Voice input needs Chrome or Edge — you can type instead.') }
  } catch (e) { endMic(); note('Could not start the microphone. Check the mic permission, or type instead.') }
}

// ── Hands-free voice mode — one tap in, then she listens, answers, listens again ─
// The ears (voice-activity detection + Whisper) live in brain.converse(); this is just the calm
// full-screen state around it. She never hears herself: the mic is muted while she talks.
const vmEl = $('vmode'), vmOrb = $('vmOrb'), vmState = $('vmState'), vmCap = $('vmCaption')
let vmCtl = null, speechDone = null
const VM_TEXT = { starting: 'Starting…', listening: 'Listening…', hearing: 'Hearing you…', thinking: 'Thinking…', speaking: 'Speaking · tap to interrupt' }
function vmClose() { if (vmEl) vmEl.hidden = true; if (vmOrb) vmOrb.style.removeProperty('--lvl'); if (micBtn) micBtn.classList.remove('rec') }
function endVoiceMode() { if (vmCtl) { try { vmCtl.stop() } catch {} } }
function startVoiceMode() {
  unlockAudio(); stopSpeaking()
  if (!voiceOn) { voiceOn = true; if (vt) { vt.classList.add('on'); vt.title = 'Voice on' } } // talk → she talks back
  if (vmCap) vmCap.textContent = ''
  const ctl = brain.converse({
    onState: (s) => { if (vmEl) vmEl.dataset.state = s; if (vmState) vmState.textContent = VM_TEXT[s] || '' },
    onLevel: (l) => { if (vmOrb) vmOrb.style.setProperty('--lvl', l.toFixed(2)) },
    onHeard: (t) => { if (vmCap) vmCap.textContent = t },
    onUtterance: async (t, c) => {
      speechDone = null
      // In a live voice conversation she answers the way people talk: short and natural, which is also
      // much faster to hear. (Ask for detail and she gives it.)
      await respond(t, { voice: true, system: 'You are in a live spoken conversation. Answer in one to three short, natural sentences (about 40 words at most), the way a person talks. No lists, no headings, no markdown. Only go longer if the user explicitly asks for detail or a full explanation.' }) // shows your words + her answer in the chat
      if (speechDone) { c.mark('speaking'); await speechDone } // wait until she has finished talking
    },
    onEnd: (why) => {
      vmCtl = null; vmClose()
      if (why === 'unsupported' || why === 'stt-failed') { legacyMic(); return } // fall back to the older tap-to-talk
      if (why === 'denied') note('Microphone is blocked. Allow it in your browser settings to talk to Noria — or type instead.')
    },
  })
  if (!ctl) { legacyMic(); return }
  vmCtl = ctl
  if (vmEl) { vmEl.dataset.state = 'starting'; vmEl.hidden = false }
  if (vmState) vmState.textContent = VM_TEXT.starting
  if (micBtn) micBtn.classList.add('rec')
}
// Hands-free voice conversation is a Noria Pro feature; everyone keeps the basic tap-to-talk microphone.
micBtn && micBtn.addEventListener('click', () => { if (vmCtl) endVoiceMode(); else if (isPro) startVoiceMode(); else legacyMic() })
$('vmEnd') && $('vmEnd').addEventListener('click', endVoiceMode)
vmOrb && vmOrb.addEventListener('click', () => { if (vmCtl && vmCtl.state === 'speaking') stopSpeaking() }) // interrupt her
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && vmCtl) endVoiceMode() })

// ── Composer ──────────────────────────────────────────────────────────────────
function syncSend() { send.disabled = busy || (!input.value.trim() && attachments.length === 0) }
function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; syncSend() }
input.addEventListener('input', () => { grow(); cmdOnInput() })
input.addEventListener('keydown', (e) => {
  if (cmdOpen && cmdHandleKey(e)) return // command palette gets arrows / enter / escape first
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); respond(input.value) }
})
send.addEventListener('click', () => respond(input.value))
stop.addEventListener('click', () => { cancelled = true; try { curStream && curStream.abort() } catch {} stopSpeaking() })

// ── Real file upload: text/code direct, PDF via pdf.js, photos via on-device OCR ─
const fileInput = $('file'), attachTray = $('attach')
let attachments = []
$('plus') && $('plus').addEventListener('click', () => fileInput && fileInput.click())
fileInput && fileInput.addEventListener('change', () => { handleFiles([...fileInput.files]); fileInput.value = '' })

function humanSize(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB' }
const _scripts = {}
function lazyScript(src) { return _scripts[src] || (_scripts[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s) })) }
const _styles = {}
function lazyStyle(href) { return _styles[href] || (_styles[href] = new Promise((res) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.onload = res; l.onerror = res; document.head.appendChild(l) })) }

const NORIA_AI = 'https://noria-ai.insights-skyglobe.workers.dev'

// ── Semantic memory (device-scoped, private, free) ────────────────────────────
// Embeddings are computed ON THIS DEVICE (transformers.js / all-MiniLM) and stored
// in IndexedDB — nothing leaves the browser and it uses zero Cloudflare neurons.
// Fully guarded and non-blocking: any failure silently no-ops, never touching chat.
const SMem = (() => {
  let embedder = null, loading = null
  const DB = 'noria-smem', STORE = 'mem', MAX = 600
  function idb() { return new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }) }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }) }
  async function all() { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction(STORE).objectStore(STORE).getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]) }) } catch (_) { return [] } }
  async function put(rec) { try { const db = await idb(); await new Promise((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(rec); tx.oncomplete = res; tx.onerror = res }) } catch (_) {} }
  async function del(id) { try { const db = await idb(); await new Promise((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(id); tx.oncomplete = res; tx.onerror = res }) } catch (_) {} }
  function load() {
    if (loading) return loading
    loading = (async () => {
      const mod = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm')
      mod.env.allowLocalModels = false; mod.env.useBrowserCache = true
      embedder = await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
    })().catch((e) => { loading = null; throw e })
    return loading
  }
  async function embed(text) { await load(); const out = await embedder(text, { pooling: 'mean', normalize: true }); return Array.from(out.data) }
  function cos(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s } // vectors are normalized
  return {
    // Non-blocking recall: if the model isn't loaded yet, kick it off and skip this turn.
    async search(query, k = 3) {
      try {
        if (!embedder) { load().catch(() => {}); return [] }
        const items = await all(); if (!items.length) return []
        const qv = await embed(query)
        return items.map((it) => ({ text: it.text, score: cos(qv, it.v) })).filter((x) => x.score > 0.32).sort((a, b) => b.score - a.score).slice(0, k)
      } catch (_) { return [] }
    },
    // Fire-and-forget store (call without await).
    async add(text) {
      try {
        text = String(text || '').trim(); if (text.length < 12) return
        const v = await embed(text)
        await put({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), text: text.slice(0, 400), v, ts: Date.now() })
        const items = await all(); if (items.length > MAX) { items.sort((a, b) => a.ts - b.ts); for (let i = 0; i < items.length - MAX; i++) await del(items[i].id) }
      } catch (_) {}
    },
    count: async () => (await all()).length,
    ready: () => !!embedder,
    clear: async () => { try { const db = await idb(); await new Promise((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).clear(); tx.oncomplete = res; tx.onerror = res }) } catch (_) {} },
  }
})()
try { window.__smem = SMem } catch (_) {}
async function extractText(file, info) {
  const name = (file.name || '').toLowerCase(), type = file.type || ''
  if (type.startsWith('image/')) {
    // Vision (understands the scene) + OCR (reads exact text) in parallel — most accurate.
    // Understanding the scene (AI vision) is a Noria Pro feature; reading the text in a photo (on-device OCR) stays free.
    const [dv, ov] = await Promise.allSettled([isPro ? describeImage(file) : Promise.reject(new Error('pro')), ocrImage(file)])
    const d = dv.status === 'fulfilled' ? (dv.value || '').trim() : ''
    const o = ov.status === 'fulfilled' ? (ov.value || '').trim() : ''
    let out = ''
    if (d) out += 'Visual description: ' + d
    if (o) out += (out ? '\n\n' : '') + 'Exact text read from the image (OCR): ' + o
    return out || d || o
  }
  if (type === 'application/pdf' || name.endsWith('.pdf')) return await pdfText(file, info)
  if (name.endsWith('.docx') || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return await docxText(file)
  return await file.text()
}
// Word documents (.docx) — long contracts, reports, letters. A .docx is a zip; the words live in word/document.xml.
async function docxText(file) {
  await lazyScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js')
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer())
  const part = zip.file('word/document.xml')
  if (!part) throw new Error('docx: not a Word document')
  const xml = await part.async('string')
  const ent = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }
  return xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:tc>/g, ' | ').replace(/<\/w:tr>/g, '\n').replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => ent[m]).replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
// Real photo understanding via Cloudflare Workers AI (llava) — the Body's vision.
async function describeImage(file) {
  const blob = await downscale(file, 1024)
  const r = await fetch(NORIA_AI + '/vision?prompt=' + encodeURIComponent('Describe this image in detail: read any visible text exactly, and describe the objects, people, setting, colors and notable details.') + proParam(), { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob })
  const j = await r.json()
  if (j.error) throw new Error(j.error)
  return (j.text || '').trim()
}
async function downscale(file, max) {
  try {
    const img = await createImageBitmap(file)
    const s = Math.min(1, max / Math.max(img.width, img.height))
    const w = Math.round(img.width * s), h = Math.round(img.height * s)
    const c = document.createElement('canvas'); c.width = w; c.height = h
    c.getContext('2d').drawImage(img, 0, 0, w, h)
    return await new Promise((res) => c.toBlob((b) => res(b || file), 'image/jpeg', 0.85))
  } catch { return file }
}
async function pdfText(file, info) {
  await lazyScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js')
  const pdfjs = window.pdfjsLib
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
  let out = ''
  const limit = Math.min(doc.numPages, isPro ? 200 : 40)
  if (info) { info.pages = doc.numPages; info.readPages = limit }
  for (let p = 1; p <= limit; p++) { const pg = await doc.getPage(p); const tc = await pg.getTextContent(); out += tc.items.map((i) => i.str).join(' ') + '\n' }
  return out.trim()
}
async function ocrImage(file) {
  await lazyScript('https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js')
  const { data } = await window.Tesseract.recognize(file, 'eng')
  return ((data && data.text) || '').trim()
}
function paperclip() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8.5 12.6 17a4 4 0 0 1-5.7-5.7l8-8a2.5 2.5 0 0 1 3.5 3.5l-8 8a1 1 0 0 1-1.4-1.4l7.3-7.3"/></svg>' }
// Noria's internal state object (spoken_text, display_text, emotion, memory) is never shown or spoken: if a model
// answers in that shape, only the words meant for the person are kept.
const META_RX = /^\s*(?:```(?:json)?\s*)?\{\s*"(?:spoken_text|display_text|emotion|voice_tone|reply|conversation_action)"/
const looksMeta = (t) => META_RX.test(t || '')
function cleanMeta(t) {
  if (!looksMeta(t)) return t
  const str = (k) => {
    const m = new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)').exec(t)
    if (!m) return ''
    try { return JSON.parse('"' + m[1] + '"') } catch (_) { return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') }
  }
  try { const o = JSON.parse(t.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '')); return String(o.display_text || o.reply || o.spoken_text || '').trim() } catch (_) {}
  return (str('display_text') || str('reply') || str('spoken_text')).trim()
}
// How much of an attached document is read: the opening pages on the free plan, the whole document on Noria Pro
// (about 90 pages of text; PDFs up to 200 pages). The paperclip chip always says exactly how much was read.
const DOC_FREE = 6000, DOC_PRO = 600000, DOC_PRO_TOTAL = 600000, CHARS_PER_PAGE = 3000
// What is sent to the brain per question. The whole document is held on the device; when it is longer than this the
// most relevant passages are picked locally (see docExcerpts), so a 60-page file costs the same as a 4-page one.
const DOC_SEND = 14000
const docCap = () => (isPro ? DOC_PRO : DOC_FREE)
const pagesOf = (chars) => Math.max(1, Math.round(chars / CHARS_PER_PAGE))
function docCut(a) { const cap = docCap(), n = (a.text || '').length, p = a.info && a.info.pages ? a.info : null; return n > cap || !!(p && p.pages > p.readPages) }
function readNote(a) {
  if (a.loading || a.preview || !a.text) return ''
  const n = a.text.length, p = a.info && a.info.pages ? a.info : null
  if (!docCut(a)) return (isPro && n > DOC_SEND ? ' · whole document searched' : ' · read in full') + (p ? ' (' + p.pages + ' pages)' : n > CHARS_PER_PAGE ? ' (~' + pagesOf(n) + ' pages)' : '')
  const total = p ? p.pages : pagesOf(n), read = Math.min(total, pagesOf(Math.min(n, docCap())))
  return ' · first ~' + read + ' of ' + total + ' pages'
}
function readNotice(a) {
  if (!docCut(a)) return
  note(isPro ? '“' + a.name + '” is very long — the first ~' + pagesOf(docCap()) + ' pages will be read.' : 'Only the first ~' + pagesOf(docCap()) + ' pages of “' + a.name + '” will be read. Noria Pro reads whole documents.')
}
// ── Long documents: kept whole on the device, searched locally ──
// The document is cut into overlapping passages and the ones that answer the question are sent, in reading order,
// with their approximate page. Nothing is guessed on the server and nothing is silently dropped: Noria is told it
// is looking at selected passages, so she says so when a question needs every page (for example an exact count).
const STOP = new Set('the and for are but not you all any can had her was one our out has have this that with from they been were what when where which who how why does did will would could should about into than then them these those there their your yours its also just more most some such only over very much many may might shall of to in on at by an as is it be or if so we he she me my do no'.split(' '))
function docTokens(t) {
  const out = [], m = String(t).toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}\-_.']*/gu) || []
  for (let w of m) {
    w = w.replace(/^[-_.']+|[-_.']+$/g, ''); if (!w) continue
    if (!STOP.has(w) && (w.length > 2 || /\d/.test(w))) out.push(w)
    if (/[-_.']/.test(w)) for (const x of w.split(/[-_.']+/)) if (x && !STOP.has(x) && (x.length > 2 || /\d/.test(x))) out.push(x)
  }
  return out
}
function docChunks(text) {
  const size = 1400, over = 200, chunks = []
  let i = 0
  while (i < text.length) {
    let end = Math.min(text.length, i + size)
    if (end < text.length) { const cut = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf('. ', end)); if (cut > i + size * 0.6) end = cut + 1 }
    chunks.push({ at: i, text: text.slice(i, end).trim() })
    if (end >= text.length) break
    i = Math.max(end - over, i + 1)
  }
  return chunks.filter((c) => c.text)
}
const OVERVIEW_RX = /\b(summari[sz]e|summary|overview|outline|main points?|key points?|key takeaways?|table of contents|structure|what is (this|it) about|what does (this|it) say|gist|tl;?dr|whole (document|thing|file)|entire (document|file|paper|contract|report))\b/i
function docExcerpts(text, q, budget) {
  const chunks = docChunks(text), N = chunks.length, pageOf = (c) => Math.floor(c.at / CHARS_PER_PAGE) + 1
  const per = Math.max(2, Math.floor(budget / 1500)) // how many passages fit
  let picked
  if (OVERVIEW_RX.test(q) || !docTokens(q).length) { // a question about the whole thing: spread evenly across every page
    const k = Math.min(N, Math.max(per, Math.floor(budget / 700))), idx = new Set([0])
    for (let j = 0; j < k; j++) idx.add(Math.min(N - 1, Math.round((j * (N - 1)) / Math.max(1, k - 1))))
    picked = [...idx].sort((a, b) => a - b).map((i) => ({ i, cut: Math.floor(budget / idx.size) }))
  } else { // a question about something specific: the passages that mention it
    const qt = [...new Set(docTokens(q))], df = {}, tok = chunks.map((c) => docTokens(c.text))
    tok.forEach((ts) => { for (const t of new Set(ts)) df[t] = (df[t] || 0) + 1 })
    const avg = tok.reduce((n, t) => n + t.length, 0) / N || 1
    const sc = tok.map((ts, i) => {
      const tf = {}; for (const t of ts) tf[t] = (tf[t] || 0) + 1
      let s = 0
      for (const t of qt) { if (!tf[t]) continue; const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5)); s += idf * (tf[t] * 2.2) / (tf[t] + 1.2 * (0.25 + 0.75 * ts.length / avg)) }
      return { i, s }
    })
    picked = sc.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, per - 1).map((x) => ({ i: x.i, cut: 1500 }))
    if (!picked.some((x) => x.i === 0)) picked.push({ i: 0, cut: 900 }) // the opening always frames the rest
    picked.sort((a, b) => a.i - b.i)
  }
  const body = picked.map(({ i, cut }) => '[≈ page ' + pageOf(chunks[i]) + ']\n' + chunks[i].text.slice(0, cut)).join('\n…\n')
  return { body, count: picked.length, total: N }
}
// The text of the attached files as sent to the brain, each within its share of the reading allowance.
function attachmentContext(atts, q) {
  let budget = isPro ? DOC_PRO_TOTAL : Infinity
  const full = atts.reduce((n, a) => n + Math.min((a.text || '').length, docCap()), 0)
  return atts.map((a) => {
    const t = a.text.slice(0, Math.max(0, Math.min(docCap(), budget))); budget -= t.length
    if (isPro && !a.preview && full > DOC_SEND && t.length > DOC_SEND / atts.length) {
      const share = Math.floor(DOC_SEND / atts.length), ex = docExcerpts(t, q || '', share)
      return `[File: ${a.name} — a long document (about ${pagesOf(t.length)} pages). To stay fast, ${ex.count} passages that best match the question are shown below, in reading order with their approximate page. You are looking at selected passages, not every page: if the question needs something you cannot see here (an exact count, a total, or a passage that is not shown), say so plainly instead of guessing, and invite the user to ask about a specific section.]
${ex.body}`
    }
    return `[${a.preview ? 'Image' : 'File'}: ${a.name}]\n${t}`
  }).join('\n\n')
}
function renderTray() {
  attachTray.hidden = attachments.length === 0
  attachTray.innerHTML = ''
  attachments.forEach((a) => {
    const chip = document.createElement('div'); chip.className = 'chip' + (a.loading ? ' loading' : '')
    chip.innerHTML = (a.loading ? '<span class="spin"></span>' : paperclip()) +
      '<span class="nm">' + esc(a.name) + '</span><span class="sz">' + (a.loading ? 'reading…' : humanSize(a.size) + readNote(a)) + '</span>'
    if (!a.loading) {
      const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.setAttribute('aria-label', 'Remove')
      x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      x.addEventListener('click', () => { attachments = attachments.filter((z) => z.id !== a.id); renderTray(); syncSend() })
      chip.appendChild(x)
    }
    attachTray.appendChild(chip)
  })
}
async function handleFiles(files) {
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) { note('“' + file.name + '” is too large (max 20 MB).'); continue }
    const a = { id: Math.random().toString(36).slice(2), name: file.name || 'file', size: file.size, text: '', loading: true, preview: (file.type || '').startsWith('image/') ? URL.createObjectURL(file) : null }
    attachments.push(a); renderTray(); syncSend()
    try {
      const info = {}
      a.text = (await extractText(file, info)) || ''; a.info = info
      if (!a.text.trim()) { a.text = ''; note('I couldn’t find readable text in “' + file.name + '”.') }
      else if (!a.preview) readNotice(a)
    } catch (e) {
      note('I couldn’t read “' + file.name + '”. ' + (/tesseract|image/i.test(e.message) ? 'Photo reading is unavailable right now.' : /pdf/i.test(e.message) ? 'PDF reading is unavailable right now.' : ''))
      attachments = attachments.filter((z) => z.id !== a.id)
    }
    a.loading = false; renderTray(); syncSend()
  }
}
function note(t) { status.textContent = t; setTimeout(() => { if (status.textContent === t) status.textContent = '' }, 4500) }

// Always-on document-quality directive (applies to ANY document Noria produces —
// guide chip or typed in chat) so nothing ever comes out with fill-in-the-blank
// placeholders. The guide flow adds the fuller DOC_RULES on top of this.
const DOC_QUALITY = '\n\n[WHEN YOU PRODUCE A DOCUMENT (CV, plan, letter, report, roadmap, guide, proposal, etc.): make it FINISHED and ready to use. Do NOT leave fill-in-the-blank placeholders — never write square-bracket placeholders like [Company] or [Degree], and never write parenthetical instructions like (insert...), (add...), (list...). Use only the real details the user gave; if a section cannot be completed from them, omit it rather than padding it, and if essential information is genuinely missing, end with a single short "## To complete before you send this" list. Begin directly with the document itself (its title) — no "Here is..." or "Sure," preamble and no sign-off like "I hope this helps". Use Markdown headings (##, ###) for structure and, for comparisons, figures or timelines, clean Markdown tables. Never output broken or raw tags.]'
// The chat renders rich content — tell the model exactly how to emit it so charts,
// math and code come out live and correct (client-side, KaTeX/Chart.js/highlight.js).
const RICH_OUTPUT = '\n\n[RICH OUTPUT you can render: (1) CHARTS — to visualise data (comparisons, trends, budgets, breakdowns), emit a fenced block tagged "chart" holding a VALID minimal Chart.js JSON config, e.g. ```chart {"type":"bar","data":{"labels":["Q1","Q2","Q3"],"datasets":[{"label":"Revenue","data":[12,19,15]}]}} ``` — valid JSON only, no comments or trailing commas. If the user asks to "chart", "graph", "plot", "visualise" or "show a chart of" data, you MUST include a ```chart block. Prefer a chart whenever numbers compare better visually; you may also give the table. (2) MATH — write formulas in LaTeX with \\( ... \\) for inline and $$ ... $$ for display. NEVER use a single $ for math — a lone $ means currency (e.g. $45,000). (3) CODE — put code in fenced blocks tagged with the language (```python, ```js). Use these only when they genuinely help.]'

// ── A turn: real engine + presence-shaped delivery ────────────────────────────
async function respond(q, opts = {}) {
  q = (q || '').trim()
  const atts = attachments.filter((a) => !a.loading && a.text)
  if ((!q && atts.length === 0) || busy) return
  const shown = opts.display || q || ('Please read the attached ' + (atts.length > 1 ? 'files' : 'file') + ' and help me with it.')
  if (!q) q = shown
  busy = true; send.disabled = true; cancelled = false
  addUser(shown, atts.map((a) => ({ name: a.name, preview: a.preview })))
  convoRecord({ role: 'user', text: shown, files: atts.map((a) => a.name) })
  attachments = []; renderTray()
  input.value = ''; grow()

  // Image generation branch — "draw/create an image of…" (like Gemini).
  if (!atts.length && isImageRequest(q)) {
    if (!isPro) { // creating images is a Noria Pro feature
      const el = addNoria(); const note = 'Creating images is part of Noria Pro. You can unlock it with an early-access code — I’m happy to help with anything else in the meantime.'
      el.textContent = note; convoRecord({ role: 'noria', text: note }); finish(); openPro('Creating images is part of Noria Pro.'); return
    }
    if (realPersonImage(q)) { // says why, and offers what does help — it is not a bare refusal
      const el = addNoria()
      const note = 'I don’t create realistic pictures of real people. An AI-made face would only be a stranger with their name attached, and that can mislead. For the real person, the official website or a news photo is the reliable source. I can make an illustration of a leader in general, a scene, a flag-themed poster or anything else you have in mind — just tell me what you would like.'
      el.textContent = note; convoRecord({ role: 'user', text: q }); convoRecord({ role: 'noria', text: note }); finish(); return
    }
    await generateImage(cleanImagePrompt(q)); finish(); return
  }

  // Attached file/image content — goes into the SYSTEM context (engine caps the
  // query at 2000 chars), so the user's question stays short.
  const attBlock = atts.length ? '\n\n[ATTACHED BY THE USER — use this to answer their question]\n' + attachmentContext(atts, q) : ''

  // Live web grounding (like Gemini). Either the heuristic fires for current/world
  // questions, or a caller supplies an explicit search query (opts.web) — used by
  // guided documents to stay current (deprecated tools, live pricing, local data).
  let webBlock = '', sources = []
  // Live facts are handled by the server's grounding engine (it decides, retrieves from every source, verifies the answer and
  // returns the sources). Only a guided document, which supplies its own search phrase, still searches from here.
  const webQuery = (opts.web && String(opts.web).trim()) || ''
  if (webQuery && atts.length === 0) {
    status.innerHTML = DOTS + ' Searching the web'
    try {
      // Bounded: a slow/stalled search must never hang the whole reply — after 7s
      // we give up on grounding and answer from knowledge instead of spinning.
      const ac = new AbortController()
      const to = setTimeout(() => ac.abort(), 7000)
      const r = await fetch('/search?q=' + encodeURIComponent(webQuery.slice(0, 300)), { signal: ac.signal })
      clearTimeout(to)
      const j = await r.json()
      sources = (j.results || []).slice(0, 5)
      if (sources.length) webBlock = '\n\n[LIVE WEB RESULTS — retrieved ' + new Date().toDateString() +
        ' (this is TODAY). Treat these as current, authoritative fact and prefer them over your training when they disagree. Anything described here in the past tense HAS ALREADY HAPPENED as of today — never say an event "has not happened yet" or that you are "not sure" of an outcome the results state. CRITICAL: when asked for the latest/current/most recent state of something, answer from the MOST RECENTLY DATED item here and state its date — never present an older item as the current situation when a newer one exists; if results conflict, the newest date wins. Synthesize STRICTLY from these facts: if they are thin, conflicting, or do not contain the exact answer, say plainly "I\'m not certain based on current live data" rather than extrapolating or inventing anything.]\n' +
        sources.map((s, i) => `(${i + 1}) ${s.title}: ${(s.snippet || '').slice(0, 320)} — ${s.url}`).join('\n')
    } catch {}
  }

  // Recall relevant on-device memories (non-blocking; silently skips until the
  // embedding model has loaded in the background).
  let memBlock = ''
  try { const mems = await (opts.voice ? Promise.race([SMem.search(q), new Promise((r) => setTimeout(() => r([]), 400))]) : SMem.search(q)); if (mems.length) memBlock = '\n\n[MEMORY — things the user told you in earlier conversations (private, on this device). Treat these as true and use them when relevant to answer; do not deny knowing something that is here. Do not list them back verbatim.]\n' + mems.map((m) => '- ' + m.text).join('\n') } catch (_) {}

  const plan = presence.beginTurn({ userText: q }) // emotional state, delivery, memory, check-in
  stop.style.display = 'inline-flex'
  let started = false
  status.innerHTML = '' // 0–400ms: stay still
  const tDots = setTimeout(() => { if (!started && !cancelled) status.innerHTML = DOTS }, 400)
  const t2 = setTimeout(() => { if (!started && !cancelled) status.innerHTML = DOTS + ' Noria is preparing a response' }, 2000)
  const t8 = setTimeout(() => { if (!started && !cancelled) status.innerHTML = 'This is taking longer than usual.' }, 8000)
  const clearTimers = () => { clearTimeout(tDots); clearTimeout(t2); clearTimeout(t8) }

  try {
    const kb = retrieveKnowledge(q)
    const systemCommon = memoryContext(mem) +
      (kb ? `\n\n[BACKGROUND KNOWLEDGE — vetted reference notes. Prefer these where they apply, and follow all safety rules]\n${kb}` : '') +
      DOC_QUALITY + RICH_OUTPUT +
      (opts.system ? '\n\n' + opts.system : '') +
      memBlock + attBlock + webBlock

    started = true; clearTimers()
    if (cancelled) { finish(); return }
    if (!opts.voice) await new Promise((r) => setTimeout(r, plan.delivery.firstBeatDelayMs || 200)) // a pause that suits typing, not a spoken back-and-forth
    const el = addNoria()

    // Stream the visible answer word-by-word (like Gemini). Plain-markdown output so
    // tokens can appear live; renderMd formats it fully once the stream completes.
    let acc = '', raf = 0
    const paint = () => { raf = 0; if (looksMeta(acc)) return; el.textContent = acc; scrollDown() }
    // With the voice on, she starts SPEAKING as the answer is written (first finished sentence), not after it.
    let sp = null
    curStream = new AbortController()
    let askRes = null
    try {
      askRes = await brain.ask(q, {
        system: noriaSystem({ json: false, topic: q + ' ' + (brain.history || []).slice(-4).map((m) => m.content).join(' ') }) + systemCommon,
        signal: curStream.signal,
        // If the client already grounded (webBlock present), skip a server search;
        // otherwise let the router decide — a second layer so live facts aren't missed.
        ground: webBlock ? false : 'auto',
        voice: !!opts.voice, // spoken turns: the brain answers briefly and with less deliberation
        onToken: (d) => {
          if (cancelled) return
          acc += d; if (!raf) raf = requestAnimationFrame(paint)
          if (voiceOn && !opts.doc && !looksMeta(acc)) { if (!sp) sp = newSpeechStream(opts.voice ? () => { if (vmCtl) vmCtl.mark('speaking') } : null); sp.feed(d) }
        },
      })
    } catch (streamErr) {
      // A stream failure must never lose the answer: fall back to the structured path.
      if (!acc.trim() && !cancelled) {
        try { const r = await brain.ask2(q, { system: noriaSystem({ json: false, topic: q + ' ' + (brain.history || []).slice(-4).map((m) => m.content).join(' ') }) + systemCommon }); acc = r.display || r.spoken || ''; if (!sources.length && Array.isArray(r.sources)) sources = r.sources.filter((x) => x && x.url).slice(0, 5) } catch (_) {}
      }
    } finally { curStream = null }
    if (!sources.length && askRes && Array.isArray(askRes.sources)) sources = askRes.sources.filter((x) => x && x.url).slice(0, 5)
    // An answer that has lost its thread is never shown: ask again through the guarded path.
    if (acc && !cancelled && brain.isRambling && brain.isRambling(acc)) {
      acc = ''; try { const r = await brain.ask2(q, { system: noriaSystem({ json: false, topic: q + ' ' + (brain.history || []).slice(-4).map((m) => m.content).join(' ') }) + systemCommon }); acc = r.display || '' } catch (_) {}
    }
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    if (cancelled) { if (!acc.trim()) el.closest('.msg').remove(); else renderMd(el, acc); finish(); return }

    // Any document — guide chip or typed in chat — must come out finished: strip any
    // placeholder scaffolding from a document-like answer.
    let display = cleanMeta(acc)
    // Nothing came back: a busy moment usually clears in seconds, so she quietly tries once more, and only then says so.
    if (!display.trim() && !cancelled && q.length < 20000) {
      await new Promise((r) => setTimeout(r, 2500))
      try { const r = await brain.ask2(q, { system: noriaSystem({ json: false, topic: q + ' ' + (brain.history || []).slice(-4).map((m) => m.content).join(' ') }) + systemCommon }); acc = r.display || ''; display = cleanMeta(acc); if (display && brain.isRambling && brain.isRambling(display)) display = '' } catch (_) {}
    }
    if (!display.trim()) {
      // Keep the thread: the next message ("why?", "try again") must know what was being asked.
      try { brain.history.push({ role: 'user', content: q }, { role: 'assistant', content: '(I could not answer that one — a technical hiccup on my side.)' }) } catch (_) {}
      const big = q.length > 20000
      display = big
        ? "I couldn't finish reading that just now: it is a lot to take in at once and I'm busy. Please try again in a minute, or ask about one section at a time."
        : "I couldn't answer that just now. Please try again in a moment."
    }
    const isDocLike = display && (/^#{1,3}\s/m.test(display) || /^\s*\|.*\|\s*$/m.test(display) || /\[[^\]\n]{1,80}\]|\((?:insert|add|list|your |e\.g\.)/i.test(display))
    const dsp = ((opts.doc || isDocLike) && display) ? cleanDocText(display) : display
    renderMd(el, dsp)
    // If the user asked to see a chart and Noria answered with a data table,
    // draw the chart from that table (deterministic — no reliance on the model).
    if (/\b(chart|graph|plot|bar chart|pie chart|line chart|visuali[sz]e)\b/i.test(q)) maybeChartFromTable(el, q)
    if (sources.length) addSources(el.closest('.msg'), sources) // sources read first (the trust signal), then the actions
    addFeedback(el.closest('.msg'), q, dsp)
    convoRecord({ role: 'noria', text: dsp, sources: sources.map((s) => ({ url: s.url })) })
    if (!opts.doc && !/\?\s*$/.test(shown)) SMem.add(shown) // remember the user's statements (not questions); device-only, fire-and-forget
    const sug = presence.suggestMemory(q)
    if (sug) suggestMemory(sug.value)
    if (sp && voiceOn) speechDone = sp.end() // she has been speaking as it streamed; wait for the last sentence
    else if (voiceOn && dsp) speechDone = speakNeural(dsp) // speakNeural strips markdown/symbols internally
    savePresence()
  } catch (e) {
    started = true; clearTimers()
    const el = addNoria(); el.closest('.msg').classList.add('err')
    el.textContent = "Noria couldn't respond. Check your connection and try again."
    convoRecord({ role: 'err', text: "Noria couldn't respond. Check your connection and try again." })
  } finally {
    finish()
  }
}
function finish() { busy = false; stop.style.display = 'none'; status.textContent = ''; grow() }

// Reveal ready text in quick chunks (content already generated — a display reveal,
// not a fake typing indicator).
function reveal(el, text) {
  return new Promise((res) => {
    const words = String(text).split(/(\s+)/); let i = 0
    const caret = document.createElement('span'); caret.className = 'caret'
    ;(function tick() {
      if (cancelled) { el.textContent = words.slice(0, i).join(''); res(); return }
      if (i < words.length) {
        el.textContent = words.slice(0, i + 1).join(''); el.appendChild(caret)
        i += Math.random() < 0.4 ? 3 : 2; scrollDown()
        setTimeout(tick, 12 + Math.random() * 22)
      } else { res() }
    })()
  })
}

// ── Image generation (Cloudflare Workers AI / SDXL) ───────────────────────────
function isImageRequest(q) {
  const s = q.toLowerCase().trim()
  return /\b(draw|paint|sketch|render|generate|create|make|design|produce|imagine|show me|show us|give me|get me|send me|i want|i need|i'd like|can you (?:show|give|make|draw|create|generate)|could you (?:show|give|make|draw|create|generate)|let me see|display)\b[^.?!]*\b(image|images|picture|pictures|pic|photo|photos|photograph|art|artwork|illustration|drawing|painting|logo|poster|wallpaper|portrait|scene|icon)\b/.test(s) ||
    /^(an?\s+)?(image|picture|photo|drawing|painting|illustration|logo|portrait)\s+of\s+/.test(s) ||
    /^(please\s+)?(can you |could you |i want you to )?(draw|paint|sketch|illustrate)\s+(me\s+)?(an?|the|some|my)\s+\w+/.test(s)
}
// A picture request that points at a real person: a role held by someone ("the president of Ghana"), a pronoun for someone just
// discussed ("a photo of him"), or a full name written with capitals ("a picture of Nana Addo").
function realPersonImage(q) {
  const s = String(q || '')
  if (/\b(president|vice[- ]president|prime minister|minister|governor|mayor|senator|king|queen|emperor|chancellor|speaker|chief justice|ceo|chairman)\b[^.?!]{0,20}\b(of|for|in)\s+(?:the\s+)?[A-Z][a-z]/.test(s)) return true
  if (/\b(of|for)\s+(him|her|them|his|hers)\b|\b(his|her)\s+(image|picture|photo|portrait|face)\b|\b(him|her)\s*$/i.test(s)) return true
  return /\b(?:of|for|showing)\s+(?:the\s+)?(?:(?:Mr|Mrs|Ms|Dr|Prof|President|Nana|Hon|Chief|Sir|Dame)\.?\s+)?[A-Z][a-z]+\s+(?:[A-Z][a-z]+\s+)?[A-Z][a-z]{2,}\b/.test(s.replace(/^\s*(?:please\s+)?/i, ''))
}
function cleanImagePrompt(q) {
  const p = q.replace(/^\s*(please\s+)?(can you\s+|could you\s+|i want you to\s+|i'd like you to\s+)?(draw|paint|sketch|render|generate|create|make|design|produce|imagine|show me)\s+(me\s+)?(an?\s+|the\s+|some\s+)?(image|picture|photo|photograph|art|artwork|illustration|drawing|painting|logo|poster|wallpaper|portrait)\s*(of\s+|showing\s+|depicting\s+|with\s+)?/i, '').trim()
  return p || q
}
async function generateImage(prompt) {
  stop.style.display = 'inline-flex'
  status.innerHTML = DOTS + ' Creating your image'
  const el = addNoria()
  try {
    const r = await fetch(NORIA_AI + '/image?prompt=' + encodeURIComponent(prompt) + proParam())
    if (r.status === 429) { let m = ''; try { m = (await r.json()).message || '' } catch (_) {} const e = new Error('image allowance'); e.friendly = m || 'The free image allowance for today is used up. It resets at midnight UTC.'; throw e }
    if (!r.ok) throw new Error('image gen failed (' + r.status + ')')
    const blob = await r.blob()
    if (cancelled) { el.closest('.msg').remove(); return }
    const url = URL.createObjectURL(blob)
    el.innerHTML = ''
    const fig = document.createElement('div'); fig.className = 'genimg'
    const img = document.createElement('img'); img.src = url; img.alt = prompt
    const cap = document.createElement('div'); cap.className = 'cap'; cap.textContent = prompt
    const dl = document.createElement('a'); dl.className = 'dl'; dl.href = url; dl.download = 'noria-image.png'; dl.textContent = 'Download'
    fig.append(img, cap, dl); el.appendChild(fig); scrollDown()
    const thumb = await blobToThumb(blob, 512).catch(() => '')
    convoRecord({ role: 'noria', img: thumb || url, cap: prompt })
  } catch (e) {
    el.closest('.msg').classList.add('err')
    const failMsg = (e && e.friendly) || "I couldn't create that image just now. Please try again in a moment."
    el.textContent = failMsg
    convoRecord({ role: 'err', text: failMsg })
  }
}
async function blobToThumb(blob, max) {
  const img = await createImageBitmap(blob)
  const s = Math.min(1, max / Math.max(img.width, img.height))
  const w = Math.round(img.width * s), h = Math.round(img.height * s)
  const c = document.createElement('canvas'); c.width = w; c.height = h
  c.getContext('2d').drawImage(img, 0, 0, w, h)
  return c.toDataURL('image/jpeg', 0.82)
}

// ── Live web grounding helpers ────────────────────────────────────────────────
function needsWeb(q) {
  const s = q.toLowerCase()
  // Don't waste a web search on creative / code / math / translation / rewriting tasks.
  if (/\b(write|compose|draft|poem|story|essay|lyrics|code|function|refactor|debug|translate|solve|calculate|rephrase|reword|summar(y|ize|ise)|brainstorm|pretend|role-?play)\b/.test(s)) return false
  // Time-sensitive / world information → verify with the live web.
  if (/\b(today|tonight|now|current|currently|latest|recent|recently|news|headline|price|cost of|stock|market|weather|forecast|score|standings|update|upcoming|schedule|release date|this (year|week|month|morning)|as of|202[4-9]|203\d)\b/.test(s)) return true
  // Factual lookups that benefit from verification → ground them.
  if (/\b(who is|who are|who was|who won|who's|whos|when is|when was|when does|when did|where is|where was|how many|how much (is|are|was|does|do)|what happened|latest on|population of|capital of|founded|founder of|ceo of|president of|prime minister of|born|died|record for|according to|statistics|how old|how tall|how far|distance (from|between))\b/.test(s)) return true
  // Fact-checks / verification → always confirm against real sources.
  if (/\b(is it true|is that true|is this true|is .+ real|fact.?check|fact check|verify|confirm (that|whether)|did .+ really|really (happen|happened|die|died|say|said)|true or false|how accurate)\b/.test(s)) return true
  // Common "what's going on with X" phrasings → ground them.
  if (/\b(what'?s (new|happening|going on|the latest)|any news|tell me (the latest|about the (latest|newest|current))|how is .+ (doing|going|performing)|what did .+ (say|announce|release|launch))\b/.test(s)) return true
  return false
}
const GLOBE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.7 3.9 5.7 3.9 9s-1.3 6.3-3.9 9c-2.6-2.7-3.9-5.7-3.9-9S9.4 5.7 12 3z"/></svg>'
function addSources(msg, sources) {
  if (!msg) return
  const seen = new Set(), items = []
  for (const s of sources) {
    let host = ''; try { host = new URL(s.url).hostname.replace(/^www\./, '') } catch {}
    if (!host || seen.has(host)) continue
    seen.add(host); items.push({ host, url: s.url })
    if (items.length >= 4) break
  }
  if (!items.length) return
  const wrap = document.createElement('div'); wrap.className = 'sources'
  wrap.innerHTML = '<div class="src-lab">Sources</div>'
  const row = document.createElement('div'); row.className = 'src-row'
  items.forEach(({ host, url }) => {
    const a = document.createElement('a'); a.className = 'src'; a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'
    // A neutral globe shows first; the site's own icon replaces it only if our server finds a real one
    // (unknown sites answer 404, so the globe simply stays).
    const ico = document.createElement('span'); ico.className = 'src-ico'; ico.innerHTML = GLOBE_SVG
    const probe = new Image(); probe.alt = ''
    probe.onload = () => { ico.innerHTML = ''; ico.appendChild(probe) }
    probe.src = '/favicon?host=' + encodeURIComponent(host)
    const label = document.createElement('span'); label.textContent = host
    a.append(ico, label)
    row.appendChild(a)
  })
  wrap.appendChild(row); msg.querySelector('.body').appendChild(wrap)
}

// ── Feedback → the engine's review pipeline ───────────────────────────────────
function addFeedback(msg, q, a) {
  if (!msg) return
  const bar = document.createElement('div'); bar.className = 'fb'
  const UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v10H4V10zM7 10l4.2-7.4a2 2 0 0 1 1.8 2.9L12 8h6.3a2 2 0 0 1 2 2.4l-1.3 6.4A2 2 0 0 1 17 20H7"/></svg>'
  const DN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V4h3v10zM17 14l-4.2 7.4a2 2 0 0 1-1.8-2.9L12 16H5.7a2 2 0 0 1-2-2.4l1.3-6.4A2 2 0 0 1 7 4h10"/></svg>'
  const mk = (label, rating, title) => {
    const b = document.createElement('button'); b.type = 'button'; b.innerHTML = label; b.title = title; b.setAttribute('aria-label', title)
    b.addEventListener('click', () => { brain.sendFeedback(rating, q, a); bar.querySelectorAll('button').forEach((x) => x.disabled = true); b.classList.add('on') })
    return b
  }
  bar.append(mk(UP, 'up', 'Good response'), mk(DN, 'down', 'Bad response'))
  // Copy button (like ChatGPT/Gemini)
  const COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>'
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>'
  const cp = document.createElement('button'); cp.type = 'button'; cp.title = 'Copy'; cp.setAttribute('aria-label', 'Copy'); cp.innerHTML = COPY
  cp.addEventListener('click', async () => {
    const text = (a && a.trim()) || (msg.querySelector('.text') ? msg.querySelector('.text').textContent : '')
    try { await navigator.clipboard.writeText(text) }
    catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy') } catch {} ta.remove() }
    cp.innerHTML = CHECK; cp.classList.add('on'); setTimeout(() => { cp.innerHTML = COPY; cp.classList.remove('on') }, 1400)
  })
  bar.append(cp)
  // Download PDF (Pro feature)
  const PDF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>'
  const pd = document.createElement('button'); pd.type = 'button'; pd.className = 'pdfbtn'; pd.title = 'Download as PDF (Pro)'; pd.setAttribute('aria-label', 'Download as PDF'); pd.innerHTML = PDF + '<span>PDF</span>'
  pd.addEventListener('click', () => {
    if (!isPro) { openPro(); return }
    const text = (a && a.trim()) || (msg.querySelector('.text') ? msg.querySelector('.text').textContent : '')
    exportPdf(deriveTitle(q, text), text)
  })
  bar.append(pd)
  // Open in the document side-panel — only for document-like answers (a heading or a table).
  const docText = String(a || '')
  if (/^#{1,3}\s/m.test(docText) || /^\s*\|.*\|\s*$/m.test(docText)) {
    const OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4M14 3h7v7M21 3l-9 9"/></svg>'
    const op = document.createElement('button'); op.type = 'button'; op.className = 'pdfbtn openbtn'; op.title = 'Open in document view'; op.setAttribute('aria-label', 'Open as document'); op.innerHTML = OPEN + '<span>Open<span class="more">&nbsp;as document</span></span>'
    op.addEventListener('click', () => openCanvas(deriveTitle(q, docText), docText))
    bar.append(op)
  }
  msg.querySelector('.body').appendChild(bar)
}

// ── Premium PDF export (client-side, pdfmake) — Pro ────────────────────────────
function slug(t) { return (String(t || 'noria-document').replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'noria-document').slice(0, 60) }
function deriveTitle(q, a) {
  const h = String(a || '').match(/^#{1,3}\s+(.+)/m); if (h) return h[1].trim().slice(0, 90)
  const t = String(q || '').replace(/^(please\s+)?(can you\s+|could you\s+)?(make|create|write|draft|generate|produce|prepare)\s+(me\s+)?(a|an|the)?\s*/i, '').replace(/\?+$/, '').trim()
  return (t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Noria Document').slice(0, 90)
}
function mdInline(t) {
  const parts = []; let re = /\*\*([^*]+)\*\*/g, last = 0, m
  while ((m = re.exec(t))) { if (m.index > last) parts.push(t.slice(last, m.index)); parts.push({ text: m[1], bold: true }); last = m.index + m[0].length }
  if (last < t.length) parts.push(t.slice(last)); return parts.length ? parts : t
}
function mdToPdf(md) {
  const out = []; let buf = null, type = null
  const flush = () => { if (buf) { out.push({ [type]: buf, margin: [0, 2, 0, 9] }); buf = null; type = null } }
  const rowCells = (r) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
  const lines = String(md).split('\n')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].replace(/\s+$/, ''); let m
    // GFM table → a real pdfmake table (so exported PDFs never show raw "| … |").
    if (/^\s*\|.*\|\s*$/.test(line) && li + 1 < lines.length && /-/.test(lines[li + 1]) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[li + 1])) {
      flush()
      const headers = rowCells(line); li++
      const body = [headers.map((h) => ({ text: mdInline(h), bold: true, color: '#0B1F3A', fillColor: '#F3EEDD' }))]
      while (li + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[li + 1])) { li++; const cells = rowCells(lines[li]); body.push(headers.map((_, k) => ({ text: mdInline(cells[k] || ''), color: '#232323' }))) }
      out.push({ table: { headerRows: 1, widths: headers.map(() => '*'), body }, layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#E3D6B5', vLineColor: () => '#E3D6B5', paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 4, paddingBottom: () => 4 }, fontSize: 9.5, margin: [0, 4, 0, 11] })
      continue
    }
    if (!line.trim()) { flush(); continue }
    if ((m = line.match(/^#{3,}\s+(.*)/))) { flush(); out.push({ text: mdInline(m[1]), style: 'h3' }); continue }
    if ((m = line.match(/^##\s+(.*)/))) { flush(); out.push({ text: mdInline(m[1]), style: 'h2' }); continue }
    if ((m = line.match(/^#\s+(.*)/))) { flush(); out.push({ text: mdInline(m[1]), style: 'h1' }); continue }
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) { if (type !== 'ul') { flush(); type = 'ul'; buf = [] } buf.push(mdInline(m[1])); continue }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (type !== 'ol') { flush(); type = 'ol'; buf = [] } buf.push(mdInline(m[1])); continue }
    flush(); out.push({ text: mdInline(line), style: 'p' })
  }
  flush(); return out
}
function buildPdfDoc(title, md) {
  const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  return {
    pageSize: 'A4', pageMargins: [54, 78, 54, 58],
    header: { columns: [{ text: '✦ NORIA', color: '#0B1F3A', bold: true, fontSize: 11, margin: [54, 30, 0, 0] }, { text: 'Noria', alignment: 'right', color: '#B0812A', fontSize: 10, margin: [0, 32, 54, 0] }] },
    footer: (cur, total) => ({ columns: [{ text: 'Prepared by Noria', color: '#9A9A9A', fontSize: 8, margin: [54, 0, 0, 0] }, { text: cur + ' / ' + total, alignment: 'right', color: '#9A9A9A', fontSize: 8, margin: [0, 0, 54, 0] }] }),
    content: [{ text: title, style: 'title' }, { text: dateStr, style: 'date' }, { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 487, y2: 0, lineWidth: 1, lineColor: '#E3D6B5' }], margin: [0, 7, 0, 15] }, ...mdToPdf(md)],
    styles: {
      title: { fontSize: 22, bold: true, color: '#0B1F3A', margin: [0, 0, 0, 2] }, date: { fontSize: 9, color: '#9A9A9A' },
      h1: { fontSize: 15, bold: true, color: '#0B1F3A', margin: [0, 13, 0, 5] }, h2: { fontSize: 13, bold: true, color: '#12325A', margin: [0, 11, 0, 4] }, h3: { fontSize: 11, bold: true, color: '#B0812A', margin: [0, 9, 0, 3] },
      p: { fontSize: 10.5, color: '#232323', margin: [0, 0, 0, 7], lineHeight: 1.35 },
    },
    defaultStyle: { fontSize: 10.5, lineHeight: 1.35 },
  }
}
async function exportPdf(title, md) {
  note('Preparing your PDF…')
  try {
    await lazyScript('https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/pdfmake.min.js')
    await lazyScript('https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/vfs_fonts.js')
    // Use getBlob + an object URL rather than pdfmake's built-in .download(), which
    // produces a blank/empty file on mobile browsers (Safari). This is reliable
    // cross-platform: a real application/pdf Blob saved via a download link.
    const name = slug(title) + '.pdf'
    const blob = await new Promise((res, rej) => {
      try { window.pdfMake.createPdf(buildPdfDoc(title, md)).getBlob((b) => res(b)) } catch (e) { rej(e) }
    })
    if (!blob || !blob.size) throw new Error('empty pdf')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener'
    document.body.appendChild(a); a.click(); a.remove()
    // iOS Safari ignores the download attribute — open the PDF so the user can Share → Save to Files.
    if (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
      try { window.open(url, '_blank') } catch {}
    }
    setTimeout(() => URL.revokeObjectURL(url), 15000)
    note('')
  } catch (e) { note('Could not create the PDF — please try again.') }
}

// ── Canvas / document side-panel (isolate long docs; 1-click Copy / MD / Word / PDF) ──
const canvasEl = $('canvas'), canvasBackdrop = $('canvasBackdrop')
let curCanvasMd = '', curCanvasTitle = 'Document'
function openCanvas(title, md) {
  curCanvasMd = md || ''; curCanvasTitle = title || 'Document'
  $('canvasTitle').textContent = curCanvasTitle
  renderMd($('canvasDoc'), curCanvasMd)
  $('canvasDoc').scrollTop = 0
  if ($('canvasXlsx')) $('canvasXlsx').hidden = !/^\s*\|.*\|\s*\n\s*\|?\s*:?-{2,}/m.test(curCanvasMd) // Excel only when there is a table to put in it
  canvasBackdrop.hidden = false; canvasEl.hidden = false
  requestAnimationFrame(() => { canvasBackdrop.classList.add('show'); canvasEl.classList.add('show') })
}
function closeCanvas() {
  canvasEl.classList.remove('show'); canvasBackdrop.classList.remove('show')
  setTimeout(() => { canvasEl.hidden = true; canvasBackdrop.hidden = true }, 260)
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.rel = 'noopener'
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 15000)
}
function mdToHtmlDoc(title, md) {
  const tmp = document.createElement('div'); renderMd(tmp, md)
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + esc(title) +
    '</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#222;line-height:1.5}h1{font-size:20pt;color:#0B1F3A}h2{font-size:14pt;color:#12325A}h3{font-size:12pt;color:#B0812A}table{border-collapse:collapse;width:100%}th,td{border:1px solid #cccccc;padding:5px 8px;text-align:left}th{background:#F3EEDD}</style></head><body>' + tmp.innerHTML + '</body></html>'
}
const canvasFlash = (btn, label) => { const o = btn.dataset.label || btn.textContent; btn.dataset.label = o; btn.textContent = label; btn.classList.add('ok'); setTimeout(() => { btn.textContent = o; btn.classList.remove('ok') }, 1400) }
canvasBackdrop && canvasBackdrop.addEventListener('click', closeCanvas)
$('canvasClose') && $('canvasClose').addEventListener('click', closeCanvas)
$('canvasCopy') && $('canvasCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(curCanvasMd) } catch { const ta = document.createElement('textarea'); ta.value = curCanvasMd; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy') } catch {} ta.remove() }
  canvasFlash($('canvasCopy'), 'Copied')
})
$('canvasMd') && $('canvasMd').addEventListener('click', () => { downloadBlob(new Blob([curCanvasMd], { type: 'text/markdown' }), slug(curCanvasTitle) + '.md'); canvasFlash($('canvasMd'), 'Saved') })
$('canvasPdf') && $('canvasPdf').addEventListener('click', () => exportPdf(curCanvasTitle, curCanvasMd))
$('canvasDocx') && $('canvasDocx').addEventListener('click', async () => {
  const btn = $('canvasDocx')
  try { // a real Word file (headings, lists, tables, page numbers) — the earlier HTML-based method below is the fallback
    const X = await import('./exports.js?v=1')
    await lazyScript('https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js')
    downloadBlob(await X.buildDocx(X.mdToBlocks(curCanvasMd), curCanvasTitle, window.docx), slug(curCanvasTitle) + '.docx'); canvasFlash(btn, 'Saved'); return
  } catch (e) { /* fall through to the previous method */ }
  try {
    await lazyScript('https://cdn.jsdelivr.net/npm/html-docx-js/dist/html-docx.js')
    const blob = window.htmlDocx.asBlob(mdToHtmlDoc(curCanvasTitle, curCanvasMd))
    downloadBlob(blob, slug(curCanvasTitle) + '.docx'); canvasFlash(btn, 'Saved')
  } catch (e) { canvasFlash(btn, 'Failed') }
})

// Excel and PowerPoint (Noria Pro): built on this device from the document, so nothing is sent anywhere.
$('canvasXlsx') && $('canvasXlsx').addEventListener('click', async () => {
  if (!isPro) { openPro('Excel export is part of Noria Pro.'); return }
  const btn = $('canvasXlsx')
  try {
    canvasFlash(btn, 'Building…')
    const X = await import('./exports.js?v=1')
    await lazyScript('https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js')
    downloadBlob(await X.buildXlsx(X.mdToBlocks(curCanvasMd), curCanvasTitle, window.ExcelJS), slug(curCanvasTitle) + '.xlsx'); canvasFlash(btn, 'Saved')
  } catch (e) { canvasFlash(btn, 'Failed') }
})
$('canvasPptx') && $('canvasPptx').addEventListener('click', async () => {
  if (!isPro) { openPro('PowerPoint export is part of Noria Pro.'); return }
  const btn = $('canvasPptx')
  try {
    canvasFlash(btn, 'Building…')
    const X = await import('./exports.js?v=1')
    await lazyScript('https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js')
    downloadBlob(await X.buildPptx(X.mdToBlocks(curCanvasMd), curCanvasTitle, window.PptxGenJS), slug(curCanvasTitle) + '.pptx'); canvasFlash(btn, 'Saved')
  } catch (e) { canvasFlash(btn, 'Failed') }
})

// ── Consent-based memory ──────────────────────────────────────────────────────
function suggestMemory(text) {
  if (document.getElementById('sugg') || !memCard) return
  const c = document.createElement('div'); c.className = 'card memsug'; c.id = 'sugg'
  c.innerHTML = '<div class="lab">✦ Noria noticed</div><p style="margin:0;font-size:.9rem">' + esc(text) + '</p><div class="acts"><button class="save">Remember this</button><button class="no">Not now</button></div>'
  const wrap = memCard.closest('.memwrap') || memCard // the suggestion sits above the whole Memory & privacy card
  wrap.parentNode.insertBefore(c, wrap)
  c.querySelector('.save').addEventListener('click', () => {
    applyMemoryUpdate(mem, { facts: [text] })
    const it = document.createElement('div'); it.className = 'memitem'; it.innerHTML = '<span class="k">•</span> ' + esc(text)
    const none = memCard.querySelector('.memempty'); if (none) none.remove() // the "nothing remembered yet" line goes once there is something
    memCard.appendChild(it); c.remove()
  })
  c.querySelector('.no').addEventListener('click', () => c.remove())
}
// Render any facts already remembered on this device
;(function seedMemory() {
  if (!memCard) return
  const facts = (mem && mem.profile && mem.profile.facts) || []
  const name = mem && mem.profile && mem.profile.name
  const items = []
  if (name) items.push('Name: ' + name)
  facts.slice(0, 6).forEach((f) => items.push(f))
  if (items.length) memCard.innerHTML = items.map((t) => '<div class="memitem"><span class="k">•</span> ' + esc(t) + '</div>').join('')
})()

// ── Conversations: real, saved, searchable (per device) ───────────────────────
// Accounts: sign-in, password reset, and conversations kept in the account. Loaded on the side, so a problem there can never stop the chat.
let acct = null
import('./account.js?v=1').then((m) => {
  acct = m
  m.initAccount({ getConvos: () => convos, setConvos: (arr) => { convos = arr; saveStore(); renderConvos() } })
  const btn = $('moreAcct'); if (btn) btn.addEventListener('click', () => { setMore(false); m.openAccount('signin') })
}).catch(() => {})
const CKEY = 'noria.convos.v1'
const convosEl = $('convos'), searchEl = $('search')
let convos = []
let currentId = null
try { convos = JSON.parse(localStorage.getItem(CKEY) || '[]') } catch { convos = [] }
function saveStore() {
  try { localStorage.setItem(CKEY, JSON.stringify(convos)); return true }
  catch {
    // storage full → drop the oldest conversations until it fits
    const oldestFirst = [...convos].sort((a, b) => a.updated - b.updated)
    while (oldestFirst.length > 1) {
      const drop = oldestFirst.shift(); convos = convos.filter((c) => c.id !== drop.id)
      try { localStorage.setItem(CKEY, JSON.stringify(convos)); return true } catch {}
    }
    return false
  }
}
function currentConvo() { return convos.find((c) => c.id === currentId) }
function titleFrom(t) { t = (t || '').replace(/\s+/g, ' ').trim(); return t.length > 42 ? t.slice(0, 42) + '…' : (t || 'New conversation') }
function convoRecord(msg) {
  let c = currentConvo()
  if (!c) { c = { id: 'c' + Date.now() + Math.random().toString(36).slice(2, 5), title: 'New conversation', titled: false, created: Date.now(), updated: Date.now(), messages: [] }; convos.push(c); currentId = c.id }
  c.messages.push(msg)
  if (msg.role === 'user' && !c.titled) { c.title = titleFrom(msg.text); c.titled = true }
  c.updated = Date.now()
  saveStore(); renderConvos()
  if (acct) acct.convoChanged(c.id) // signed in: the conversation is also saved to the account a moment later
}
function clearThread() { thread.querySelectorAll('.msg').forEach((n) => n.remove()); if (empty) empty.style.display = 'block'; stream.classList.add('is-empty'); brain.history = [] }
function newConversation() { currentId = null; clearThread(); renderConvos(); closeDrawer(); input.focus() }
function openConversation(id) {
  const c = convos.find((x) => x.id === id); if (!c) return
  currentId = id
  thread.querySelectorAll('.msg').forEach((n) => n.remove())
  if (empty) empty.style.display = 'none'
  stream.classList.remove('is-empty')
  brain.history = []
  let lastUserText = ''
  c.messages.forEach((m) => {
    if (m.role === 'user') { addUser(m.text, (m.files || []).map((n) => ({ name: n }))); lastUserText = m.text; brain.history.push({ role: 'user', content: m.text }) }
    else if (m.role === 'err') { const el = addNoria(); el.closest('.msg').classList.add('err'); el.textContent = m.text }
    else {
      const el = addNoria()
      if (m.img) {
        el.innerHTML = ''
        const fig = document.createElement('div'); fig.className = 'genimg'
        const im = document.createElement('img'); im.src = m.img; im.alt = m.cap || ''
        const cp = document.createElement('div'); cp.className = 'cap'; cp.textContent = m.cap || ''
        fig.append(im, cp); el.appendChild(fig)
        brain.history.push({ role: 'assistant', content: '[generated an image: ' + (m.cap || '') + ']' })
      } else {
        renderMd(el, m.text)
        if (m.sources && m.sources.length) addSources(el.closest('.msg'), m.sources)
        addFeedback(el.closest('.msg'), lastUserText, m.text) // restore Copy / PDF / Open on saved messages
        brain.history.push({ role: 'assistant', content: m.text })
      }
    }
  })
  renderConvos(); scrollDown(); closeDrawer()
}
function deleteConversation(id) {
  convos = convos.filter((c) => c.id !== id); saveStore()
  if (acct) acct.convoDeleted(id)
  if (currentId === id) newConversation(); else renderConvos()
}
function groupLabel(ts) {
  const now = new Date(), day = 86400000
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= startToday) return 'Today'
  if (ts >= startToday - day) return 'Yesterday'
  if (ts >= startToday - 7 * day) return 'Previous 7 days'
  return 'Earlier'
}
const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/></svg>'
function renderConvos(filter) {
  if (!convosEl) return
  const q = (filter != null ? filter : (searchEl ? searchEl.value : '')).toLowerCase().trim()
  let list = [...convos].sort((a, b) => b.updated - a.updated)
  if (q) list = list.filter((c) => (c.title || '').toLowerCase().includes(q) || c.messages.some((m) => (m.text || '').toLowerCase().includes(q)))
  convosEl.innerHTML = ''
  if (!list.length) {
    const n = document.createElement('div'); n.className = 'empty-note'
    n.textContent = q ? 'No conversations match.' : 'Your conversations will appear here.'
    convosEl.appendChild(n); return
  }
  let lastGroup = ''
  list.forEach((c) => {
    const g = groupLabel(c.updated)
    if (g !== lastGroup) { lastGroup = g; const l = document.createElement('div'); l.className = 'grouplab'; l.textContent = g; convosEl.appendChild(l) }
    const row = document.createElement('div'); row.className = 'convo' + (c.id === currentId ? ' on' : '')
    const t = document.createElement('span'); t.className = 't'; t.textContent = c.title || 'New conversation'
    const del = document.createElement('button'); del.className = 'del'; del.type = 'button'; del.title = 'Delete'; del.setAttribute('aria-label', 'Delete conversation'); del.innerHTML = TRASH
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteConversation(c.id) })
    row.append(t, del)
    row.addEventListener('click', () => openConversation(c.id))
    convosEl.appendChild(row)
  })
}
searchEl && searchEl.addEventListener('input', () => renderConvos())
$('newSide') && $('newSide').addEventListener('click', newConversation)
$('newTop') && $('newTop').addEventListener('click', newConversation)
// Phone "more" menu (holds New conversation + View in 3D so the top bar never overflows)
const moreBtn = $('moreBtn'), moreMenu = $('moreMenu')
function setMore(open) { if (!moreMenu || !moreBtn) return; moreMenu.classList.toggle('open', open); moreBtn.setAttribute('aria-expanded', String(open)) }
moreBtn && moreBtn.addEventListener('click', (e) => { e.stopPropagation(); setMore(!moreMenu.classList.contains('open')) })
$('moreNew') && $('moreNew').addEventListener('click', () => { setMore(false); newConversation() })
document.addEventListener('click', (e) => { if (moreMenu && moreMenu.classList.contains('open') && !moreMenu.contains(e.target)) setMore(false) })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMore(false) })
$('forget') && $('forget').addEventListener('click', () => {
  forgetMemory(); if (memCard) memCard.innerHTML = '<div class="memitem memempty">Memory cleared for this device.</div>'
  const s = document.getElementById('sugg'); if (s) s.remove()
})

// ── Side panel: hide / show, remembered on this device ─────────────────────────
const ctxShellEl = $('shell'), ctxShowBtn = $('ctxShow')
function setCtx(open) {
  if (ctxShellEl) ctxShellEl.classList.toggle('ctx-off', !open)
  if (ctxShowBtn) ctxShowBtn.hidden = open
  try { localStorage.setItem('noria.ctx', open ? 'open' : 'closed') } catch {}
}
$('ctxHide') && $('ctxHide').addEventListener('click', () => setCtx(false))
ctxShowBtn && ctxShowBtn.addEventListener('click', () => setCtx(true))
try { if (localStorage.getItem('noria.ctx') === 'closed') setCtx(false) } catch {}

// ── Mobile drawer ─────────────────────────────────────────────────────────────
const side = $('side'), backdrop = $('backdrop')
function closeDrawer() { if (side) side.classList.remove('open'); if (backdrop) backdrop.classList.remove('on') }
$('menuBtn') && $('menuBtn').addEventListener('click', () => { side.classList.add('open'); backdrop.classList.add('on') })
backdrop && backdrop.addEventListener('click', closeDrawer)

renderConvos()
grow()

// ── Noria Pro (upgrade experience) ────────────────────────────────────────────
let isPro = false
try { isPro = !!localStorage.getItem('noria.pro') } catch {}
const proBtn = $('proBtn'), proModal = $('proModal'), proMsg = $('proMsg')
let billing = 'monthly'
const PRICES = {
  monthly: { amt: '$35', per: '/ month', note: 'Planned price. No payment is taken yet.' },
  annual: { amt: '$28', per: '/ month', note: 'Planned price: $336 a year, save 20%. No payment is taken yet.' },
}
function renderProBadge() { if (!proBtn) return; proBtn.textContent = isPro ? '✦ Pro' : 'Upgrade'; proBtn.classList.toggle('is-pro', isPro); proBtn.title = isPro ? 'Noria Pro active' : 'Upgrade to Noria Pro' }
function setBilling(p) {
  billing = p
  const sm = $('segMonthly'), sa = $('segAnnual')
  if (sm) { sm.classList.toggle('on', p === 'monthly'); sm.setAttribute('aria-selected', p === 'monthly') }
  if (sa) { sa.classList.toggle('on', p === 'annual'); sa.setAttribute('aria-selected', p === 'annual') }
  if ($('proPrice')) $('proPrice').textContent = PRICES[p].amt
  if ($('proPer')) $('proPer').textContent = PRICES[p].per
  if ($('proNote')) $('proNote').textContent = PRICES[p].note
}
function closeAllModals() { ['proModal', 'guideModal'].forEach((id) => { const m = $(id); if (m) m.hidden = true }) }
function openPro(reason) { closeAllModals(); if (proModal) { proModal.hidden = false; if (proMsg) { proMsg.textContent = reason || ''; proMsg.className = 'pm-msg' } } }
function closePro() { if (proModal) proModal.hidden = true }
proBtn && proBtn.addEventListener('click', () => openPro())
// The visitor's Pro access code, sent with Pro-only requests so the server can verify it (image creation, photo understanding).
// (Sent as a query parameter, not a header: a custom header forces the browser to ask the server for permission first,
// which older servers refuse — a query parameter works with every version.)
function proParam() { let c = ''; try { c = localStorage.getItem('noria.pro') || '' } catch {} return c ? '&pro=' + encodeURIComponent(c) : '' }
// See Noria (her live figure) and the 3D avatar are Noria Pro features.
document.querySelectorAll('.seebtn, a[href="/figure"], a[href="/avatar"]').forEach((a) => a.addEventListener('click', (e) => {
  if (isPro) return
  e.preventDefault(); if (typeof setMore === 'function') setMore(false)
  openPro(a.getAttribute('href') === '/avatar' ? 'The 3D avatar is part of Noria Pro.' : 'See Noria is part of Noria Pro.')
}))
// Sent here from the figure / 3D page by a visitor who isn't on Pro yet.
try { const want = new URLSearchParams(location.search).get('pro'); if (want && !isPro) { openPro(want === 'avatar' ? 'The 3D avatar is part of Noria Pro.' : 'See Noria is part of Noria Pro.'); history.replaceState(null, '', location.pathname) } } catch {}
$('proClose') && $('proClose').addEventListener('click', closePro)
proModal && proModal.addEventListener('click', (e) => { if (e.target === proModal) closePro() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeAllModals(); if (canvasEl && !canvasEl.hidden) closeCanvas() } })
$('segMonthly') && $('segMonthly').addEventListener('click', () => setBilling('monthly'))
$('segAnnual') && $('segAnnual').addEventListener('click', () => setBilling('annual'))
$('proSubscribe') && $('proSubscribe').addEventListener('click', () => startCheckout(billing))
function startCheckout(period) {
  // Payments are not switched on yet (in-app checkout comes later), so this is honest early access:
  // people ask by email, receive a code, and enter it below. Nothing is charged.
  if (proMsg) { proMsg.innerHTML = 'Early access is by invitation while payments are being finished. Email <a href="mailto:pro@noria.africa?subject=Noria%20Pro%20early%20access">pro@noria.africa</a> for a code, then enter it below.'; proMsg.className = 'pm-msg' }
  const box = $('proCodeBox'); if (box) box.hidden = false
}
// Access code unlock (owner + early users). Verified by the worker (HMAC — not AI,
// so it works regardless of the AI quota). This is also how you, as owner, get Pro free.
const PRO_CHECK = 'https://noria-ai.insights-skyglobe.workers.dev/pro/check'
$('proCodeLink') && $('proCodeLink').addEventListener('click', () => { const b = $('proCodeBox'); if (b) b.hidden = !b.hidden })
$('proUnlock') && $('proUnlock').addEventListener('click', async () => {
  const code = (($('proCode').value) || '').trim().toUpperCase()
  if (!code) return
  proMsg.textContent = 'Checking…'; proMsg.className = 'pm-msg'
  try {
    const r = await fetch(PRO_CHECK + '?code=' + encodeURIComponent(code))
    const j = await r.json()
    if (j.pro) {
      isPro = true; try { localStorage.setItem('noria.pro', code) } catch {}
      renderProBadge(); proMsg.textContent = '✓ Noria Pro unlocked — thank you!'; proMsg.className = 'pm-msg ok'
      setTimeout(closePro, 1300)
    } else { proMsg.textContent = 'That code isn’t valid.'; proMsg.className = 'pm-msg err' }
  } catch { proMsg.textContent = 'Couldn’t verify right now — please try again.'; proMsg.className = 'pm-msg err' }
})
renderProBadge(); setBilling('monthly')

// ── Guided documents (Pro) — premium, structured, exportable to PDF ───────────
// Appended to every guided-document prompt: a finished document has NO fill-in
// blanks. This is what turns a bracket-filled skeleton into a clean, submittable doc.
const DOC_RULES = '\n\nFORMAT RULES (critical — a finished, ready-to-use document): Do NOT use fill-in-the-blank placeholders anywhere in the body. Never write square-bracket placeholders like [Company] or [Degree], and never write parenthetical instructions like (insert...), (add...), (list any...), or (repeat for each...). Write only complete, natural sentences using the real details given. If a whole section cannot be completed from those details, leave that section out entirely — do not pad it. If, and only if, essential information is genuinely missing, end the document with a single short "## To complete before you send this" section that lists what to add, in plain words. Keep the document clean, consistent, and professional throughout. Begin immediately with the document itself (its title) — no conversational preamble, meta-commentary or sign-off such as "Here is..." or "I hope this helps". Never assume, default to, or invent a country, city, nationality or currency: use only a location the user actually provided; if none is given, keep the document country-neutral and do not name a default country. Where structured data suits the content (comparisons, figures, timelines, itemised deliverables), present it as a clean Markdown table rather than a wall of text.'

// Safety net: guarantee a guided document is clean even if the model still emits
// placeholder scaffolding. Line-aware so it never leaves broken fragments: a line
// with a placeholder is kept only if what remains is a complete sentence, otherwise
// the whole line is dropped — and any section left with no body is removed too.
const PH_RE = /\[[^\]\n]{1,100}\]|\((?:add|insert|list|repeat|include|fill in|e\.g\.[^)]*optional)\b[^)]*\)/i
function cleanDocText(t) {
  // Pre-pass: remove conversational meta-announcements and broken structural tags
  // (artifacts) so the document opens directly on its own content.
  let s0 = String(t || '')
  s0 = s0.replace(/<\/?(step|section|document|response|answer|output|thinking|tool_call|tool_result)[^>]*>/gi, '')
  s0 = s0.replace(/^\s*(sure|certainly|of course|absolutely|great|no problem)[!,.:][^\n]*\n+/i, '')
  s0 = s0.replace(/^\s*(here(?:'s| is| are)|below (?:is|are)|i(?:'ve| have) (?:created|drafted|prepared|put together|written))[^\n]*:\s*\n+/i, '')
  const strip = (l) => l.replace(/\s*\[[^\]\n]{1,100}\]/g, '').replace(/\s*\((?:add|insert|list|repeat|include|fill in|e\.g\.[^)]*optional)\b[^)]*\)/gi, '').replace(/\*\*\s*\*\*/g, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:])/g, '$1').trim()
  const isComplete = (s) => { const core = s.replace(/^[-*]\s+/, '').replace(/[.!?:]$/, '').trim(); return /[.!?:]$/.test(s) && core.split(/\s+/).length >= 4 && !/\b(to|of|across|the|a|an|for|with|and|or|in|on|at|by|from|as|is|are|was|were)$/i.test(core) }
  const kept = []
  for (const raw of s0.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (/^\s*#{1,6}\s/.test(line)) { kept.push(line); continue } // headings pass through
    if (PH_RE.test(line)) { const s = strip(line); if (s && isComplete(s)) kept.push(s); continue } // keep only if still complete
    if (/^\s*[-*]\s*$/.test(line)) continue // drop empty bullet
    kept.push(line)
  }
  // Drop any ## / ### heading that ended up with no body (keep the top # title).
  const out = []
  for (let i = 0; i < kept.length; i++) {
    const l = kept[i]
    if (/^\s*#{2,6}\s/.test(l)) {
      let hasBody = false
      for (let j = i + 1; j < kept.length; j++) { if (!kept[j].trim()) continue; if (/^\s*#{1,6}\s/.test(kept[j])) break; hasBody = true; break }
      if (!hasBody) continue
    }
    out.push(l)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

const MODERN_STANDARD = '\n\n[MODERN STANDARD — match or exceed today\'s best assistants]\n' +
  '- CURRENCY: Recommend only current, actively-maintained tools, platforms, versions and practices. Explicitly flag anything retired or deprecated and name its modern replacement (never suggest services or free tiers that no longer exist). When LIVE WEB RESULTS are provided, base names, prices, tiers and versions on them; if you are not certain something is current, say so rather than stating it as fact.\n' +
  '- LOCAL CONTEXT: When a country or city is given, adapt to it — reference real local hubs, communities, employers, services and APIs, and give realistic LOCAL pay/price ranges alongside remote or international ones. Never fall back to a generic global template when a location is known.\n' +
  '- DEPTH & VALIDATION: Be concrete, not vague. Where useful include short fenced code snippets, file/folder layouts, exact commands, config or schema examples, and clear "done" criteria. Prefer named specifics (tools, versions, endpoints) over generalities.\n' +
  '- REALISM: Give honest, phased, achievable timelines; frame estimates and salaries as ranges to verify, never guarantees.\n'

const YEAR = new Date().getFullYear()
const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'

const GUIDES = [
  { id: 'business', cat: 'strategy', title: 'Executive Venture Modeling', icon: ICON + '<path d="M4 20V10M10 20V4M16 20v-8M2 20h20"/></svg>',
    desc: 'A rigorous venture model and business plan grounded in current market data.',
    fields: [{ k: 'name', label: 'Venture name', ph: 'e.g. Sunrise Cafe' }, { k: 'what', label: 'What the venture does', ph: 'one line', long: true }, { k: 'where', label: 'Market / location (optional)', ph: 'e.g. Accra, Ghana', optional: true }],
    prompt: (v) => `Write a business plan for "${v.name}"${v.where ? ` based in ${v.where}` : ''}. What it does: ${v.what}.`,
    web: (v) => `${v.what} business ${v.where || ''} market ${YEAR}`.trim(),
    system: (v) => 'Produce a realistic BUSINESS PLAN with markdown headings: # ' + v.name + ' — Business Plan, ## Executive Summary, ## Problem & Solution, ## Products/Services, ## Target Market, ## Competition & Advantage, ## Marketing & Sales, ## Operations, ## Team, ## Financial Plan (label all figures as illustrative estimates to validate; use local currency and realistic local costs when a location is given), ## Milestones, ## Risks & Mitigations. Do not present invented statistics as fact.' },
  { id: 'roadmap', cat: 'strategy', title: 'System Architecture & Tech Stack Design', icon: ICON + '<path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/></svg>',
    desc: 'A modern, job-ready engineering roadmap: current stack, real projects, code, and pacing.',
    fields: [{ k: 'goal', label: 'Your goal', ph: 'e.g. become a job-ready full-stack developer' }, { k: 'start', label: 'Your current level', ph: 'e.g. complete beginner / knows basic HTML', long: true }, { k: 'stack', label: 'Preferred language / stack (optional)', ph: 'e.g. JavaScript, or unsure', optional: true }, { k: 'location', label: 'Your city / country (optional)', ph: 'e.g. Kumasi, Ghana', optional: true }, { k: 'time', label: 'Timeframe (optional)', ph: 'e.g. 12 months', optional: true }],
    prompt: (v) => `Build a developer roadmap to: ${v.goal}. Current level: ${v.start}.${v.stack ? ` Preferred stack: ${v.stack}.` : ''}${v.time ? ` Timeframe: ${v.time}.` : ''}${v.location ? ` Location: ${v.location}.` : ''}`,
    web: (v) => `${v.goal} developer roadmap ${YEAR} tools hiring ${v.location || ''}`.trim(),
    system: () => 'Produce a premium TECH / DEVELOPER ROADMAP that matches the best of ChatGPT and Gemini. Requirements: ' +
      '(1) MODERN STACK & AI WORKFLOW — teach current workflows including AI-assisted development (writing, testing and debugging alongside tools like GitHub Copilot, Cursor and AI chat), Git/GitHub, package managers and virtual environments (npm or pnpm, venv), a modern bundler (Vite), environment variables (.env), and Docker basics; cover REST APIs, a hosted database (e.g. Supabase/Postgres or MongoDB Atlas) and authentication. ' +
      '(2) DYNAMIC PROJECT SYLLABUS — give 3 to 4 concrete projects, each with its architecture, the key concepts it teaches, the exact stack, and a real deployment target (e.g. Vercel or Netlify for frontend, Render/Railway/Fly for backend); never vague ideas like "a calculator". Flag retired platforms (e.g. the old Heroku free tier) and name current replacements. ' +
      '(3) ADAPTIVE PACING — recommend a single focused stack first (e.g. JavaScript/Node end-to-end, or pure Python) and lay out a realistic phased timeline inside a fenced code block (foundations, frontend, backend & databases, full-stack project, then interview prep & applications), stretching zero-to-job to an honest range. ' +
      '(4) TECHNICAL DEPTH & VALIDATION — include short fenced code snippets, a professional repository layout (README, .gitignore, LICENSE, tests), early testing (Jest or PyTest), and system-design basics (HTTP methods, status codes, schema design); end with clear interview-readiness criteria. ' +
      '(5) HYPER-LOCAL — when a location is given, reference real local tech hubs and communities, realistic local salary ranges alongside international or remote rates, and locally relevant project ideas (e.g. mobile-money API integrations where applicable). ' +
      'Markdown headings: # Developer Roadmap, ## Overview, ## Your Stack (and why), ## Phase-by-Phase Plan, ## Modern Tooling & AI Workflow, ## Projects to Build, ## Repository & Testing Standards, ## Local & Remote Opportunities, ## Interview Readiness.' },
  { id: 'profile', cat: 'career', title: 'Executive Profile & CV Optimization', icon: ICON + '<circle cx="12" cy="8" r="3.2"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
    desc: 'A polished executive CV and/or a tailored cover letter, built from your real experience.',
    fields: [{ k: 'name', label: 'Full name', ph: 'e.g. Amina Bello' }, { k: 'role', label: 'Target role / field', ph: 'e.g. Operations Director' }, { k: 'doctype', label: 'What to create', type: 'select', options: ['CV / Résumé', 'Cover letter', 'Both'] }, { k: 'details', label: 'Your experience, skills & education', ph: 'roles, years, skills, schools — paste what you have', long: true }],
    prompt: (v) => { const w = v.doctype === 'Both' ? 'a CV and a matching cover letter' : v.doctype === 'Cover letter' ? 'a cover letter' : 'a CV'; return `Create ${w} for ${v.name}, targeting a ${v.role} role. Real details to use: ${v.details}` },
    system: (v) => { const cv = 'For the CV use markdown: # ' + v.name + ', a one-line professional headline, ## Professional Summary, ## Key Skills, ## Experience (strong action verbs; quantify only where numbers were given), ## Education, ## Additional; keep it ATS-friendly and one to two pages.'; const cl = 'For the cover letter: 3 to 4 tight, sincere paragraphs, specific, with no cliches or fabricated achievements; put the applicant name as a # heading, then the body, then a professional sign-off.'; const base = 'Act as an elite executive career strategist. Use ONLY the real details provided (never invent employers, dates, titles or qualifications). '; if (v.doctype === 'Both') return base + cv + ' Then add a "# Cover Letter" section. ' + cl; if (v.doctype === 'Cover letter') return base + cl; return base + cv } },
  { id: 'career', cat: 'career', title: 'Strategic Career & Leadership Roadmap', icon: ICON + '<path d="M6 3v11a3 3 0 0 0 3 3h6"/><path d="M15 14l3 3-3 3"/></svg>',
    desc: 'A phased plan to advance and step into leadership — current, local and remote.',
    fields: [{ k: 'goal', label: 'Your goal', ph: 'e.g. become a data analyst' }, { k: 'now', label: 'Where you are now', ph: 'current skills / situation', long: true }, { k: 'location', label: 'Your city / country (optional)', ph: 'e.g. Kumasi, Ghana', optional: true }, { k: 'time', label: 'Timeframe (optional)', ph: 'e.g. 12 months', optional: true }],
    prompt: (v) => `Build a career roadmap to reach: ${v.goal}${v.time ? ` within ${v.time}` : ''}. Starting point: ${v.now}.${v.location ? ` Location: ${v.location}.` : ''}`,
    web: (v) => `${v.goal} skills tools salary ${YEAR} ${v.location || ''}`.trim(),
    system: () => 'Produce a step-by-step CAREER ROADMAP. Markdown: # Career Roadmap, ## Where You Are & Where You\'re Going, ## Skills to Build (name current, in-demand tools), ## Step-by-Step Plan (phased, concrete actions with free or low-cost current resources), ## Portfolio / Proof to Build, ## Finding Opportunities (real current channels, both local and remote), ## Milestones. Frame timelines and salary ranges as estimates to verify, never guarantees.' },
  { id: 'visa', cat: 'mobility', title: 'Immigration & Relocation Strategy', icon: ICON + '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    desc: 'Current requirements, a checklist of your own genuine documents, and a cover letter you can adapt.',
    fields: [{ k: 'nationality', label: 'Your nationality', ph: 'e.g. Kenyan' }, { k: 'destination', label: 'Destination country', ph: 'e.g. Canada' }, { k: 'type', label: 'Visa type', ph: 'e.g. study / work / visit' }, { k: 'purpose', label: 'Purpose of the trip (optional)', ph: 'brief and honest', long: true, optional: true }],
    prompt: (v) => `Prepare a visa preparation guide for a ${v.nationality} national applying for a ${v.type} visa to ${v.destination}${v.purpose ? `. Purpose of the trip: ${v.purpose}` : ''}.`,
    web: (v) => `${v.type} visa ${v.destination} requirements ${YEAR}`,
    system: () => 'Produce a VISA PREPARATION GUIDE with markdown headings: # Visa Preparation Guide, ## Overview, ## Eligibility & Key Requirements, ## Document Checklist (only the genuine documents the applicant gathers — valid passport, their own bank statements, employment or enrolment letter, proof of real ties to home), ## Demonstrating a Strong, Honest Application, ## Common Refusal Reasons & How to Avoid Them, ## Sample Cover Letter. Never fabricate documents, invitations or ties, or suggest doing so — only guide the applicant\'s own genuine case. Name the official embassy or immigration website as the source of truth for exact current fees and forms. Never guarantee approval. End with a short honest disclaimer.' },
  { id: 'travel', cat: 'mobility', title: 'Itinerary & Operational Logistics', icon: ICON + '<path d="M2 12l20-8-8 20-2-8-8-4z"/></svg>',
    desc: 'A practical day-by-day itinerary with current, realistic detail.',
    fields: [{ k: 'destination', label: 'Destination', ph: 'e.g. Nairobi' }, { k: 'days', label: 'How many days', ph: 'e.g. 5' }, { k: 'focus', label: 'Interests / budget (optional)', ph: 'e.g. culture, mid-range', optional: true }],
    prompt: (v) => `Create a ${v.days}-day travel itinerary for ${v.destination}${v.focus ? ` (${v.focus})` : ''}.`,
    web: (v) => `${v.destination} travel guide ${YEAR} attractions cost`,
    system: (v) => `Produce a practical day-by-day itinerary. Markdown: # ${v.destination} — ${v.days}-Day Itinerary, ## Overview & Best Time to Go, then ## Day 1 through ## Day ${v.days} (each with morning / afternoon / evening), ## Getting Around, ## Where to Stay, ## Budget (local currency ranges), ## Practical Notes. Opening hours and prices change — say they must be confirmed and never present them as fixed fact.` },
  { id: 'series', cat: 'creator', title: 'Content Series & Calendar Planner', icon: ICON + '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5z"/></svg>',
    desc: 'A multi-part content series with episode plan, posting calendar and a consistent visual style — ready to export to Excel or PowerPoint.',
    fields: [{ k: 'topic', label: 'Topic or niche', ph: 'e.g. street food from across Ghana' }, { k: 'platform', label: 'Main platform', type: 'select', options: ['YouTube', 'TikTok', 'Instagram', 'LinkedIn', 'Podcast', 'Facebook'] }, { k: 'audience', label: 'Who it is for', ph: 'e.g. young Ghanaians and the diaspora', long: true }, { k: 'goal', label: 'Your goal (optional)', ph: 'e.g. build an audience, promote my business, get clients', optional: true }, { k: 'parts', label: 'How many episodes / weeks', ph: 'e.g. 8', optional: true }, { k: 'location', label: 'Your city / country (optional)', ph: 'e.g. Accra, Ghana', optional: true }],
    prompt: (v) => `Plan a content series of ${v.parts || '8'} episodes about "${v.topic}" for ${v.platform}. Audience: ${v.audience}.${v.goal ? ` Goal: ${v.goal}.` : ''}${v.location ? ` Based in: ${v.location}.` : ''}`,
    web: (v) => `${v.topic} ${v.platform} content trends ${YEAR} ${v.location || ''}`.trim(),
    system: (v) => 'Produce a practical CONTENT SERIES PLAN. Use markdown headings: # ' + v.topic + ' — Content Series Plan, ## Series Concept (one clear promise and why this audience would follow it), ## Audience & Goal, ## Content Pillars (a table: Pillar | What it covers | Why it works), ## Episode Plan (a table with one row per episode: # | Title | Hook for the first 3 seconds | Format and length | Key points | Call to action), ## Posting Calendar (a table: Week | Day | Episode | Platform | Notes; choose a realistic rhythm a solo creator can keep), ## Production Checklist (a short bullet list of what to prepare for each episode), ## Visual Style Guide (colours, fonts, framing, thumbnail or cover layout, and the caption style, written so every episode looks like part of one series; use words, not image prompts), ## How to Measure Progress (which numbers to watch and what a healthy early result looks like), ## Next Steps. Make the episode titles specific, hooks concrete and platform-appropriate for ' + v.platform + '. Be honest: never promise views, followers or income, describe results as things to test and adjust. Where a location is given, use local references, languages and events; otherwise keep it general.' },
]
const guidesEl = $('guides'), guideModal = $('guideModal')
let activeGuide = null
const GUIDE_CATS = [
  { id: 'strategy', title: 'Executive & Venture Strategy' },
  { id: 'career', title: 'Career & Professional Mastery' },
  { id: 'mobility', title: 'Global Mobility & Logistics' },
  { id: 'creator', title: 'Creator & Content Growth' },
]
function renderGuides() {
  if (!guidesEl) return
  guidesEl.innerHTML = ''
  GUIDE_CATS.forEach((cat) => {
    const items = GUIDES.filter((g) => g.cat === cat.id)
    if (!items.length) return
    const sec = document.createElement('div'); sec.className = 'guide-cat'
    const h = document.createElement('div'); h.className = 'guide-cat-title'; h.textContent = cat.title
    const row = document.createElement('div'); row.className = 'guide-cat-chips'
    items.forEach((g) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'guide-chip'; b.innerHTML = g.icon + '<span>' + g.title + '</span>'; b.addEventListener('click', () => openGuide(g.id)); row.appendChild(b) })
    sec.append(h, row); guidesEl.appendChild(sec)
  })
}
function openGuide(id) {
  const g = GUIDES.find((x) => x.id === id); if (!g) return
  if (!isPro) { openPro(); return } // guided documents are a Pro feature
  closeAllModals(); activeGuide = g
  $('guideTitle').textContent = g.title; $('guideDesc').textContent = g.desc
  const gf = $('guideFields'); gf.innerHTML = ''
  g.fields.forEach((f) => {
    const wrap = document.createElement('div')
    const lab = document.createElement('label'); lab.htmlFor = 'gf_' + f.k; lab.innerHTML = esc(f.label) + (f.optional ? '' : ' <span class="req">*</span>')
    let inp
    if (f.type === 'select') { inp = document.createElement('select'); (f.options || []).forEach((o) => { const op = document.createElement('option'); op.value = o; op.textContent = o; inp.appendChild(op) }) }
    else { inp = f.long ? document.createElement('textarea') : document.createElement('input'); inp.placeholder = f.ph || '' }
    inp.id = 'gf_' + f.k; inp.dataset.k = f.k; inp.dataset.optional = f.optional ? '1' : ''
    wrap.append(lab, inp); gf.appendChild(wrap)
  })
  $('guideMsg').textContent = ''; $('guideMsg').className = 'pm-msg'; guideModal.hidden = false
}
function closeGuide() { if (guideModal) guideModal.hidden = true }
$('guideClose') && $('guideClose').addEventListener('click', closeGuide)
guideModal && guideModal.addEventListener('click', (e) => { if (e.target === guideModal) closeGuide() })
$('guideCreate') && $('guideCreate').addEventListener('click', () => {
  if (!activeGuide) return
  const v = {}; let missing = false
  $('guideFields').querySelectorAll('input,textarea,select').forEach((inp) => { v[inp.dataset.k] = inp.value.trim(); if (!inp.value.trim() && inp.dataset.optional !== '1') missing = true })
  if (missing) { $('guideMsg').textContent = 'Please fill in the required fields.'; $('guideMsg').className = 'pm-msg err'; return }
  const summary = activeGuide.fields.map((f) => (v[f.k] || '').slice(0, 40)).filter(Boolean).slice(0, 3).join(' · ')
  closeGuide()
  respond(activeGuide.prompt(v), { display: activeGuide.title + (summary ? ': ' + summary : ''), doc: true, system: (activeGuide.system ? activeGuide.system(v) : '') + MODERN_STANDARD + DOC_RULES, web: activeGuide.web ? activeGuide.web(v) : '', noWeb: !activeGuide.web })
})
// ── Command palette (/) — the elite engines, summoned; the canvas stays pristine ──
const CMD_KEYS = { business: 'venture', roadmap: 'architecture', profile: 'profile', career: 'career', visa: 'mobility', travel: 'logistics', series: 'content' }
const cmdPalette = $('cmdPalette'), cmdList = $('cmdList'), cmdBackdrop = $('cmdBackdrop'), cmdBtn = $('cmdBtn')
let cmdOpen = false, cmdItems = [], cmdSel = -1
function cmdMatches(g, q) { return !q || (CMD_KEYS[g.id] || g.id).includes(q) || g.title.toLowerCase().includes(q) }
function renderCmd(q) {
  if (!cmdList) return
  q = (q || '').toLowerCase().trim()
  cmdList.innerHTML = ''; cmdItems = []; cmdSel = -1
  GUIDE_CATS.forEach((cat) => {
    const items = GUIDES.filter((g) => g.cat === cat.id && cmdMatches(g, q))
    if (!items.length) return
    const lab = document.createElement('div'); lab.className = 'cmd-cat'; lab.textContent = cat.title; cmdList.appendChild(lab)
    items.forEach((g) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'cmd-item'; b.setAttribute('role', 'menuitem')
      b.innerHTML = '<span class="cmd-ico">' + g.icon + '</span><span class="cmd-cmd">/' + (CMD_KEYS[g.id] || g.id) + '</span><span class="cmd-name">' + esc(g.title) + '</span>'
      b.addEventListener('click', () => selectCmd(g.id))
      b.addEventListener('mousemove', () => { const i = cmdItems.findIndex((x) => x.el === b); if (i >= 0 && i !== cmdSel) { cmdSel = i; highlightCmd() } })
      cmdList.appendChild(b); cmdItems.push({ id: g.id, el: b })
    })
  })
  if (cmdItems.length) { cmdSel = 0; highlightCmd() }
}
function highlightCmd() { cmdItems.forEach((it, i) => it.el.classList.toggle('on', i === cmdSel)); if (cmdItems[cmdSel]) cmdItems[cmdSel].el.scrollIntoView({ block: 'nearest' }) }
function openCmd(q) { if (!cmdPalette) return; renderCmd(q); cmdOpen = true; cmdBackdrop.hidden = false; cmdPalette.hidden = false; requestAnimationFrame(() => cmdPalette.classList.add('show')) }
function closeCmd() { if (!cmdPalette) return; cmdOpen = false; cmdPalette.classList.remove('show'); setTimeout(() => { cmdPalette.hidden = true; cmdBackdrop.hidden = true }, 180) }
function selectCmd(id) { closeCmd(); if (input.value.startsWith('/')) { input.value = ''; grow() } openGuide(id) }
// Typing "/" as the first character summons the palette and filters live.
function cmdOnInput() {
  const val = input.value
  if (val.startsWith('/')) { const q = val.slice(1); if (!cmdOpen) openCmd(q); else renderCmd(q) }
  else if (cmdOpen) closeCmd()
}
function cmdHandleKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (cmdItems.length) { cmdSel = (cmdSel + 1) % cmdItems.length; highlightCmd() } return true }
  if (e.key === 'ArrowUp') { e.preventDefault(); if (cmdItems.length) { cmdSel = (cmdSel - 1 + cmdItems.length) % cmdItems.length; highlightCmd() } return true }
  if (e.key === 'Enter') { e.preventDefault(); if (cmdItems[cmdSel]) selectCmd(cmdItems[cmdSel].id); return true }
  if (e.key === 'Escape') { e.preventDefault(); closeCmd(); return true }
  return false
}
cmdBtn && cmdBtn.addEventListener('click', () => { if (cmdOpen) { closeCmd() } else { openCmd(input.value.startsWith('/') ? input.value.slice(1) : ''); input.focus() } })
cmdBackdrop && cmdBackdrop.addEventListener('click', closeCmd)
renderCmd('')

// Service worker retired: do NOT register one, and clean up any existing one
// (the old worker caused hang / stale-code issues). The app loads from the network.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {})
  if (window.caches && caches.keys) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {})
}
