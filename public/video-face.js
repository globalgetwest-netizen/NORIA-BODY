/**
 * NORIA FACE (video variant) — plays a real pre-rendered talking clip (genuine
 * blink + lip-sync, produced by the Stage-2 SadTalker pipeline in stage2/)
 * while speaking, instead of the synthetic mouth-darkening pulse.
 *
 * This is a thin subclass of ImageFace, not a rewrite: every other behavior
 * (idle sway/breathing, blink, gaze, listening ring, loading screen, all
 * Embodiment methods) is inherited untouched. Only draw() and setSpeaking()
 * are overridden, and both fall straight back to the inherited ImageFace
 * behavior the instant a clip isn't available, hasn't buffered a real frame
 * yet, or has ended — so with no clips present (the current state) this class
 * renders pixel-identical to ImageFace. Nothing about the proven photo face
 * changes until real clips exist on disk.
 *
 * To activate: drop clip files in public/assets/clips/ and add a manifest at
 * public/assets/clips/<f|m>-manifest.json, e.g. { "speaking": ["speak-1.mp4"] }.
 * See stage2/NORIA_Stage2_SadTalker_Colab.ipynb for how to generate a clip
 * (single photo + audio, free T4 GPU — this machine has no GPU to run it
 * locally). Clips should be silent (muted here) since the real TTS audio
 * already plays separately; only the picture needs to move.
 */
import { ImageFace } from './image-face.js'

export class VideoFace extends ImageFace {
  constructor(canvas, variant = 'F') {
    // super()'s own constructor calls this.setVariant(variant), which (via
    // virtual dispatch) already runs the override below and starts the clip
    // check — nothing more to do here.
    super(canvas, variant)
  }

  setVariant(v) {
    super.setVariant(v)
    this._clips = null; this._clipEls = []; this._activeClip = null
    this._checkClips(this.variant)
  }

  async _checkClips(variant) {
    try {
      const res = await fetch(`assets/clips/${String(variant).toLowerCase()}-manifest.json`, { cache: 'no-store' })
      if (!res.ok) throw new Error('no manifest')
      const manifest = await res.json()
      const speaking = Array.isArray(manifest.speaking) ? manifest.speaking.filter(Boolean) : []
      if (!speaking.length) throw new Error('empty manifest')
      this._clips = { speaking }
    } catch {
      this._clips = null // no real clips yet — behaves exactly like ImageFace
    }
  }

  _pickSpeakingClip() {
    if (!this._clips || !this._clips.speaking.length) return null
    const src = this._clips.speaking[Math.floor(Math.random() * this._clips.speaking.length)]
    let v = this._clipEls.find((e) => e.dataset.src === src)
    if (!v) {
      v = document.createElement('video')
      v.src = `assets/clips/${src}`
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.dataset.src = src
      this._clipEls.push(v)
    }
    return v
  }

  setSpeaking(on) {
    super.setSpeaking(on)
    if (on && this._clips) {
      const v = this._pickSpeakingClip()
      if (v) {
        try { v.currentTime = 0 } catch { /* not seekable yet — play() will still try */ }
        const p = v.play()
        if (p && p.catch) p.catch(() => { this._activeClip = null })
        this._activeClip = v
      }
    } else {
      if (this._activeClip) { try { this._activeClip.pause() } catch { /* already stopped */ } }
      this._activeClip = null
    }
  }

  draw() {
    const v = this._activeClip
    // Only take over the canvas once the clip has real decoded frames
    // (readyState >= 2) — otherwise a slow network or missing file would
    // freeze or blank the face instead of showing the proven photo.
    if (this.speaking && v && v.readyState >= 2 && !v.ended && !v.paused) {
      const { ctx, w, h } = this
      ctx.clearRect(0, 0, w, h)
      const vw = v.videoWidth, vh = v.videoHeight
      if (vw && vh) {
        const fit = this._fullBody ? Math.min(w / vw, h / vh) : Math.max(w / vw, h / vh)
        const dw = vw * fit, dh = vh * fit
        ctx.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh)
      }
      if (this.listening) {
        ctx.strokeStyle = `rgba(96,165,250,${0.35 + 0.2 * Math.sin(this._time * 4)})`
        ctx.lineWidth = 4; ctx.strokeRect(3, 3, w - 6, h - 6)
      }
      return
    }
    super.draw()
  }
}
