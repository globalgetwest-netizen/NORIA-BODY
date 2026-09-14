/**
 * NORIA FACE (image variant) — a LIVING PORTRAIT of the real Noria renders.
 *
 * Instead of drawing a cartoon, this shows the actual Noria-F / Noria-M image
 * and animates it: head sway, breathing, gaze parallax, blink, and a speaking
 * mouth pulse. Same public API as the procedural face, so the rest of the Body
 * (engine link, audio, embodiment layer) is unchanged.
 *
 * Per-image calibration (eye + mouth positions, normalized 0..1) lets the blink
 * and mouth animation land on the right spot. Tune CAL after adding the images.
 */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const lerp = (a, b, t) => a + (b - a) * t
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d)

const CAL = {
  // srcs: tried in order until one loads. eyes/mouth are normalized [x,y]; r are [rx,ry].
  // Calibrated to the real renders (noria-f.png 1254×1254, noria-m.png 1054×1492).
  F: {
    // cutout = full body on a TRANSPARENT background (stands on any scene / AR).
    cutout: ['assets/noria-f-cutout.png', 'assets/noria-f-cutout.webp'],
    srcs: ['assets/noria-f.png', 'assets/noria-f.jpg', 'assets/noria-f.jpeg', 'assets/noria-f.webp'],
    full: ['assets/noria-f-full.png', 'assets/noria-f-full.jpg', 'assets/noria-f-full.jpeg', 'assets/noria-f-full.webp'],
    eyes: [[0.40, 0.347], [0.59, 0.347]], eyeR: [0.052, 0.024],
    mouth: [0.49, 0.55], mouthR: [0.075, 0.03],
  },
  M: {
    cutout: ['assets/noria-m-cutout.png', 'assets/noria-m-cutout.webp'],
    srcs: ['assets/noria-m.png', 'assets/noria-m.jpg', 'assets/noria-m.jpeg', 'assets/noria-m.webp'],
    full: ['assets/noria-m-full.png', 'assets/noria-m-full.jpg', 'assets/noria-m-full.jpeg', 'assets/noria-m-full.webp'],
    eyes: [[0.445, 0.342], [0.588, 0.342]], eyeR: [0.05, 0.023],
    mouth: [0.505, 0.525], mouthR: [0.07, 0.03],
  },
}

export class ImageFace {
  constructor(canvas, variant = 'F') {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.p = { blink: 1, gazeX: 0, gazeY: 0, mouth: 0, yaw: 0, pitch: 0 }
    this.t = { ...this.p }
    this.speaking = false; this.listening = false
    this.energy = 1; this.emotion = 'neutral'
    this._time = 0; this._nextBlink = 1.5; this._nextSaccade = 2; this._mouthPulse = 0
    this._blinkFactor = 1; this._lid = null
    this._img = null; this._skin = 'rgba(220,180,150,1)'
    this._resize(); window.addEventListener('resize', () => this._resize())
    this.setVariant(variant)
  }

  setVariant(v) {
    this.variant = CAL[v] ? v : 'F'; this.cal = CAL[this.variant]
    this._img = null; this._fullBody = false; this._cutout = false
    // Prefer the transparent CUTOUT (any background), then the full render with
    // its scene, then the head crop — whichever loads first wins.
    this._loadImage((this.cal.cutout || []).slice(), 'cutout')
  }

  _loadImage(srcs, kind) {
    if (!srcs.length) {
      if (kind === 'cutout') { this._loadImage((this.cal.full || []).slice(), 'full'); return }
      if (kind === 'full') { this._loadImage(this.cal.srcs.slice(), 'head'); return }
      this._img = 'missing'; return
    }
    const src = srcs.shift()
    const im = new Image()
    im.onload = () => {
      this._img = im
      this._fullBody = (kind === 'cutout' || kind === 'full')
      this._cutout = (kind === 'cutout')
      if (kind === 'head') this._sampleSkin(im)
    }
    im.onerror = () => this._loadImage(srcs, kind)
    im.src = src
  }

