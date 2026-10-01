/**
 * Virtual Noria — wiring (System 4: Body OS orchestration in the browser).
 * Ties the face (System 5), audio (System 3), vision stand-in (System 2) and the
 * embodiment layer to the live Noria Engine via the Body-OS proxy.
 */
import { VideoFace } from './video-face.js'
import { Embodiment } from './embodiment.js'
import { Brain, detectLang, toSpeech } from './brain.js'
import { noriaSystem } from './persona.js'
import { initMemory, memoryContext, applyMemoryUpdate, forgetMemory } from './memory.js'
import { retrieveKnowledge } from './knowledge.js'
import { neuralVoice } from './voice.js'

const $ = (id) => document.getElementById(id)
const canvas = $('face')
let variant = (() => { try { return localStorage.getItem('noria.variant') === 'M' ? 'M' : 'F' } catch { return 'F' } })()
const face = new VideoFace(canvas, variant)
const body = new Embodiment(face)
const brain = new Brain()
window.__face = face // debug handle

// Persistent memory of the returning person (this browser).
const { m: mem, returning } = initMemory()

// ── Render loop ─────────────────────────────────────────────────────────────
let last = performance.now()
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now
  face.update(dt); face.draw()
  requestAnimationFrame(loop)
}
requestAnimationFrame(loop)

// ── Brain status ──────────────────────────────────────────────────────────
const statusEl = $('status')
brain.health().then((h) => {
  const up = h.status === 'ok'
  statusEl.className = 'status ' + (up ? 'up' : 'down')
  statusEl.innerHTML = `<span class="dot"></span>` + (up ? `Online` : `Reconnecting…`)
})

// ── Transcript ──────────────────────────────────────────────────────────────
const transcript = $('transcript')
function bubble(cls, text) {
  const el = document.createElement('div')
  el.className = 'bubble ' + cls; el.textContent = text
  transcript.appendChild(el); transcript.scrollTop = transcript.scrollHeight
  return el
}
const chip = (s) => ($('statechip').textContent = s)

// Minimal, safe markdown → HTML for Noria's chat text (code blocks, inline code,
// bold, line breaks). Everything is HTML-escaped first, so it's injection-safe.
function esc(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
function renderMd(el, text) {
  const blocks = []
  let h = String(text).replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, c) => { blocks.push(c.replace(/\n$/, '')); return `${blocks.length - 1}` })
  h = esc(h)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>')
    .replace(/(\d+)/g, (_, i) => `<pre class="code">${esc(blocks[i])}</pre>`)
  el.innerHTML = h
}

// 👍/👎 under Noria's answers → the Engine's feedback/review pipeline (learning).
function addFeedback(el, question, answer) {
  const bar = document.createElement('div'); bar.className = 'fb'
  const mk = (label, rating) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label
    b.addEventListener('click', () => {
      brain.sendFeedback(rating, question, answer)
      bar.querySelectorAll('button').forEach((x) => (x.disabled = true))
      b.classList.add('on')
      const t = document.createElement('span'); t.className = 'fbthx'; t.textContent = 'thanks — noted'
      bar.appendChild(t)
    })
    return b
  }
  bar.append(mk('👍', 'up'), mk('👎', 'down'))
  el.appendChild(bar)
}

