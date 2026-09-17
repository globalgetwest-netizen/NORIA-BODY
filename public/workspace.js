/**
 * Noria Workspace — the premium conversation UI wired to the REAL engine and the
 * NoriaPresenceEngine. Answers come from the live Noria brain (via the /brain
 * proxy, same as the classic app); the presence engine shapes delivery timing,
 * memory suggestions, and emotional state. The engine is never modified.
 */
import { Brain, toSpeech } from './brain.js'
import { noriaSystem } from './persona.js'
import { initMemory, memoryContext, applyMemoryUpdate, forgetMemory } from './memory.js'
import { retrieveKnowledge } from './knowledge.js'
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
let busy = false, cancelled = false

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
  const src = String(text).replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, c) => { blocks.push(c.replace(/\n$/, '')); return S0 + (blocks.length - 1) + S1 })
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
    if ((m = line.match(cbRe))) { flush(); html += '<pre class="code">' + esc(blocks[+m[1]]) + '</pre>'; continue }
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
let audioUnlocked = false
function unlockAudio() {
  if (audioUnlocked) return
  audioUnlocked = true
  // Play a silent clip inside the user gesture so later async audio can play on iOS.
  try { ttsAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='; ttsAudio.play().catch(() => {}) } catch {}
  try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; window.speechSynthesis.speak(u) } catch {}
}
window.addEventListener('pointerdown', unlockAudio, { once: true })
let speakGen = 0
function stopSpeaking() { speakGen++; try { ttsAudio.pause() } catch {} brain.stopSpeaking() }
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
async function ttsBlob(text) {
  const r = await fetch(TTS_URL + '?text=' + encodeURIComponent(text))
  if (!r.ok) throw new Error('tts ' + r.status)
  return await r.blob()
}
function playBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    ttsAudio.onended = () => { URL.revokeObjectURL(url); resolve() }
    ttsAudio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('audio')) }
    try { ttsAudio.pause() } catch {}
    ttsAudio.src = url
    ttsAudio.play().catch(reject)
  })
}
// Speak the FULL text (no truncation), same neural voice, played chunk-by-chunk in
// order with the next chunk prefetched so there are no gaps and nothing is skipped.
async function speakNeural(text) {
  const t = toSpeech(text) // strip markdown/symbols/emoji so the voice never reads them
  if (!t) return
  const gen = ++speakGen
  brain.stopSpeaking()
  const chunks = chunkForSpeech(t)
  if (!chunks.length) return
  let i = 0
  try {
    let nextP = ttsBlob(chunks[0])
    for (; i < chunks.length; i++) {
      const blob = await nextP
      if (gen !== speakGen) return // a newer speak() or stopSpeaking() superseded this one
      if (i + 1 < chunks.length) nextP = ttsBlob(chunks[i + 1]) // prefetch while this plays
      await playBlob(blob)
      if (gen !== speakGen) return
    }
  } catch (e) {
    // Never go silent: read whatever hasn't been spoken yet with the browser voice.
    if (gen === speakGen) { try { ttsAudio.pause() } catch {} brain.speak(chunks.slice(i).join(' '), {}) }
  }
}
if (vt) vt.addEventListener('click', () => {
  voiceOn = !voiceOn; vt.classList.toggle('on', voiceOn); vt.title = voiceOn ? 'Voice on' : 'Voice off'
  if (voiceOn) { unlockAudio(); speakNeural('Voice on.') } else stopSpeaking()
})

// ── Voice input (mic) — speak to Noria; auto-sends, and she speaks back ────────
let micRec = null
const micBtn = $('micBtn')
function setRec(on) { if (micBtn) micBtn.classList.toggle('rec', on) }
micBtn && micBtn.addEventListener('click', () => {
  if (micRec) { try { micRec.stop() } catch {} micRec = null; return }
  unlockAudio(); stopSpeaking()
  if (!voiceOn) { voiceOn = true; if (vt) { vt.classList.add('on'); vt.title = 'Voice on' } } // talk → she talks back
  setRec(true); input.value = ''; input.placeholder = 'Listening…'
  micRec = brain.listen({
    onResult: (text) => { input.value = text; grow() },
    onEnd: (finalText) => {
      setRec(false); micRec = null; input.placeholder = 'Ask Noria anything…'
      if (finalText && finalText.trim()) respond(finalText)
    },
  })
  if (!micRec) { setRec(false); input.placeholder = 'Ask Noria anything…'; note('Voice input needs Chrome or Edge — you can type instead.') }
})

