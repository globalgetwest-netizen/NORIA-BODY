/**
 * NORIA BIOMETRIC — consent-first, on-device 1:1 face verification (PROTOTYPE).
 *
 * ⚠️ NOT PRODUCTION-SECURE. This is an honest, working demo:
 *  - Everything runs ON-DEVICE. The face template NEVER leaves this browser.
 *  - Template is encrypted at rest with WebCrypto (AES-GCM, non-extractable key).
 *  - 1:1 only: compares a face to THIS person's own enrolled template. It never
 *    identifies unknown people, never searches any database, never guesses.
 *  - Liveness here is a BASIC blink challenge — it defeats a static photo, but
 *    NOT a video/screen replay. Real anti-spoofing needs a specialist provider.
 *
 * Provider abstraction lets the detector / liveness / embedding be swapped for a
 * server or certified provider later (see BIOMETRIC.md).
 */

export const OUTCOMES = ['verified', 'not_verified', 'liveness_failed', 'face_not_found', 'multiple_faces_detected', 'poor_quality', 'consent_required', 'biometric_not_enrolled']
export const CONSENT_VERSION = '1.0'

// ── Provider interface ────────────────────────────────────────────────────────
// A provider turns a <video> frame into { faces, score, box, landmarks, brightness,
// descriptor(Float32Array) }. Swap this out to move processing server-side.
export class FaceApiProvider {
  constructor(modelUrl = 'https://cdn.jsdelivr.net/gh/vladmandic/face-api/model') { this.modelUrl = modelUrl; this.ready = false }
  async load() {
    if (this.ready) return
    const f = window.faceapi
    if (!f) throw new Error('face-api not loaded')
    await f.nets.tinyFaceDetector.loadFromUri(this.modelUrl)
    await f.nets.faceLandmark68Net.loadFromUri(this.modelUrl)
    await f.nets.faceRecognitionNet.loadFromUri(this.modelUrl)
    this.ready = true
  }
  async analyze(video) {
    const f = window.faceapi
    const opts = new f.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 })
    const results = await f.detectAllFaces(video, opts).withFaceLandmarks().withFaceDescriptors()
    const brightness = sampleBrightness(video)
    if (!results.length) return { faces: 0, brightness }
    // Pick the largest face for single-face validation context.
    results.sort((a, b) => b.detection.box.area - a.detection.box.area)
    const r = results[0]
    return {
      faces: results.length,
      score: r.detection.score,
      box: r.detection.box,
      landmarks: r.landmarks,
      descriptor: r.descriptor, // Float32Array(128)
      brightness,
      videoW: video.videoWidth, videoH: video.videoHeight,
    }
  }
}

function sampleBrightness(video) {
  try {
    const c = document.createElement('canvas'); c.width = 48; c.height = 36
    const ctx = c.getContext('2d'); ctx.drawImage(video, 0, 0, 48, 36)
    const d = ctx.getImageData(0, 0, 48, 36).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    return sum / (d.length / 4) / 255 // 0..1
  } catch { return 0.5 }
}

// Eye-aspect-ratio from 68-landmarks, for the blink liveness challenge.
function eyeAspect(landmarks) {
  const L = landmarks.getLeftEye(), R = landmarks.getRightEye()
  const ear = (e) => {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
    return (d(e[1], e[5]) + d(e[2], e[4])) / (2 * d(e[0], e[3]))
  }
  return (ear(L) + ear(R)) / 2
}

// ── Quality gate ──────────────────────────────────────────────────────────────
export function qualityCheck(a) {
  if (!a || !a.faces) return { ok: false, outcome: 'face_not_found' }
  if (a.faces > 1) return { ok: false, outcome: 'multiple_faces_detected' }
  if (a.score < 0.6) return { ok: false, outcome: 'poor_quality', why: 'low detection confidence' }
  if (a.brightness < 0.18) return { ok: false, outcome: 'poor_quality', why: 'too dark' }
  const minSide = Math.min(a.videoW, a.videoH)
  if (a.box.width < minSide * 0.22) return { ok: false, outcome: 'poor_quality', why: 'move closer' }
  return { ok: true }
}

// ── Encrypted on-device store (IndexedDB + WebCrypto) ────────────────────────
const DB = 'noria_biometric', STORE = 'kv'
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE)
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
}
async function put(k, v) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error) }) }
async function get(k) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readonly'); const q = t.objectStore(STORE).get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) }) }
async function del(k) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete(k); t.oncomplete = res; t.onerror = () => rej(t.error) }) }