// ── Speaking ──────────────────────────────────────────────────────────────
// Natural, non-robotic voice with zero silence risk: she uses the INSTANT
// browser voice right away, and AUTO-UPGRADES to the on-device neural voice
// (Kokoro — genuinely human-sounding, free, cached after one download) in the
// background. Once it's ready she switches to it; until then the browser voice
// covers her. Set window.NORIA_NEURAL_VOICE = false to stay on browser voice.
let useNeural = false
const wantNeural = window.NORIA_NEURAL_VOICE !== false
let _warmingNeural = false
function warmNeural() {
  if (_warmingNeural || useNeural || !wantNeural) return
  _warmingNeural = true
  neuralVoice.warmup((s) => { if (window.NORIA_DEBUG) console.log('neural voice:', s) })
    .then((ok) => { useNeural = ok; if (window.NORIA_DEBUG) console.log('neural voice ready:', ok) })
    .catch(() => {})
}
// Warm the neural voice on the first real interaction (a user gesture also lets
// audio play), so people who just glance at the page don't download the model.
;['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, warmNeural, { once: true, passive: true }))
// Reliable natural voice via Cloudflare (MeloTTS) — the same one the workspace
// uses. iOS only allows audio that starts inside a gesture, so we unlock first.
const TTS_URL = 'https://noria-ai.insights-skyglobe.workers.dev/tts'
const ttsAudio = new Audio()
let audioUnlocked = false
function unlockAudio() {
  if (audioUnlocked) return; audioUnlocked = true
  try { ttsAudio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='; ttsAudio.play().catch(() => {}) } catch {}
}
window.addEventListener('pointerdown', unlockAudio, { once: true })
let speakGen = 0
// Split cleaned text into <=maxLen chunks at sentence/line boundaries; the trailing
// remainder is always kept (force-flush) so the last words are never dropped.
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
function stopAllSpeech() { speakGen++; try { ttsAudio.pause() } catch {} try { neuralVoice.cancel() } catch {} brain.stopSpeaking() }
// Resolves when playback STARTS (so we know the natural voice is working); calls
// onDone when it finishes; rejects on fetch/play failure.
function speakCloud(text, onDone) {
  const clean = toSpeech(text) // strip markdown/symbols/emoji so the voice never reads them
  return new Promise((resolveStart, reject) => {
    const chunks = chunkForSpeech(clean)
    if (!chunks.length) { reject(new Error('empty')); return }
    const gen = ++speakGen
    const speaker = variant === 'M' ? 'orion' : 'hera'
    // One request at a time (single 1-chunk prefetch); short backoff-retry on a
    // transient 429/network blip so a middle chunk of a long reply isn't dropped.
    const fetchBlob = async (txt) => {
      for (let attempt = 0; ; attempt++) {
        let r
        try { r = await fetch(TTS_URL + '?speaker=' + speaker + '&text=' + encodeURIComponent(txt)) }
        catch (e) { if (attempt >= 2) throw e; await new Promise((res) => setTimeout(res, 400 + attempt * 500)); continue }
        if (r.ok) return await r.blob()
        if (r.status === 429 && attempt < 2) { await new Promise((res) => setTimeout(res, 600 + attempt * 700)); continue }
        throw new Error('tts ' + r.status)
      }
    }
    let started = false
    let prefetch = fetchBlob(chunks[0]) // full text, played chunk-by-chunk (no 1800-char cut-off)
    const step = (i) => {
      if (gen !== speakGen) return // superseded by a newer speak or stopAllSpeech
      const cur = prefetch
      if (i + 1 < chunks.length) prefetch = fetchBlob(chunks[i + 1]) // prefetch next → no gaps
      cur.then((blob) => {
        if (gen !== speakGen) return
        const url = URL.createObjectURL(blob)
        try { ttsAudio.pause() } catch {}
        ttsAudio.src = url
        ttsAudio.onended = () => { URL.revokeObjectURL(url); if (gen !== speakGen) return; if (i + 1 < chunks.length) step(i + 1); else onDone && onDone() }
        ttsAudio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('audio error')) }
        ttsAudio.play().then(() => { if (!started) { started = true; resolveStart() } }).catch(reject)
      }).catch(reject)
    }
    step(0)
  })
}
function speakNoria(text, opts = {}) {
  return new Promise((resolve) => {
    if (!text || !text.trim()) { resolve(); return }
    let settled = false
    const done = () => { if (settled) return; settled = true; face.setSpeaking(false); resolve() }
    const browserVoice = () => { if (settled) return; brain.speak(text, { variant, ...opts, onStart: () => face.setSpeaking(true), onWord: () => face.pulseMouth(1), onEnd: done }) }
    if (detectLang(text) !== 'en') { browserVoice(); return } // browser reads other languages
    // Natural neural voice (Deepgram Aura via Cloudflare) — reliable; browser only
    // if it genuinely fails or is unusually slow (>6s).
    face.setSpeaking(true)
    let fellBack = false
    const t = setTimeout(() => { fellBack = true; browserVoice() }, 6000)
    speakCloud(text, done)
      .then(() => { if (fellBack) { try { ttsAudio.pause() } catch {} } else clearTimeout(t) })
      .catch(() => { clearTimeout(t); if (!fellBack) browserVoice() })
  })
}

