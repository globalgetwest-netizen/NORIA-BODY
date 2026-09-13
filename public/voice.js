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
// Strip anything that must never be voiced: emoji/pictographs, code, markdown,
// links, symbols. Applied to EVERY string before it reaches text-to-speech.
export function cleanForSpeech(t) {
  return String(t || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\p{Extended_Pictographic}/gu, ' ')     // all emoji/pictographs
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, ' ')          // flag letters
    .replace(/[←-⇿⌀-➿⬀-⯿️‍]/g, ' ')
    .replace(/[#*_>~|]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

// Expand things TTS reads awkwardly (money, dates, abbreviations, symbols) into
// natural spoken English. Shares the normalizer with the browser-voice path so
// both voices say the same thing the same way.
import { normalizeSpokenText } from './brain.js'
function normalizeSpeech(t) { return normalizeSpokenText(t) }

// Group sentences into ~natural phrases (~220 chars) so intonation flows.
function phraseChunks(text) {
  const sents = String(text).match(/[^.!?]+[.!?]*/g) || [text]
  const out = []; let cur = ''
  for (const s of sents) {
    const t = s.trim(); if (!t) continue
    if (cur && (cur + ' ' + t).length > 220) { out.push(cur); cur = t }
    else cur = cur ? cur + ' ' + t : t
  }
  if (cur) out.push(cur)
  return out.length ? out : [String(text)]
}

let _ttsPromise = null
async function loadTTS(onProgress = () => {}) {
  if (_ttsPromise) return _ttsPromise
  _ttsPromise = (async () => {
    const mod = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm')
    const KokoroTTS = mod.KokoroTTS
    const webgpu = !!navigator.gpu
    onProgress('loading')
    // Full-quality model on the GPU (natural), quantized only as a CPU fallback.
    const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: webgpu ? 'fp32' : 'q8',
      device: webgpu ? 'webgpu' : 'wasm',
    })
    return tts
  })()
  return _ttsPromise
}

// Warm, natural voices (Kokoro's highest-graded).
const VOICE_FOR = { F: 'af_bella', M: 'am_michael' }

export class NeuralVoice {
  constructor() { this.ctx = null; this.tts = null; this.ready = false; this._cancel = false }

  async warmup(onProgress) {
    try { this.tts = await loadTTS(onProgress); this.ready = true; return true }
    catch (e) { this.ready = false; console.warn('Neural voice unavailable:', e.message); return false }
  }

  cancel() { this._cancel = true; for (const s of this._sources || []) { try { s.stop() } catch {} } this._sources = [] }

  async speak(text, { variant = 'F', pace = 'natural', onStart = () => {}, onLevel = () => {}, onEnd = () => {} } = {}) {
    if (!this.ready && !(await this.warmup())) throw new Error('neural voice not ready')
    this._cancel = false; this._sources = []
    text = normalizeSpeech(cleanForSpeech(text)) // no emoji/symbols; natural reading
    const ctx = this.ctx || (this.ctx = new (window.AudioContext || window.webkitAudioContext)())
    try { await ctx.resume() } catch {}
    const voice = VOICE_FOR[variant] || 'af_heart'
    const speed = pace === 'slow' ? 0.9 : pace === 'energetic' ? 1.08 : 1.0

    const analyser = ctx.createAnalyser(); analyser.fftSize = 512
    analyser.connect(ctx.destination)
    const abuf = new Uint8Array(analyser.fftSize)
    let raf = 0
    const tick = () => {
      analyser.getByteTimeDomainData(abuf)
      let s = 0; for (let i = 0; i < abuf.length; i++) { const v = (abuf[i] - 128) / 128; s += v * v }
      onLevel(Math.min(1, Math.sqrt(s / abuf.length) * 3.2))
      raf = requestAnimationFrame(tick)
    }

    // Group sentences into flowing phrases so intonation carries; play chunks
    // back-to-back on the audio timeline (gapless), generating ahead.
    const chunks = phraseChunks(text)
    const gen = (p) => this.tts.generate(p, { voice, speed })
    let started = false, playHead = 0
    let nextP = chunks.length ? gen(chunks[0]) : null
    try {
      for (let i = 0; i < chunks.length; i++) {
        if (this._cancel) break
        const raw = await nextP
        nextP = i + 1 < chunks.length ? gen(chunks[i + 1]) : null // prefetch
        if (this._cancel) break
        const ab = ctx.createBuffer(1, raw.audio.length, raw.sampling_rate)
        ab.getChannelData(0).set(raw.audio)
        const src = ctx.createBufferSource(); src.buffer = ab; src.connect(analyser)
        this._sources.push(src)
        if (!started) { started = true; playHead = ctx.currentTime + 0.12; onStart(); tick() }
        const startAt = Math.max(playHead, ctx.currentTime + 0.02)
        src.start(startAt)
        playHead = startAt + ab.duration
      }
      // Wait until the last scheduled audio has finished.
      const waitMs = Math.max(0, (playHead - ctx.currentTime) * 1000) + 60
      await new Promise((res) => setTimeout(res, this._cancel ? 0 : waitMs))
    } finally {
      cancelAnimationFrame(raf); onLevel(0); this._sources = []; onEnd()
    }
  }
}

export const neuralVoice = new NeuralVoice()