// AES-GCM key: generated once, stored NON-EXTRACTABLE (its bytes can't be read).
async function cryptoKey() {
  let key = await get('aesKey')
  if (!key) { key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await put('aesKey', key) }
  return key
}
async function encryptVec(vec) {
  const key = await cryptoKey()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const buf = new Float32Array(vec).buffer
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf)
  return { iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) }
}
async function decryptVec(enc) {
  const key = await cryptoKey()
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(enc.iv) }, key, new Uint8Array(enc.ct).buffer)
  return new Float32Array(pt)
}

async function audit(event, detail = {}) {
  const log = (await get('audit')) || []
  log.push({ event, at: new Date().toISOString(), ...detail })
  await put('audit', log.slice(-500))
}
export async function auditLog() { return (await get('audit')) || [] }

// ── Consent ───────────────────────────────────────────────────────────────────
export async function getConsent() { return (await get('consent')) || null }
export async function grantConsent() { const c = { version: CONSENT_VERSION, granted: true, at: new Date().toISOString() }; await put('consent', c); await audit('consent_granted', { version: CONSENT_VERSION }); return c }
export async function withdrawConsent() { await put('consent', { version: CONSENT_VERSION, granted: false, at: new Date().toISOString() }); await audit('consent_withdrawn') }

// ── Enrollment / status / deletion ─────────────────────────────────────────────
export async function status(userId) {
  const c = await getConsent()
  const t = await get('tpl:' + userId)
  return { consent: !!(c && c.granted), consentVersion: c && c.version, enrolled: !!t, enrolledAt: t && t.at, samples: t && t.n }
}

// Average several descriptors into one template, then encrypt + store on-device.
export async function enroll(userId, descriptors) {
  const c = await getConsent(); if (!(c && c.granted)) return { ok: false, outcome: 'consent_required' }
  if (!descriptors || descriptors.length < 3) return { ok: false, outcome: 'poor_quality', why: 'need at least 3 good samples' }
  const dim = descriptors[0].length
  const mean = new Float32Array(dim)
  for (const d of descriptors) for (let i = 0; i < dim; i++) mean[i] += d[i] / descriptors.length
  const enc = await encryptVec(mean)
  await put('tpl:' + userId, { enc, n: descriptors.length, at: new Date().toISOString() })
  await audit('enroll', { userId, samples: descriptors.length })
  return { ok: true }
}

export async function deleteProfile(userId) {
  await del('tpl:' + userId)
  await audit('delete_profile', { userId })
  return { ok: true }
}

// ── Verification (1:1) ─────────────────────────────────────────────────────────
function euclid(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d } return Math.sqrt(s) }

// Compare a fresh descriptor to the enrolled template. livenessPassed must be
// supplied by the caller after running the challenge.
export async function verify(userId, descriptor, livenessPassed) {
  const c = await getConsent(); if (!(c && c.granted)) return { status: 'consent_required' }
  const t = await get('tpl:' + userId); if (!t) return { status: 'biometric_not_enrolled' }
  if (!livenessPassed) { await audit('verify', { userId, status: 'liveness_failed' }); return { status: 'liveness_failed' } }
  const tpl = await decryptVec(t.enc)
  const dist = euclid(descriptor, tpl)
  // Standard face-api threshold ~0.6. Bands are deliberately conservative.
  let status, band
  if (dist < 0.45) { status = 'verified'; band = 'high' }
  else if (dist < 0.55) { status = 'verified'; band = 'medium' }
  else if (dist < 0.62) { status = 'not_verified'; band = 'low' } // uncertain → don't guess
  else { status = 'not_verified'; band = 'low' }
  await audit('verify', { userId, status, band, dist: Number(dist.toFixed(3)) })
  // Minimal result — the ONLY biometric data Noria ever receives.
  return status === 'verified'
    ? { status, user_id: userId, face_verification_status: 'verified', verified_at: new Date().toISOString(), confidence_band: band }
    : { status, confidence_band: band }
}

// Blink liveness: watch EAR over ~4s; a blink = EAR dips then recovers.
export async function livenessBlink(provider, video, { seconds = 5, onTick = () => {} } = {}) {
  const start = performance.now(); let sawOpen = false, sawClosed = false, blinked = false
  while ((performance.now() - start) / 1000 < seconds && !blinked) {
    const a = await provider.analyze(video)
    if (a && a.faces === 1 && a.landmarks) {
      const ear = eyeAspect(a.landmarks)
      if (ear > 0.26) sawOpen = true
      if (ear < 0.18 && sawOpen) sawClosed = true
      if (sawClosed && ear > 0.26) blinked = true
      onTick({ ear, blinked })
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  return blinked
}