// Noria's live emotional/presence state (per your spec) — updated every turn and
// used to shape her tone, voice pace, and (offline) SadTalker parameters. Exposed
// as window.__noriaState for inspection. Additive: nothing persists to storage.
const session = { emotion: 'warm', energy: 0.5, attention: 0.6, conversation_mode: 'casual', rapport: 0.3, user_emotion: 'neutral' }
window.__noriaState = session
const _EMO_ENERGY = { joy: 0.9, happy: 0.9, bright: 0.9, playful: 0.85, curious: 0.72, warm: 0.62, supportive: 0.5, focused: 0.58, neutral: 0.5, calm: 0.4, annoyed: 0.55, concerned: 0.34, concern: 0.34 }
function updateState(c) {
  const emo = c.emotion || 'warm'
  const act = c.conversation_action || 'respond'
  session.emotion = emo
  session.energy = _EMO_ENERGY[emo] ?? 0.5
  session.conversation_mode = act === 'urgent_support' ? 'urgent'
    : (emo === 'concerned' || emo === 'concern' || emo === 'supportive') ? 'support'
    : (emo === 'focused') ? 'task' : 'casual'
  session.attention = (act === 'listen' || act === 'pause') ? 0.9 : 0.6
  session.rapport = Math.min(1, session.rapport + 0.05)
}
// Energy → a natural default voice pace when the model doesn't specify one.
function paceForEnergy(e) { return e > 0.75 ? 'energetic' : e < 0.4 ? 'slow' : 'natural' }

// ── Respond: one full turn (used by both typing and live conversation) ─────────
let busy = false
async function respond(query) {
  query = (query || '').trim(); if (!query) return
  bubble('you', query)
  chip('thinking'); body.react('', 'thinking')
  const out = bubble('noria', '')
  out.classList.add('thinking')
  out.innerHTML = '<span class="typing" role="status" aria-label="Noria is thinking"><i></i><i></i><i></i></span>'
  try {
    // Ground the answer in vetted reference notes when the question matches any.
    const kb = retrieveKnowledge(query)
    const system = noriaSystem() + memoryContext(mem) +
      (kb ? `\n\n[BACKGROUND KNOWLEDGE — vetted reference notes. Prefer these over your own recall where they apply, weave them in naturally, and still follow all your safety rules]\n${kb}` : '')
    const { display, spoken, controls } = await brain.ask2(query, { system })
    out.classList.remove('thinking')
    renderMd(out, display)
    addFeedback(out, query, display)
    if (controls && controls.memory) applyMemoryUpdate(mem, controls.memory)
    if (controls) {
      face.applyControls(controls)
      updateState(controls)
      if (window.NORIA_DEBUG) console.log('NORIA controls', controls, session)
    }
    const pace = (controls && controls.speaking_pace) || paceForEnergy(session.energy)
    const vopts = { tone: controls && controls.voice_tone, pace }
    if (presenceOn) setCaption(spoken) // live subtitle of what she's saying
    // Speak whenever there is something to say. (Previously a "listen"/"pause"
    // tag from the model silenced any reply over 60 chars — the cause of her
    // sometimes not talking at all. Now spoken_text is voiced whenever present.)
    // Read the FULL answer she wrote (display), not just the short spoken summary,
    // so she never sounds like she's cutting her own message short. brain.speak
    // strips markdown/symbols and chunks long text so it never cuts off.
    const toSpeak = (display && display.trim()) ? display : spoken
    if (toSpeak && toSpeak.trim()) { chip('speaking'); await speakNoria(toSpeak, vopts) }
    chip(convo.on ? 'listening' : 'idle')
    return controls
  } catch (e) {
    out.textContent = '⚠️ ' + e.message; face.setExpression('concerned')
  } finally {
    chip(convo.on ? 'listening' : 'idle')
  }
}

async function ask(query) {
  if (busy) return; busy = true; $('send').disabled = true
  try { await respond(query) } finally { busy = false; $('send').disabled = false }
}

$('send').addEventListener('click', () => { const t = $('text'); ask(t.value); t.value = '' })
$('text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { ask(e.target.value); e.target.value = '' } })

// ── Live conversation mode: patient listening + smooth, human turn-taking ─────
// ONE tap starts it; then fully hands-free. She listens continuously and waits
// ~1.4s of silence before replying, so she never cuts you off mid-thought.
// Half-duplex (mic pauses while she speaks → no echo). Tap Noria (or End) to cut in.
const convo = { on: false, rec: null, processing: false }
let _silence = null, _finalText = ''

function beginListen() {
  if (!convo.on || convo.processing || face.speaking) return
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  const rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = true
  convo.rec = rec; _finalText = ''
  face.setListening(true); chip('listening')
  rec.onresult = (e) => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      if (r.isFinal) _finalText += r[0].transcript + ' '; else interim += r[0].transcript
    }
    $('text').value = (_finalText + interim).trim()
    // Reset the end-of-turn timer on every word → she keeps waiting while you talk.
    clearTimeout(_silence)
    if ((_finalText + interim).trim().length >= 2) _silence = setTimeout(endTurn, 1400)
  }
  rec.onerror = () => {}
  rec.onend = () => { if (convo.on && !convo.processing && !face.speaking) setTimeout(beginListen, 250) }
  try { rec.start() } catch { setTimeout(beginListen, 400) }
}

