/**
 * NORIA FACE (System 5) — procedural renderer.
 *
 * A self-contained animated face on a <canvas>. It exposes the primitives the
 * Embodiment Layer needs (blink, gaze/lookAt, expression, speaking/visemes,
 * head turn, gesture) and knows nothing about the Engine. Swappable later for a
 * rigged 3D avatar without changing the rest of the Body.
 */

const lerp = (a, b, t) => a + (b - a) * t
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Tuned to the two canonical Noria design references.
const VARIANTS = {
  // Noria-F: light freckled skin, silver-blonde wavy hair, green eyes, gold suit + brand star.
  F: {
    faceW: 150, faceH: 198, skin: ['#f2cfb4', '#dcae92'], iris: '#7f9d63', lip: '#c07d76', lipFull: 1.0,
    hair: '#cdc3ac', hairStyle: 'wavy', brow: '#8b7c62', freckles: true,
    beard: false, collar: '#caa14e', collar2: '#8f6f2c', star: true,
  },
  // Noria-M: warm brown skin, auburn afro, full beard, dark eyes, navy collar.
  M: {
    faceW: 164, faceH: 206, skin: ['#a9714b', '#875839'], iris: '#33210f', lip: '#8a5347', lipFull: 0.72,
    hair: '#6f3a1e', hairStyle: 'afro', brow: '#341f11', freckles: false,
    beard: true, beardColor: '#3f2614', collar: '#14233a', collar2: '#0c1626', star: false,
  },
}

export class NoriaFace {
  constructor(canvas, variant = 'F') {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    this.setVariant(variant)

    // Animated parameters (current + target).
    this.p = { blink: 1, gazeX: 0, gazeY: 0, mouth: 0, mouthWide: 0, smile: 0.08, brow: 0, yaw: 0, pitch: 0 }
    this.t = { ...this.p }

    this.speaking = false
    this.listening = false
    this._time = 0
    this._nextBlink = 1.2
    this._nextSaccade = 2
    this._mouthPulse = 0
    this._resize()
    window.addEventListener('resize', () => this._resize())
  }

  setVariant(v) { this.variant = VARIANTS[v] ? v : 'F'; this.cfg = VARIANTS[this.variant] }