  _sampleSkin(im) {
    try {
      const o = document.createElement('canvas'); o.width = im.naturalWidth; o.height = im.naturalHeight
      const octx = o.getContext('2d'); octx.drawImage(im, 0, 0)
      const at = (nx, ny) => { const d = octx.getImageData(Math.floor(o.width * clamp(nx, 0.02, 0.98)), Math.floor(o.height * clamp(ny, 0.02, 0.98)), 1, 1).data; return `rgb(${d[0]},${d[1]},${d[2]})` }
      this._skin = at(0.5, 0.24)
      // Eyelid tone per eye (sampled just above each eye) so a blink lid blends.
      this._lid = this.cal.eyes.map(([ex, ey]) => at(ex, ey - 0.04))
    } catch { /* keep default */ }
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1
    const r = this.canvas.getBoundingClientRect()
    this.w = r.width; this.h = r.height
    this.canvas.width = Math.round(r.width * dpr); this.canvas.height = Math.round(r.height * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  // ── Embodiment primitives (same API as the procedural face) ────────────────
  blink(double = false) { this._doBlink = double ? 2 : 1 }
  lookAt(nx, ny) { this.t.gazeX = clamp(nx, -1, 1); this.t.gazeY = clamp(ny, -1, 1); this.t.yaw = clamp(nx * 0.3, -0.4, 0.4); this.t.pitch = clamp(ny * 0.18, -0.25, 0.25) }
  turnHead(yaw, pitch) { this.t.yaw = clamp(yaw, -0.5, 0.5); this.t.pitch = clamp(pitch, -0.3, 0.3) }
  setListening(on) { this.listening = on }
  setSpeaking(on) { this.speaking = on; if (!on) { this._audioDriven = false; this.t.mouth = 0 } }
  pulseMouth(i = 1) { this._mouthPulse = Math.min(1, this._mouthPulse + 0.5 * i) }
  // Drive the mouth from real audio amplitude (neural voice) instead of a fake
  // oscillation — so it moves with her actual speech.
  audioLevel(v) { this._audioDriven = true; this.t.mouth = clamp(v, 0, 1) }
  // Emotion → how alive she is (energy scales mouth animation + head motion),
  // plus gaze cues. On a real photo we convey feeling through motion + energy,
  // not by distorting the face.
  setEmotion(name, intensity = 1) {
    this.emotion = name
    const E = { joy: 1.5, warm: 1.18, neutral: 1.0, concern: 0.82, thinking: 0.85 }
    this.energy = (E[name] ?? 1.0) * (0.7 + 0.3 * intensity)
    this._blinkFactor = this._blinkRate(name)
    if (name === 'thinking') { this.t.gazeX = 0.3; this.t.gazeY = -0.32 }
  }
  // Blink interval multiplier: <1 = blink MORE (stress/anxiety), >1 = LESS (focus).
  _blinkRate(name) {
    const BF = { concern: 0.55, concerned: 0.55, anxious: 0.5, joy: 0.95, playful: 0.9, warm: 1.0, neutral: 1.1, calm: 1.3, supportive: 1.1, curious: 0.9, thinking: 1.7, focused: 1.9 }
    return BF[name] ?? 1.0
  }
  setExpression(name) {
    const M = { smile: 'joy', curious: 'warm', concerned: 'concern', thinking: 'thinking', neutral: 'neutral' }
    this.setEmotion(M[name] || 'neutral')
  }
  gesture(kind) { this._gesture = { k: kind === 'greet' ? 'nod' : kind, t: 0 } }

  // Apply the PHYSICAL HUMAN PRESENCE control JSON. On a static photo we can
  // honestly act on: energy (condition), head orientation (gaze→subtle turn),
  // head movement, lean, breathing, gesture intensity. The detailed face/eye/
  // mouth-shape fields need the Stage-2 photoreal engine and are ignored here.
  applyControls(c) {
    if (!c || typeof c !== 'object') return
    // Supports the flat real-time format (expression/gaze/head_movement/emotion)
    // and the older nested one (condition/eyes/body).
    const emotion = c.emotion || (c.expression === 'bright' || c.expression === 'soft-smile' ? 'joy' : c.expression === 'concerned' ? 'concern' : c.expression === 'thoughtful' ? 'thinking' : 'warm')
    const map = { joy: 1.4, warm: 1.12, calm: 1.0, curious: 1.15, playful: 1.35, focused: 0.95, supportive: 0.9, concerned: 0.82, concern: 0.82, thinking: 0.85 }
    const cond = c.condition || {}
    if (typeof cond.arousal === 'number') this.energy = clamp(0.7 + 0.7 * (num(cond.arousal, 0.4) * 0.5 + num(cond.energy, 0.5) * 0.5), 0.6, 1.5)
    else this.energy = map[emotion] ?? 1.0
    this.emotion = emotion
    this._blinkFactor = this._blinkRate(c.emotion || emotion)

    const gaze = c.gaze || (c.eyes && c.eyes.gaze)
    if (gaze === 'slight-left') this.lookAt(-0.4, 0)
    else if (gaze === 'slight-right') this.lookAt(0.4, 0)
    else if (gaze === 'down-thoughtful') this.lookAt(0.12, 0.5)
    else this.lookAt(0, 0)

    const hm = c.head_movement || (c.body && c.body.head_movement)
    if (hm === 'small-nod') this.gesture('nod')
    else if (hm === 'gentle-tilt') this.gesture('tilt')
    this._lean = (hm === 'lean-in' || (c.body && (c.body.posture === 'focused' || c.body.posture === 'attentive'))) ? 1 : 0
  }

  update(dt) {
    this._time += dt
    // Blink scheduler — interval scales with emotion (more when anxious, fewer
    // when focused). Occasional natural double-blink.
    this._nextBlink -= dt
    if (this._nextBlink <= 0 && !this._doBlink) {
      this._doBlink = Math.random() < 0.12 ? 2 : 1
      this._nextBlink = (2.2 + Math.random() * 3.8) * (this._blinkFactor || 1)
    }
    if (this._doBlink) { this.t.blink = 0; if (this.p.blink < 0.06) { this._doBlink -= 1; this.t.blink = 1 } } else this.t.blink = 1

    // Idle micro-saccades.
    this._nextSaccade -= dt
    if (this._nextSaccade <= 0 && !this.listening) {
      this.t.gazeX = clamp(this.t.gazeX + (Math.random() - 0.5) * 0.4, -0.5, 0.5)
      this.t.gazeY = clamp(this.t.gazeY + (Math.random() - 0.5) * 0.25, -0.35, 0.35)
      this._nextSaccade = 1.6 + Math.random() * 3
    }

    if (this.speaking && !this._audioDriven) {
      const s = this._time
      const base = 0.2 + 0.24 * Math.abs(Math.sin(s * 10.5)) + 0.14 * Math.abs(Math.sin(s * 17 + 1))
      this._mouthPulse = Math.max(0, this._mouthPulse - dt * 3)
      this.t.mouth = clamp((base + this._mouthPulse * 0.5) * this.energy, 0, 1)
    }

    const k = 1 - Math.pow(0.002, dt)
    for (const key of Object.keys(this.p)) {
      const rate = key === 'blink' ? Math.min(1, dt * 16) : key === 'mouth' ? Math.min(1, k * 2.4) : k
      this.p[key] = lerp(this.p[key], this.t[key], rate)
    }

    this._go = { yaw: 0, pitch: 0, roll: 0 }
    if (this._gesture) {
      const g = this._gesture; g.t += dt; const d = 0.7
      if (g.t > d) this._gesture = null
      else { const a = Math.sin((g.t / d) * Math.PI); if (g.k === 'nod') this._go.pitch = a * 0.5; if (g.k === 'shake') this._go.yaw = Math.sin(g.t * 18) * a * 0.4; if (g.k === 'tilt') this._go.roll = a * 0.12 }
    }
  }

  draw() {
    const { ctx, w, h, p } = this
    ctx.clearRect(0, 0, w, h)
    if (this._img === 'missing' || !this._img) { this._placeholder(); return }
    const im = this._img

    // FULL-BODY presence: show the whole standing figure (contain-fit), with
    // subtle breathing/sway (a bit more alive while speaking). No face overlays
    // (the face is small at full-body scale). She's a real, present figure.
    if (this._fullBody) {
      const fs = Math.min(w / im.naturalWidth, h / im.naturalHeight)
      const fiw = im.naturalWidth * fs, fih = im.naturalHeight * fs
      // Real voice amplitude (0..1) while she speaks — her body subtly lifts with
      // her words, so she reads as present and alive, not a static poster.
      const voice = this.speaking ? (p.mouth || 0) : 0
      const breathe = 1 + Math.sin(this._time * 1.1) * 0.004 * (this.speaking ? 2.2 : 1) + voice * 0.012
      const sway = Math.sin(this._time * 0.5) * 3 * this.energy
      ctx.save()
      ctx.translate(w / 2 + sway + (p.yaw || 0) * 12, h / 2 + (p.pitch || 0) * 8 - voice * 4)
      ctx.scale(breathe, breathe)
      ctx.drawImage(im, -fiw / 2, -fih / 2, fiw, fih)
      ctx.restore()
      if (this.listening) {
        ctx.strokeStyle = `rgba(96,165,250,${0.35 + 0.2 * Math.sin(this._time * 4)})`
        ctx.lineWidth = 4; ctx.strokeRect(3, 3, w - 6, h - 6)
      }
      return
    }

    const scale = Math.max(w / im.naturalWidth, h / im.naturalHeight)
    const iw = im.naturalWidth * scale, ih = im.naturalHeight * scale
    const breathe = 1 + Math.sin(this._time * 1.1) * 0.006
    const sway = Math.sin(this._time * 0.6) * 4 * this.energy

    ctx.save()
    ctx.translate(w / 2 + sway + p.yaw * 22 + (this._go?.yaw || 0) * 26, h / 2 + p.pitch * 16 + (this._go?.pitch || 0) * 22)
    ctx.rotate((this._go?.roll || 0) + p.yaw * 0.03)
    const lean = 1 + (this._lean || 0) * 0.025 // lean-in = a subtle move toward the viewer
    ctx.scale(breathe * lean, breathe * lean)

    // Cover-fit base — the clean, untouched real face (never distorted).
    ctx.drawImage(im, -iw / 2, -ih / 2, iw, ih)

    // helper: image-normalized coords → local (pre-translate) canvas coords
    const P = (nx, ny) => [(nx - 0.5) * iw, (ny - 0.5) * ih]

    // While speaking: a whisper-soft darkening at the mouth only. No geometry
    // warp (that tears a photo). True mouth motion needs a server-side realism
    // engine — see the roadmap; the laptop just isn't the place for it.
    if (p.mouth > 0.03) {
      const [mx, my] = P(this.cal.mouth[0], this.cal.mouth[1])
      const g = clamp(0.85 + (this.energy - 1) * 0.6, 0.7, 1.35) // livelier when energetic/happy
      ctx.save(); ctx.globalAlpha = clamp(p.mouth * 0.28 * g, 0, 0.34)
      const mg = ctx.createRadialGradient(mx, my, 1, mx, my, this.cal.mouthR[0] * iw)
      mg.addColorStop(0, 'rgba(45,16,18,0.8)'); mg.addColorStop(1, 'rgba(45,16,18,0)')
      ctx.fillStyle = mg
      ctx.beginPath(); ctx.ellipse(mx, my, this.cal.mouthR[0] * iw * 0.8, this.cal.mouthR[1] * ih * 1.3 * g, 0, 0, Math.PI * 2); ctx.fill()
      ctx.restore()
    }

    // (No painted blink: a real eyelid can't be drawn on a flat photo without
    //  looking like a patch. A clean, calm real photo is the honest choice; real
    //  blinking needs an AI model + GPU, which is out of scope for the free site.)
    ctx.restore()

    if (this.listening) {
      ctx.strokeStyle = `rgba(96,165,250,${0.35 + 0.2 * Math.sin(this._time * 4)})`
      ctx.lineWidth = 4
      ctx.strokeRect(3, 3, w - 6, h - 6)
    }
  }

  _placeholder() {
    const { ctx, w, h } = this
    ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#9fb4c9'; ctx.textAlign = 'center'
    ctx.font = '600 15px system-ui'
    ctx.fillText(`Add Noria-${this.variant} image at:`, w / 2, h / 2 - 12)
    ctx.font = '13px ui-monospace, monospace'
    ctx.fillText(`public/assets/noria-${this.variant.toLowerCase()}.png`, w / 2, h / 2 + 12)
  }
}