async function endTurn() {
  clearTimeout(_silence)
  const said = (_finalText || $('text').value || '').trim()
  _finalText = ''; $('text').value = ''
  if (!convo.on) return
  if (said.replace(/\s+/g, '').length < 3) { beginListen(); return } // ignore noise/too short
  convo.processing = true
  try { convo.rec && convo.rec.stop() } catch {}   // pause mic while she thinks/speaks
  convo.rec = null; face.setListening(false)
  await respond(said)                              // resolves when she finishes speaking
  convo.processing = false
  if (convo.on) beginListen()                      // hands-free: straight back to listening
}

async function startConvo() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) { bubble('noria', 'Live voice needs Chrome or Edge — you can type instead.'); return }
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); s.getTracks().forEach((t) => t.stop()) }
  catch { bubble('noria', 'I need microphone permission to talk live.'); return }
  convo.on = true; $('talk').classList.add('on'); syncTalkLabels()
  bubble('noria', "I'm listening — just talk to me. Tap my face any time to jump in.")
  if (presenceOn) setCaption("I'm listening…")
  beginListen()
}
function stopConvo() {
  convo.on = false; convo.processing = false; clearTimeout(_silence)
  $('talk').classList.remove('on'); syncTalkLabels()
  face.setListening(false); stopAllSpeech()
  if (convo.rec) { try { convo.rec.stop() } catch {} convo.rec = null }
  chip('idle')
}
$('talk').addEventListener('click', () => (convo.on ? stopConvo() : startConvo()))
// Tap Noria to interrupt her mid-sentence, then she listens again immediately.
document.querySelector('.face-wrap').addEventListener('click', () => {
  if (face.speaking) { stopAllSpeech(); face.setSpeaking(false); if (convo.on) { convo.processing = false; beginListen() } }
})

// ── Presence mode: life-size, immersive Noria (feels physically present) ──────
// Fills the screen like a video call, shows spoken captions, and hides the chat
// UI down to a minimal bar. Uses real fullscreen when the browser allows it
// (works standalone and embedded when the iframe permits fullscreen).
const appEl = document.querySelector('.app')
const captionEl = $('caption')
let presenceOn = false
function setCaption(t) { if (captionEl) captionEl.textContent = (t || '').trim() }
function syncTalkLabels() {
  const live = convo.on
  if ($('pTalk')) { $('pTalk').textContent = live ? 'End' : 'Talk to me'; $('pTalk').classList.toggle('on', live) }
}
function setPresence(on) {
  presenceOn = on
  appEl.classList.toggle('presence', on)
  try {
    if (on && !document.fullscreenElement && appEl.requestFullscreen) appEl.requestFullscreen().catch(() => {})
    else if (!on && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {})
  } catch {}
  setTimeout(() => window.dispatchEvent(new Event('resize')), 60) // re-fit the canvas to the new size
  if (on) { setCaption(''); syncTalkLabels() }
}
const presenceBtn = $('presence')
if (presenceBtn) presenceBtn.addEventListener('click', () => setPresence(!presenceOn))
if ($('pTalk')) $('pTalk').addEventListener('click', () => (convo.on ? stopConvo() : startConvo()))

// ── AR: place Noria in your real room ─────────────────────────────────────────
// Shows the (back) camera full-screen behind the transparent Noria cutout, so
// she appears standing in your space. Free camera-composite AR — no app needed.
let arOn = false, arStream = null
async function setAR(on) {
  if (on) {
    try {
      arStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
    } catch (e) { bubble('noria', 'I need camera access to appear in your room.'); return }
    const v = $('arbg'); v.srcObject = arStream; try { await v.play() } catch {}
    arOn = true; appEl.classList.add('ar'); setPresence(true)
    if (presenceOn) setCaption('Move your phone to place me in the room.')
  } else {
    arOn = false; appEl.classList.remove('ar')
    if (arStream) { arStream.getTracks().forEach((t) => t.stop()); arStream = null }
    $('arbg').srcObject = null
    setPresence(false)
  }
}
if ($('ar')) $('ar').addEventListener('click', () => setAR(!arOn))
if ($('pAR')) $('pAR').addEventListener('click', () => setAR(!arOn))
if ($('pExit')) $('pExit').addEventListener('click', () => (arOn ? setAR(false) : setPresence(false)))
if ($('pClose')) $('pClose').addEventListener('click', () => (arOn ? setAR(false) : setPresence(false)))
// Keep presence/AR in sync if the user leaves fullscreen with Esc / browser UI.
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && presenceOn) { arOn ? setAR(false) : setPresence(false) } })