  _resize() {
    const dpr = window.devicePixelRatio || 1
    const r = this.canvas.getBoundingClientRect()
    this.w = r.width; this.h = r.height
    this.canvas.width = Math.round(r.width * dpr)
    this.canvas.height = Math.round(r.height * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  // ── Embodiment primitives ─────────────────────────────────────────────────
  blink(double = false) { this._doBlink = double ? 2 : 1 }
  lookAt(nx, ny) { this.t.gazeX = clamp(nx, -1, 1); this.t.gazeY = clamp(ny, -1, 1); this.t.yaw = clamp(nx * 0.35, -0.4, 0.4); this.t.pitch = clamp(ny * 0.2, -0.25, 0.25) }
  turnHead(yaw, pitch) { this.t.yaw = clamp(yaw, -0.5, 0.5); this.t.pitch = clamp(pitch, -0.3, 0.3) }
  setListening(on) { this.listening = on; if (on) this.setExpression('curious') }
  setSpeaking(on) { this.speaking = on; if (!on) { this.t.mouth = 0; this.t.mouthWide = 0 } }
  pulseMouth(i = 1) { this._mouthPulse = Math.min(1, this._mouthPulse + 0.5 * i) }

  setExpression(name) {
    switch (name) {
      case 'smile': this.t.smile = 0.9; this.t.brow = 0.15; break
      case 'curious': this.t.smile = 0.25; this.t.brow = 0.6; break
      case 'concerned': this.t.smile = -0.25; this.t.brow = -0.5; break
      case 'thinking': this.t.smile = 0.05; this.t.brow = 0.3; this.t.gazeX = 0.35; this.t.gazeY = -0.3; break
      default: this.t.smile = 0.12; this.t.brow = 0
    }
  }
  gesture(kind) {
    if (kind === 'nod') this._gesture = { k: 'nod', t: 0 }
    else if (kind === 'shake') this._gesture = { k: 'shake', t: 0 }
    else if (kind === 'tilt') this._gesture = { k: 'tilt', t: 0 }
    else if (kind === 'greet') { this.setExpression('smile'); this._gesture = { k: 'nod', t: 0 } }
  }

  // ── Per-frame update ──────────────────────────────────────────────────────
  update(dt) {
    this._time += dt
    // Blink scheduler.
    this._nextBlink -= dt
    if (this._nextBlink <= 0 && !this._doBlink) { this._doBlink = Math.random() < 0.12 ? 2 : 1; this._nextBlink = 2 + Math.random() * 4 }
    if (this._doBlink) {
      // Fast close then open.
      this.t.blink = 0
      if (this.p.blink < 0.05) { this._doBlink -= 1; this.t.blink = 1 }
    } else this.t.blink = 1

    // Idle micro-saccades when not actively directed.
    this._nextSaccade -= dt
    if (this._nextSaccade <= 0 && !this.listening) {
      this.t.gazeX = clamp(this.t.gazeX + (Math.random() - 0.5) * 0.5, -0.7, 0.7)
      this.t.gazeY = clamp(this.t.gazeY + (Math.random() - 0.5) * 0.3, -0.5, 0.5)
      this._nextSaccade = 1.5 + Math.random() * 3
    }

    // Speaking → animated visemes (layered oscillation + word pulses).
    if (this.speaking) {
      const s = this._time
      const base = 0.18 + 0.22 * Math.abs(Math.sin(s * 11)) + 0.12 * Math.abs(Math.sin(s * 17.3 + 1))
      this._mouthPulse = Math.max(0, this._mouthPulse - dt * 3)
      this.t.mouth = clamp(base + this._mouthPulse * 0.5, 0, 1)
      this.t.mouthWide = 0.3 + 0.3 * Math.abs(Math.sin(s * 7))
    }

    // Ease all params toward targets.
    const k = 1 - Math.pow(0.001, dt) // frame-rate independent smoothing
    const blinkK = 1 - Math.pow(0.0000001, dt) // blink is snappier
    for (const key of Object.keys(this.p)) {
      const rate = key === 'blink' ? blinkK : (key === 'mouth' || key === 'mouthWide') ? Math.min(1, k * 2.2) : k
      this.p[key] = lerp(this.p[key], this.t[key], rate)
    }

    // Gesture timeline (adds a transient offset).
    this._go = { yaw: 0, pitch: 0, roll: 0 }
    if (this._gesture) {
      const g = this._gesture; g.t += dt
      const d = 0.7
      if (g.t > d) this._gesture = null
      else {
        const a = Math.sin((g.t / d) * Math.PI) // ease in-out bump
        if (g.k === 'nod') this._go.pitch = a * 0.22
        if (g.k === 'shake') this._go.yaw = Math.sin(g.t * 18) * a * 0.18
        if (g.k === 'tilt') this._go.roll = a * 0.16
      }
    }
  }

  // ── Draw ──────────────────────────────────────────────────────────────────
  draw() {
    const { ctx, w, h, cfg, p } = this
    ctx.clearRect(0, 0, w, h)
    const cx = w / 2, cy = h * 0.52
    const breathe = Math.sin(this._time * 1.1) * 2
    const sway = Math.sin(this._time * 0.6) * 3

    ctx.save()
    ctx.translate(cx + sway + p.yaw * 26 + (this._go?.yaw || 0) * 40, cy + breathe + p.pitch * 18 + (this._go?.pitch || 0) * 30)
    ctx.rotate((this._go?.roll || 0) + p.yaw * 0.05)

    const FW = cfg.faceW, FH = cfg.faceH

    this._drawHairBack(FW, FH)
    this._drawCollar(FW, FH)  // suit/shoulders + brand star (F)

    // Neck.
    ctx.fillStyle = cfg.skin[1]
    ctx.fillRect(-FW * 0.24, FH * 0.3, FW * 0.48, FH * 0.35)

    // Face.
    const g = ctx.createRadialGradient(-FW * 0.2, -FH * 0.25, 20, 0, 0, FW * 1.2)
    g.addColorStop(0, cfg.skin[0]); g.addColorStop(1, cfg.skin[1])
    ctx.fillStyle = g
    ctx.beginPath(); ctx.ellipse(0, 0, FW * 0.66, FH * 0.62, 0, 0, Math.PI * 2); ctx.fill()

    // Cheeks blush (with smile).
    if (p.smile > 0.4) {
      ctx.fillStyle = `rgba(214,120,110,${(p.smile - 0.4) * 0.32})`
      for (const sx of [-1, 1]) { ctx.beginPath(); ctx.ellipse(sx * FW * 0.36, FH * 0.16, 22, 15, 0, 0, Math.PI * 2); ctx.fill() }
    }
    if (cfg.freckles) this._drawFreckles(FW, FH)

    this._drawHairFront(FW, FH)  // frames the forehead
    if (cfg.beard) this._drawBeard(FW, FH)

    const eyeY = -FH * 0.06, eyeDX = FW * 0.32, eyeR = FW * 0.15

    // Eyebrows.
    ctx.strokeStyle = cfg.brow || cfg.hair; ctx.lineWidth = 6; ctx.lineCap = 'round'
    for (const s of [-1, 1]) {
      const by = eyeY - eyeR - 12 - p.brow * 8
      ctx.beginPath()
      ctx.moveTo(s * (eyeDX - eyeR * 0.9), by + (p.brow < 0 ? 4 : 0))
      ctx.quadraticCurveTo(s * eyeDX, by - 8 - p.brow * 4, s * (eyeDX + eyeR * 0.9), by + 2)
      ctx.stroke()
    }

    // Eyes.
    for (const s of [-1, 1]) this._drawEye(s * eyeDX, eyeY, eyeR, p)

    // Nose.
    ctx.strokeStyle = `rgba(0,0,0,0.08)`; ctx.lineWidth = 4
    ctx.beginPath(); ctx.moveTo(-3, eyeY + 8); ctx.quadraticCurveTo(-8, FH * 0.12, 6, FH * 0.14); ctx.stroke()

    // Mouth.
    this._drawMouth(0, FH * 0.32, FW * 0.34, p, cfg)

    // Listening halo.
    if (this.listening) {
      ctx.strokeStyle = `rgba(96,165,250,${0.3 + 0.2 * Math.sin(this._time * 4)})`
      ctx.lineWidth = 3
      ctx.beginPath(); ctx.ellipse(0, 0, FW * 0.8, FH * 0.72, 0, 0, Math.PI * 2); ctx.stroke()
    }
    ctx.restore()
  }

  _drawHairBack(FW, FH) {
    const ctx = this.ctx, c = this.cfg
    ctx.fillStyle = c.hair
    if (c.hairStyle === 'afro') {
      // Voluminous rounded afro — a cloud of overlapping tufts.
      const pts = [[0, -FH * 0.44, FW * 0.72], [-FW * 0.58, -FH * 0.22, FW * 0.44], [FW * 0.58, -FH * 0.22, FW * 0.44], [-FW * 0.5, FH * 0.06, FW * 0.34], [FW * 0.5, FH * 0.06, FW * 0.34], [0, -FH * 0.55, FW * 0.5]]
      for (const [x, y, r] of pts) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill() }
    } else {
      ctx.beginPath(); ctx.ellipse(0, -FH * 0.16, FW * 0.84, FH * 0.74, 0, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.ellipse(-FW * 0.52, -FH * 0.28, FW * 0.42, FH * 0.42, 0.4, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.ellipse(FW * 0.54, -FH * 0.32, FW * 0.44, FH * 0.44, -0.5, 0, Math.PI * 2); ctx.fill()
    }
  }

  _drawHairFront(FW, FH) {
    const ctx = this.ctx, c = this.cfg
    ctx.fillStyle = c.hair
    if (c.hairStyle === 'afro') {
      ctx.beginPath()
      ctx.moveTo(-FW * 0.62, -FH * 0.16)
      ctx.quadraticCurveTo(0, -FH * 0.66, FW * 0.62, -FH * 0.16)
      ctx.quadraticCurveTo(FW * 0.5, -FH * 0.36, 0, -FH * 0.34)
      ctx.quadraticCurveTo(-FW * 0.5, -FH * 0.36, -FW * 0.62, -FH * 0.16)
      ctx.fill()
    } else {
      // Swept fringe + side locks.
      ctx.beginPath()
      ctx.moveTo(-FW * 0.66, -FH * 0.26)
      ctx.quadraticCurveTo(-FW * 0.1, -FH * 0.64, FW * 0.52, -FH * 0.44)
      ctx.quadraticCurveTo(FW * 0.08, -FH * 0.36, -FW * 0.24, -FH * 0.34)
      ctx.quadraticCurveTo(-FW * 0.52, -FH * 0.32, -FW * 0.66, -FH * 0.26)
      ctx.fill()
      ctx.beginPath(); ctx.ellipse(-FW * 0.62, -FH * 0.02, FW * 0.17, FH * 0.36, 0.2, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.ellipse(FW * 0.64, -FH * 0.06, FW * 0.17, FH * 0.36, -0.2, 0, Math.PI * 2); ctx.fill()
    }
  }

  _drawBeard(FW, FH) {
    const ctx = this.ctx
    ctx.save()
    ctx.beginPath(); ctx.ellipse(0, 0, FW * 0.66, FH * 0.62, 0, 0, Math.PI * 2); ctx.clip()
    ctx.fillStyle = this.cfg.beardColor; ctx.globalAlpha = 0.94
    // Jaw + chin band, leaving the upper cheeks bare.
    ctx.beginPath()
    ctx.moveTo(-FW * 0.62, -FH * 0.04)
    ctx.quadraticCurveTo(-FW * 0.52, FH * 0.5, 0, FH * 0.62)
    ctx.quadraticCurveTo(FW * 0.52, FH * 0.5, FW * 0.62, -FH * 0.04)
    ctx.quadraticCurveTo(FW * 0.42, FH * 0.32, 0, FH * 0.28)
    ctx.quadraticCurveTo(-FW * 0.42, FH * 0.32, -FW * 0.62, -FH * 0.04)
    ctx.fill()
    // Moustache (sits just above the mouth at FH*0.32).
    ctx.beginPath()
    ctx.moveTo(-FW * 0.2, FH * 0.27)
    ctx.quadraticCurveTo(0, FH * 0.235, FW * 0.2, FH * 0.27)
    ctx.quadraticCurveTo(0, FH * 0.325, -FW * 0.2, FH * 0.27)
    ctx.fill()
    ctx.globalAlpha = 1; ctx.restore()
  }

  _drawFreckles(FW, FH) {
    const ctx = this.ctx
    ctx.fillStyle = 'rgba(150,90,60,0.35)'
    const spots = [[-0.34, 0.12], [-0.28, 0.17], [-0.22, 0.13], [0.34, 0.12], [0.28, 0.17], [0.22, 0.13], [-0.06, 0.16], [0.06, 0.16]]
    for (const [x, y] of spots) { ctx.beginPath(); ctx.arc(x * FW, y * FH, 1.6, 0, Math.PI * 2); ctx.fill() }
  }

  _drawCollar(FW, FH) {
    const ctx = this.ctx, c = this.cfg
    const grd = ctx.createLinearGradient(0, FH * 0.5, 0, FH * 0.98)
    grd.addColorStop(0, c.collar); grd.addColorStop(1, c.collar2 || c.collar)
    ctx.fillStyle = grd
    ctx.beginPath()
    ctx.moveTo(-FW * 1.15, FH * 0.98)
    ctx.quadraticCurveTo(-FW * 0.5, FH * 0.5, -FW * 0.26, FH * 0.5)
    ctx.lineTo(FW * 0.26, FH * 0.5)
    ctx.quadraticCurveTo(FW * 0.5, FH * 0.5, FW * 1.15, FH * 0.98)
    ctx.closePath(); ctx.fill()
    // Brand ✦ star (Noria-F gold suit).
    if (c.star) {
      const sx = 0, sy = FH * 0.78, R = FW * 0.15
      const sg = ctx.createLinearGradient(sx - R, sy - R, sx + R, sy + R)
      sg.addColorStop(0, '#4f7cff'); sg.addColorStop(0.5, '#c07bff'); sg.addColorStop(1, '#ffb64f')
      ctx.fillStyle = sg
      this._star(sx, sy, R, R * 0.32)
    }
  }

  _star(cx, cy, R, r) {
    const ctx = this.ctx
    ctx.beginPath()
    for (let i = 0; i < 8; i++) {
      const ang = -Math.PI / 2 + (i * Math.PI) / 4
      const rad = i % 2 === 0 ? R : r
      const x = cx + Math.cos(ang) * rad, y = cy + Math.sin(ang) * rad
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    ctx.closePath(); ctx.fill()
  }

  _drawEye(ex, ey, r, p) {
    const ctx = this.ctx
    ctx.save(); ctx.translate(ex, ey)
    // Sclera (almond).
    ctx.fillStyle = '#fbfbf7'
    ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.62, 0, 0, Math.PI * 2); ctx.fill()
    // Iris + pupil, offset by gaze.
    const gx = p.gazeX * r * 0.42, gy = p.gazeY * r * 0.3
    const ig = ctx.createRadialGradient(gx, gy, 2, gx, gy, r * 0.5)
    ig.addColorStop(0, this.cfg.iris); ig.addColorStop(1, '#26343a')
    ctx.fillStyle = ig
    ctx.beginPath(); ctx.arc(gx, gy, r * 0.46, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = '#10151a'
    ctx.beginPath(); ctx.arc(gx, gy, r * 0.2, 0, Math.PI * 2); ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.beginPath(); ctx.arc(gx - r * 0.14, gy - r * 0.14, r * 0.08, 0, Math.PI * 2); ctx.fill()
    // Eyelids: cover from top/bottom by (1 - blink).
    const closed = (1 - p.blink)
    ctx.fillStyle = this.cfg.skin[0]
    if (closed > 0.01) {
      ctx.beginPath(); ctx.rect(-r * 1.2, -r * 0.7, r * 2.4, r * 0.62 * 2 * closed); ctx.fill()
      ctx.beginPath(); ctx.rect(-r * 1.2, r * 0.62 - r * 0.62 * 2 * closed * 0.5, r * 2.4, r * 0.62 * closed); ctx.fill()
    }
    // Upper lash line.
    ctx.strokeStyle = 'rgba(30,20,18,0.55)'; ctx.lineWidth = 2.5
    ctx.beginPath(); ctx.ellipse(0, 0, r, r * 0.62, 0, Math.PI * (1 + 0.05), Math.PI * (2 - 0.05)); ctx.stroke()
    ctx.restore()
  }

  _drawMouth(mx, my, halfW, p, cfg) {
    const ctx = this.ctx
    const open = p.mouth * 26 // jaw drop in px
    const wide = 1 + p.mouthWide * 0.18
    const curve = p.smile * 16 // corners up (+) / down (-)
    const w = halfW * wide * (0.7 + cfg.lipFull * 0.3)
    ctx.save(); ctx.translate(mx, my)
    // Interior (when open).
    if (open > 2) {
      ctx.fillStyle = '#5a2b30'
      ctx.beginPath(); ctx.ellipse(0, open * 0.3, w * 0.7, open * 0.6, 0, 0, Math.PI * 2); ctx.fill()
      // teeth hint
      ctx.fillStyle = '#f4efe9'
      ctx.beginPath(); ctx.ellipse(0, -open * 0.05, w * 0.6, Math.min(6, open * 0.25), 0, 0, Math.PI * 2); ctx.fill()
    }
    // Lips.
    ctx.fillStyle = cfg.lip
    ctx.beginPath()
    ctx.moveTo(-w, 0)
    ctx.quadraticCurveTo(0, -8 - curve, w, 0)                    // upper lip top
    ctx.quadraticCurveTo(w * 0.5, 6 + cfg.lipFull * 3, 0, 6 + cfg.lipFull * 4)
    ctx.quadraticCurveTo(-w * 0.5, 6 + cfg.lipFull * 3, -w, 0)   // upper lip bottom
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(-w, open * 0.15)
    ctx.quadraticCurveTo(0, 4, w, open * 0.15)
    ctx.quadraticCurveTo(0, 16 + open + curve * 0.5 + cfg.lipFull * 6, -w, open * 0.15) // lower lip
    ctx.fill()
    ctx.restore()
  }
}
