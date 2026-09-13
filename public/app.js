/**
 * Virtual Noria — wiring (System 4: Body OS orchestration in the browser).
 * Ties the face (System 5), audio (System 3), vision stand-in (System 2) and the
 * embodiment layer to the live Noria Engine via the Body-OS proxy.
 */
import { ImageFace } from './image-face.js'
import { Embodiment } from './embodiment.js'
import { Brain } from './brain.js'
import { noriaSystem } from './persona.js'

const $ = (id) => document.getElementById(id)
const canvas = $('face')
let variant = 'F'
const face = new ImageFace(canvas, variant)
const body = new Embodiment(face)
const brain = new Brain()

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
  statusEl.innerHTML = `<span class="dot"></span>` + (up ? `brain online · ${h.provider || 'engine'}` : `brain unreachable`)
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

// ── Ask flow ──────────────────────────────────────────────────────────────
let busy = false
async function ask(query) {
  query = (query || '').trim()
  if (!query || busy) return
  busy = true; $('send').disabled = true
  bubble('you', query)
  chip('thinking'); body.react('', 'thinking')
  const out = bubble('noria', '…')
  let acc = ''
  try {
    const { reply, controls } = await brain.ask2(query, { system: noriaSystem() })
    out.textContent = reply
    // Her silent self-assessment drives the face; detailed face/mouth fields
    // await the Stage-2 photoreal engine but are produced and logged now.
    if (controls) { face.applyControls(controls); if (window.NORIA_DEBUG) console.log('NORIA controls', controls) }
    const voice = (controls && controls.voice) || {}
    const emotion = body.emotionFor(reply)
    chip('speaking')
    brain.speak(reply, {
      variant, emotion, pace: voice.pace, tone: voice.tone,
      onStart: () => { face.setSpeaking(true) },
      onWord: () => face.pulseMouth(1),
      onEnd: () => { face.setSpeaking(false); chip('idle'); body.react('', 'idle') },
    })
  } catch (e) {
    out.textContent = '⚠️ ' + e.message
    body.react('sorry', 'speaking'); face.setExpression('concerned'); chip('idle')
  } finally {
    busy = false; $('send').disabled = false
  }
}

$('send').addEventListener('click', () => { const t = $('text'); ask(t.value); t.value = '' })
$('text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { ask(e.target.value); e.target.value = '' } })

// ── Mic (speech in) ─────────────────────────────────────────────────────────
let rec = null
$('mic').addEventListener('click', () => {
  if (rec) { rec.stop(); return }
  face.setListening(true); chip('listening'); $('mic').classList.add('on')
  rec = brain.listen({
    onResult: (partial) => { $('text').value = partial },
    onEnd: (finalText, err) => {
      rec = null; face.setListening(false); $('mic').classList.remove('on'); chip('idle')
      if (err === 'unsupported') { bubble('noria', 'Voice input needs Chrome/Edge. You can type instead.'); return }
      const t = ($('text').value || finalText || '').trim()
      $('text').value = ''
      if (t) ask(t)
    },
  })
})

// ── Variant toggle ──────────────────────────────────────────────────────────
document.querySelectorAll('input[name=variant]').forEach((r) =>
  r.addEventListener('change', (e) => { if (e.target.checked) { variant = e.target.value; face.setVariant(variant) } })
)

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

// Greeting once the brain status is known.
setTimeout(() => { face.setExpression('smile'); face.gesture('greet') }, 600)