// ── Mic (speech in) — clear listening state + live transcription ─────────────
let rec = null
const listeningEl = $('listening'), liveTranscript = $('liveTranscript')
function startMic() {
  if (rec) { rec.stop(); return }           // tap again to stop
  face.setListening(true); chip('listening'); $('mic').classList.add('on')
  if (listeningEl) listeningEl.classList.add('on')
  if (liveTranscript) liveTranscript.textContent = ''
  rec = brain.listen({
    onResult: (partial) => { $('text').value = partial; if (liveTranscript) liveTranscript.textContent = partial },
    onEnd: (finalText, err) => {
      rec = null; face.setListening(false); $('mic').classList.remove('on'); chip('idle')
      if (listeningEl) listeningEl.classList.remove('on')
      if (err === 'unsupported') { bubble('noria', 'Voice input needs Chrome or Edge. You can type instead.'); return }
      const t = ($('text').value || finalText || '').trim()
      $('text').value = ''
      if (t) ask(t)                          // Noria then answers — and speaks the reply
    },
  })
}
$('mic').addEventListener('click', startMic)
// Tap anywhere on the listening panel to stop and send.
if (listeningEl) listeningEl.addEventListener('click', (e) => { e.stopPropagation(); if (rec) rec.stop() })

// ── Noria F / M toggle — instant swap, remembered across sessions ─────────────
const vsegs = document.querySelectorAll('.variant-toggle .vseg')
function setVariant(v, save = true) {
  variant = v === 'M' ? 'M' : 'F'
  face.setVariant(variant)
  vsegs.forEach((b) => { const on = b.dataset.v === variant; b.classList.toggle('on', on); b.setAttribute('aria-selected', on) })
  if (save) { try { localStorage.setItem('noria.variant', variant) } catch {} }
}
vsegs.forEach((b) => b.addEventListener('click', () => { if (b.dataset.v !== variant) setVariant(b.dataset.v) }))
setVariant(variant, false) // reflect the loaded choice in the toggle on start

// ── Vision (System 2 stand-in): gaze follows cursor over the stage, + webcam ──
const wrap = document.querySelector('.face-wrap')
let visionOn = false
$('vision').addEventListener('change', async (e) => {
  visionOn = e.target.checked
  const cam = $('cam')
  if (visionOn) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 160, height: 120 } })
      cam.srcObject = stream; cam.hidden = false; await cam.play()
      trackFace(cam)
    } catch { /* no camera → cursor-follow still works */ }
  } else {
    const s = cam.srcObject; if (s) s.getTracks().forEach((t) => t.stop())
    cam.hidden = true; face.lookAt(0, 0)
  }
})
wrap.addEventListener('mousemove', (ev) => {
  if (!visionOn) return
  const r = wrap.getBoundingClientRect()
  face.lookAt(((ev.clientX - r.left) / r.width) * 2 - 1, ((ev.clientY - r.top) / r.height) * 2 - 1)
})

// Optional real face tracking if the browser exposes FaceDetector (Chrome flag).
async function trackFace(video) {
  if (!('FaceDetector' in window)) return
  const fd = new window.FaceDetector({ fastMode: true })
  const step = async () => {
    if (!visionOn) return
    try {
      const faces = await fd.detect(video)
      if (faces[0]) {
        const b = faces[0].boundingBox
        const cx = (b.x + b.width / 2) / video.videoWidth
        const cy = (b.y + b.height / 2) / video.videoHeight
        face.lookAt((0.5 - cx) * 2, (cy - 0.5) * 2) // mirror X
      }
    } catch {}
    setTimeout(step, 180)
  }
  step()
}

// Greeting — TEXT only. She never speaks unprompted (only when you message her
// or use 🎙 Talk), so no surprise "voice from nowhere" on page load.
setTimeout(() => {
  face.setExpression('smile'); face.gesture('greet')
  const name = mem && mem.profile && mem.profile.name
  if (returning) {
    bubble('noria', name
      ? `Welcome back, ${name}. Lovely to see you again — how can I help today?`
      : `Welcome back. Good to see you again — what can I help you with?`)
  }
}, 600)

// "Forget me" — privacy control: wipe what this browser remembers.
const fm = $('forget')
if (fm) fm.addEventListener('click', () => { forgetMemory(); bubble('noria', "Done — I've cleared what I remembered on this device."); })

// 🔊 Test voice — one click to check audio output (no console needed).
const tv = $('testvoice')
if (tv) tv.addEventListener('click', () => {
  unlockAudio()
  const line = 'Hello, this is a Noria voice test. If you can hear me, the voice is working.'
  bubble('noria', line); chip('speaking')
  speakNoria(line).then(() => chip('idle'))
})