// ── Composer ──────────────────────────────────────────────────────────────────
function syncSend() { send.disabled = busy || (!input.value.trim() && attachments.length === 0) }
function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; syncSend() }
input.addEventListener('input', grow)
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); respond(input.value) } })
send.addEventListener('click', () => respond(input.value))
stop.addEventListener('click', () => { cancelled = true; stopSpeaking() })

// ── Real file upload: text/code direct, PDF via pdf.js, photos via on-device OCR ─
const fileInput = $('file'), attachTray = $('attach')
let attachments = []
$('plus') && $('plus').addEventListener('click', () => fileInput && fileInput.click())
fileInput && fileInput.addEventListener('change', () => { handleFiles([...fileInput.files]); fileInput.value = '' })

function humanSize(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB' }
const _scripts = {}
function lazyScript(src) { return _scripts[src] || (_scripts[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s) })) }

const NORIA_AI = 'https://noria-ai.insights-skyglobe.workers.dev'
async function extractText(file) {
  const name = (file.name || '').toLowerCase(), type = file.type || ''
  if (type.startsWith('image/')) {
    // Vision (understands the scene) + OCR (reads exact text) in parallel — most accurate.
    const [dv, ov] = await Promise.allSettled([describeImage(file), ocrImage(file)])
    const d = dv.status === 'fulfilled' ? (dv.value || '').trim() : ''
    const o = ov.status === 'fulfilled' ? (ov.value || '').trim() : ''
    let out = ''
    if (d) out += 'Visual description: ' + d
    if (o) out += (out ? '\n\n' : '') + 'Exact text read from the image (OCR): ' + o
    return out || d || o
  }
  if (type === 'application/pdf' || name.endsWith('.pdf')) return await pdfText(file)
  return await file.text()
}
// Real photo understanding via Cloudflare Workers AI (llava) — the Body's vision.
async function describeImage(file) {
  const blob = await downscale(file, 1024)
  const r = await fetch(NORIA_AI + '/vision?prompt=' + encodeURIComponent('Describe this image in detail: read any visible text exactly, and describe the objects, people, setting, colors and notable details.'), { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob })
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
async function pdfText(file) {
  await lazyScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js')
  const pdfjs = window.pdfjsLib
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
  let out = ''
  for (let p = 1; p <= Math.min(doc.numPages, 40); p++) { const pg = await doc.getPage(p); const tc = await pg.getTextContent(); out += tc.items.map((i) => i.str).join(' ') + '\n' }
  return out.trim()
}
async function ocrImage(file) {
  await lazyScript('https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js')
  const { data } = await window.Tesseract.recognize(file, 'eng')
  return ((data && data.text) || '').trim()
}
function paperclip() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8.5 12.6 17a4 4 0 0 1-5.7-5.7l8-8a2.5 2.5 0 0 1 3.5 3.5l-8 8a1 1 0 0 1-1.4-1.4l7.3-7.3"/></svg>' }
function renderTray() {
  attachTray.hidden = attachments.length === 0
  attachTray.innerHTML = ''
  attachments.forEach((a) => {
    const chip = document.createElement('div'); chip.className = 'chip' + (a.loading ? ' loading' : '')
    chip.innerHTML = (a.loading ? '<span class="spin"></span>' : paperclip()) +
      '<span class="nm">' + esc(a.name) + '</span><span class="sz">' + (a.loading ? 'reading…' : humanSize(a.size)) + '</span>'
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
      a.text = (await extractText(file)) || ''
      if (!a.text.trim()) { a.text = ''; note('I couldn’t find readable text in “' + file.name + '”.') }
    } catch (e) {
      note('I couldn’t read “' + file.name + '”. ' + (/tesseract|image/i.test(e.message) ? 'Photo reading is unavailable right now.' : /pdf/i.test(e.message) ? 'PDF reading is unavailable right now.' : ''))
      attachments = attachments.filter((z) => z.id !== a.id)
    }
    a.loading = false; renderTray(); syncSend()
  }
}
function note(t) { status.textContent = t; setTimeout(() => { if (status.textContent === t) status.textContent = '' }, 4500) }

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
  if (!atts.length && isImageRequest(q)) { await generateImage(cleanImagePrompt(q)); finish(); return }

  // Attached file/image content — goes into the SYSTEM context (engine caps the
  // query at 2000 chars), so the user's question stays short.
  const attBlock = atts.length ? '\n\n[ATTACHED BY THE USER — use this to answer their question]\n' + atts.map((a) => `[${a.preview ? 'Image' : 'File'}: ${a.name}]\n${a.text.slice(0, 6000)}`).join('\n\n') : ''

  // Live web grounding (like Gemini). Either the heuristic fires for current/world
  // questions, or a caller supplies an explicit search query (opts.web) — used by
  // guided documents to stay current (deprecated tools, live pricing, local data).
  let webBlock = '', sources = []
  const webQuery = (opts.web && String(opts.web).trim()) || ((needsWeb(q) && atts.length === 0 && !opts.noWeb) ? q : '')
  if (webQuery && atts.length === 0) {
    status.innerHTML = DOTS + ' Searching the web'
    try {
      const r = await fetch('/search?q=' + encodeURIComponent(webQuery.slice(0, 300)))
      const j = await r.json()
      sources = (j.results || []).slice(0, 5)
      if (sources.length) webBlock = '\n\n[LIVE WEB RESULTS — today is ' + new Date().toDateString() +
        '. Base your answer on these current facts and do not contradict them. Use them to avoid recommending anything retired or outdated. If they do not clearly answer the question, say what you found and that you are not certain, rather than guessing. Do not invent details beyond these results.]\n' +
        sources.map((s, i) => `(${i + 1}) ${s.title}: ${s.snippet.slice(0, 220)} — ${s.url}`).join('\n')
    } catch {}
  }

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
    const system = noriaSystem() + memoryContext(mem) +
      (kb ? `\n\n[BACKGROUND KNOWLEDGE — vetted reference notes. Prefer these where they apply, and follow all safety rules]\n${kb}` : '') +
      (opts.system ? '\n\n' + opts.system : '') +
      attBlock + webBlock
    const { display, spoken, controls } = await brain.ask2(q, { system })
    // Guided documents must come out finished — strip any placeholder scaffolding.
    const dsp = (opts.doc && display) ? cleanDocText(display) : display
    started = true; clearTimers()
    if (cancelled) { finish(); return }
    // Short entry pause, then reveal the finished answer (never fake typing).
    await new Promise((r) => setTimeout(r, plan.delivery.firstBeatDelayMs || 200))
    const el = addNoria()
    await reveal(el, dsp || spoken || "I'm here.")
    renderMd(el, dsp || spoken || "I'm here.")
    addFeedback(el.closest('.msg'), q, dsp)
    if (sources.length) addSources(el.closest('.msg'), sources)
    convoRecord({ role: 'noria', text: dsp || spoken || "I'm here.", sources: sources.map((s) => ({ url: s.url })) })
    if (controls && controls.memory) applyMemoryUpdate(mem, controls.memory)
    const sug = presence.suggestMemory(q)
    if (sug) suggestMemory(sug.value)
    const say = spoken || dsp
    if (voiceOn && say) speakNeural(say)
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
  return /\b(draw|paint|sketch|render|generate|create|make|design|produce|imagine|show me)\b[^.?!]*\b(image|picture|photo|photograph|art|artwork|illustration|drawing|painting|logo|poster|wallpaper|portrait|scene|design|icon)\b/.test(s) ||
    /^(an?\s+)?(image|picture|photo|drawing|painting|illustration|logo|portrait)\s+of\s+/.test(s)
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
    const r = await fetch(NORIA_AI + '/image?prompt=' + encodeURIComponent(prompt))
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
    el.textContent = "I couldn't create that image just now. Please try again in a moment."
    convoRecord({ role: 'err', text: "I couldn't create that image just now. Please try again in a moment." })
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
  return false
}
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
    a.innerHTML = '<img src="https://icons.duckduckgo.com/ip3/' + esc(host) + '.ico" alt="" onerror="this.remove()"><span>' + esc(host) + '</span>'
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

