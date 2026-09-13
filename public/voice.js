/**
 * NORIA VOICE — real neural text-to-speech, running FREE and ON-DEVICE.
 *
 * Uses Kokoro (an 82M on-device neural TTS) via transformers.js — a genuinely
 * human-sounding voice, no paid API, no GPU required (WebGPU if available, else
 * WASM). The model downloads once to the browser and is cached.
 *
 * While speaking, real audio amplitude is exposed via onLevel() so Noria's mouth
 * moves with her actual voice. Falls back to the browser voice if it can't load.
 */
let _ttsPromise = null
async function loadTTS(onProgress = () => {}) {
  if (_ttsPromise) return _ttsPromise
  _ttsPromise = (async () => {
    const mod = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm')
    const KokoroTTS = mod.KokoroTTS
    const webgpu = !!navigator.gpu
    onProgress('loading')
    const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8', // ~86MB, good quality; keeps the download light
      device: webgpu ? 'webgpu' : 'wasm',
    })
    return tts
  })()
  return _ttsPromise
}

const VOICE_FOR = { F: 'af_heart', M: 'am_michael' }

export class NeuralVoice {
  constructor() { this.ctx = null; this.tts = null; this.ready = false; this._cancel = false }

  async warmup(onProgress) {
    try { this.tts = await loadTTS(onProgress); this.ready = true; return true }
    catch (e) { this.ready = false; console.warn('Neural voice unavailable:', e.message); return false }
  }

  cancel() { this._cancel = true }

  async speak(text, { variant = 'F', onStart = () => {}, onLevel = () => {}, onEnd = () => {} } = {}) {
    if (!this.ready && !(await this.warmup())) throw new Error('neural voice not ready')
    this._cancel = false
    const ctx = this.ctx || (this.ctx = new (window.AudioContext || window.webkitAudioContext)())
    try { await ctx.resume() } catch {}
    const voice = VOICE_FOR[variant] || 'af_heart'

    const analyser = ctx.createAnalyser(); analyser.fftSize = 512
    analyser.connect(ctx.destination)
    const buf = new Uint8Array(analyser.fftSize)
    let raf = 0
    const tick = () => {
      analyser.getByteTimeDomainData(buf)
      let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v }
      onLevel(Math.min(1, Math.sqrt(s / buf.length) * 3.2))
      raf = requestAnimationFrame(tick)
    }

    // Speak sentence by sentence, generating the NEXT one while the current
    // plays — so gaps between sentences nearly disappear.
    const parts = (String(text).match(/[^.!?]+[.!?]*/g) || [String(text)]).map((s) => s.trim()).filter(Boolean)
    const gen = (p) => this.tts.generate(p, { voice })
    let started = false
    let nextP = parts.length ? gen(parts[0]) : null
    try {
      for (let i = 0; i < parts.length; i++) {
        if (this._cancel) break
        const raw = await nextP
        nextP = i + 1 < parts.length ? gen(parts[i + 1]) : null // prefetch next
        if (this._cancel) break
        const ab = ctx.createBuffer(1, raw.audio.length, raw.sampling_rate)
        ab.getChannelData(0).set(raw.audio)
        const src = ctx.createBufferSource(); src.buffer = ab; src.connect(analyser)
        if (!started) { started = true; onStart(); tick() }
        await new Promise((res) => { src.onended = res; src.start() })
      }
    } finally {
      cancelAnimationFrame(raf); onLevel(0); onEnd()
    }
  }
}

export const neuralVoice = new NeuralVoice()