// ── Consent-based memory ──────────────────────────────────────────────────────
function suggestMemory(text) {
  if (document.getElementById('sugg') || !memCard) return
  const c = document.createElement('div'); c.className = 'card memsug'; c.id = 'sugg'
  c.innerHTML = '<div class="lab">✦ Noria noticed</div><p style="margin:0;font-size:.9rem">' + esc(text) + '</p><div class="acts"><button class="save">Remember this</button><button class="no">Not now</button></div>'
  memCard.parentNode.insertBefore(c, memCard)
  c.querySelector('.save').addEventListener('click', () => {
    applyMemoryUpdate(mem, { facts: [text] })
    const it = document.createElement('div'); it.className = 'memitem'; it.innerHTML = '<span class="k">•</span> ' + esc(text)
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
  c.messages.forEach((m) => {
    if (m.role === 'user') { addUser(m.text, (m.files || []).map((n) => ({ name: n }))); brain.history.push({ role: 'user', content: m.text }) }
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
        brain.history.push({ role: 'assistant', content: m.text })
      }
    }
  })
  renderConvos(); scrollDown(); closeDrawer()
}
function deleteConversation(id) {
  convos = convos.filter((c) => c.id !== id); saveStore()
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
$('forget') && $('forget').addEventListener('click', () => {
  forgetMemory(); if (memCard) memCard.innerHTML = '<div class="memitem" style="color:var(--muted)">Memory cleared for this device.</div>'
  const s = document.getElementById('sugg'); if (s) s.remove()
})

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
  monthly: { amt: '$35', per: '/ month', note: 'Billed monthly. Cancel anytime.' },
  annual: { amt: '$28', per: '/ month', note: 'Billed $336 per year — save 20%. Cancel anytime.' },
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
function openPro() { closeAllModals(); if (proModal) { proModal.hidden = false; if (proMsg) { proMsg.textContent = ''; proMsg.className = 'pm-msg' } } }
function closePro() { if (proModal) proModal.hidden = true }
proBtn && proBtn.addEventListener('click', openPro)
$('proClose') && $('proClose').addEventListener('click', closePro)
proModal && proModal.addEventListener('click', (e) => { if (e.target === proModal) closePro() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAllModals() })
$('segMonthly') && $('segMonthly').addEventListener('click', () => setBilling('monthly'))
$('segAnnual') && $('segAnnual').addEventListener('click', () => setBilling('annual'))
$('proSubscribe') && $('proSubscribe').addEventListener('click', () => startCheckout(billing))
function startCheckout(period) {
  // In-app Paddle checkout is wired here once the Paddle keys are provided — payment
  // and Pro happen entirely inside Noria, never on an external site.
  if (proMsg) { proMsg.textContent = 'Secure in-app checkout is coming — for now, use an access code below to unlock Pro.'; proMsg.className = 'pm-msg' }
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
  { id: 'visa', title: 'Visa preparation', icon: ICON + '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    desc: 'Current requirements, a checklist of your own genuine documents, and a cover letter you can adapt.',
    fields: [{ k: 'nationality', label: 'Your nationality', ph: 'e.g. Kenyan' }, { k: 'destination', label: 'Destination country', ph: 'e.g. Canada' }, { k: 'type', label: 'Visa type', ph: 'e.g. study / work / visit' }, { k: 'purpose', label: 'Purpose of the trip (optional)', ph: 'brief and honest', long: true, optional: true }],
    prompt: (v) => `Prepare a visa preparation guide for a ${v.nationality} national applying for a ${v.type} visa to ${v.destination}${v.purpose ? `. Purpose of the trip: ${v.purpose}` : ''}.`,
    web: (v) => `${v.type} visa ${v.destination} requirements ${YEAR}`,
    system: () => 'Produce a VISA PREPARATION GUIDE with markdown headings: # Visa Preparation Guide, ## Overview, ## Eligibility & Key Requirements, ## Document Checklist (only the genuine documents the applicant gathers — valid passport, their own bank statements, employment or enrolment letter, proof of real ties to home), ## Demonstrating a Strong, Honest Application, ## Common Refusal Reasons & How to Avoid Them, ## Sample Cover Letter. Never fabricate documents, invitations or ties, or suggest doing so — only guide the applicant\'s own genuine case. Name the official embassy or immigration website as the source of truth for exact current fees and forms. Never guarantee approval. End with a short honest disclaimer.' },
  { id: 'business', title: 'Business plan', icon: ICON + '<path d="M4 20V10M10 20V4M16 20v-8M2 20h20"/></svg>',
    desc: 'A structured, realistic business plan grounded in current market data.',
    fields: [{ k: 'name', label: 'Business name', ph: 'e.g. Sunrise Cafe' }, { k: 'what', label: 'What the business does', ph: 'one line', long: true }, { k: 'where', label: 'Location / market (optional)', ph: 'e.g. Accra, Ghana', optional: true }],
    prompt: (v) => `Write a business plan for "${v.name}"${v.where ? ` based in ${v.where}` : ''}. What it does: ${v.what}.`,
    web: (v) => `${v.what} business ${v.where || ''} market ${YEAR}`.trim(),
    system: (v) => 'Produce a realistic BUSINESS PLAN with markdown headings: # ' + v.name + ' — Business Plan, ## Executive Summary, ## Problem & Solution, ## Products/Services, ## Target Market, ## Competition & Advantage, ## Marketing & Sales, ## Operations, ## Team, ## Financial Plan (label all figures as illustrative estimates to validate; use local currency and realistic local costs when a location is given), ## Milestones, ## Risks & Mitigations. Do not present invented statistics as fact.' },
  { id: 'cv', title: 'CV / Résumé', icon: ICON + '<circle cx="12" cy="8" r="3.2"/><path d="M5 20a7 7 0 0 1 14 0"/></svg>',
    desc: 'A polished, ATS-friendly CV from your real details.',
    fields: [{ k: 'name', label: 'Full name', ph: 'e.g. Amina Bello' }, { k: 'role', label: 'Target role / field', ph: 'e.g. Registered Nurse' }, { k: 'details', label: 'Your experience, skills & education', ph: 'roles, years, skills, schools — paste what you have', long: true }],
    prompt: (v) => `Write a polished, ATS-friendly CV for ${v.name}, targeting a ${v.role} role. Real details to use: ${v.details}`,
    system: (v) => 'Produce a polished, ATS-friendly CV using ONLY the real details provided (never invent employers, dates, titles or qualifications). Markdown: # ' + v.name + ', then a one-line professional headline, ## Professional Summary, ## Key Skills, ## Experience (strong action verbs; quantify only where numbers were given), ## Education, ## Additional. Keep it to one to two pages of content and use standard section names ATS parsers recognise.' },
  { id: 'cover', title: 'Cover letter', icon: ICON + '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
    desc: 'A tailored, sincere cover letter.',
    fields: [{ k: 'name', label: 'Your name', ph: 'e.g. Amina Bello' }, { k: 'role', label: 'Role / position', ph: 'e.g. Marketing Manager at Acme' }, { k: 'background', label: 'Your relevant background', ph: 'key experience & why you fit', long: true }],
    prompt: (v) => `Write a cover letter for ${v.name} applying for: ${v.role}. Base it only on: ${v.background}`,
    system: () => 'Produce a warm, professional, genuine cover letter based only on the details provided — 3 to 4 tight paragraphs, specific and sincere, no clichés or fabricated achievements. Markdown: the applicant\'s name as a # heading, the letter body, then a professional sign-off.' },
  { id: 'travel', title: 'Travel plan', icon: ICON + '<path d="M2 12l20-8-8 20-2-8-8-4z"/></svg>',
    desc: 'A practical day-by-day itinerary with current, realistic detail.',
    fields: [{ k: 'destination', label: 'Destination', ph: 'e.g. Nairobi' }, { k: 'days', label: 'How many days', ph: 'e.g. 5' }, { k: 'focus', label: 'Interests / budget (optional)', ph: 'e.g. culture, mid-range', optional: true }],
    prompt: (v) => `Create a ${v.days}-day travel itinerary for ${v.destination}${v.focus ? ` (${v.focus})` : ''}.`,
    web: (v) => `${v.destination} travel guide ${YEAR} attractions cost`,
    system: (v) => `Produce a practical day-by-day itinerary. Markdown: # ${v.destination} — ${v.days}-Day Itinerary, ## Overview & Best Time to Go, then ## Day 1 through ## Day ${v.days} (each with morning / afternoon / evening), ## Getting Around, ## Where to Stay, ## Budget (local currency ranges), ## Practical Notes. Opening hours and prices change — say they must be confirmed and never present them as fixed fact.` },
  { id: 'career', title: 'Career roadmap', icon: ICON + '<path d="M6 3v11a3 3 0 0 0 3 3h6"/><path d="M15 14l3 3-3 3"/></svg>',
    desc: 'A phased, current plan to reach your goal — local and remote.',
    fields: [{ k: 'goal', label: 'Your goal', ph: 'e.g. become a data analyst' }, { k: 'now', label: 'Where you are now', ph: 'current skills / situation', long: true }, { k: 'location', label: 'Your city / country (optional)', ph: 'e.g. Kumasi, Ghana', optional: true }, { k: 'time', label: 'Timeframe (optional)', ph: 'e.g. 12 months', optional: true }],
    prompt: (v) => `Build a career roadmap to reach: ${v.goal}${v.time ? ` within ${v.time}` : ''}. Starting point: ${v.now}.${v.location ? ` Location: ${v.location}.` : ''}`,
    web: (v) => `${v.goal} skills tools salary ${YEAR} ${v.location || ''}`.trim(),
    system: () => 'Produce a step-by-step CAREER ROADMAP. Markdown: # Career Roadmap, ## Where You Are & Where You\'re Going, ## Skills to Build (name current, in-demand tools), ## Step-by-Step Plan (phased, concrete actions with free or low-cost current resources), ## Portfolio / Proof to Build, ## Finding Opportunities (real current channels, both local and remote), ## Milestones. Frame timelines and salary ranges as estimates to verify, never guarantees.' },
  { id: 'roadmap', title: 'Tech / Dev roadmap', icon: ICON + '<path d="M8 6l-5 6 5 6M16 6l5 6-5 6"/></svg>',
    desc: 'A modern, job-ready developer roadmap: current stack, real projects, code, and pacing.',
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
]
const guidesEl = $('guides'), guideModal = $('guideModal')
let activeGuide = null
function renderGuides() {
  if (!guidesEl) return
  guidesEl.innerHTML = ''
  GUIDES.forEach((g) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'guide-chip'; b.innerHTML = g.icon + '<span>' + g.title + '</span>'; b.addEventListener('click', () => openGuide(g.id)); guidesEl.appendChild(b) })
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
    const inp = f.long ? document.createElement('textarea') : document.createElement('input')
    inp.id = 'gf_' + f.k; inp.placeholder = f.ph || ''; inp.dataset.k = f.k; inp.dataset.optional = f.optional ? '1' : ''
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
  $('guideFields').querySelectorAll('input,textarea').forEach((inp) => { v[inp.dataset.k] = inp.value.trim(); if (!inp.value.trim() && inp.dataset.optional !== '1') missing = true })
  if (missing) { $('guideMsg').textContent = 'Please fill in the required fields.'; $('guideMsg').className = 'pm-msg err'; return }
  const summary = activeGuide.fields.map((f) => (v[f.k] || '').slice(0, 40)).filter(Boolean).slice(0, 3).join(' · ')
  closeGuide()
  respond(activeGuide.prompt(v), { display: activeGuide.title + (summary ? ': ' + summary : ''), doc: true, system: (activeGuide.system ? activeGuide.system(v) : '') + MODERN_STANDARD + DOC_RULES, web: activeGuide.web ? activeGuide.web(v) : '', noWeb: !activeGuide.web })
})
renderGuides()

// Service worker retired: do NOT register one, and clean up any existing one
// (the old worker caused hang / stale-code issues). The app loads from the network.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {})
  if (window.caches && caches.keys) caches.keys().then((ks) => ks.forEach((k) => caches.delete(k))).catch(() => {})
}
