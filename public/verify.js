/**
 * Noria Face Verification UI (on-device prototype). Isolated from the chat app.
 * NOTE: a real deployment binds to an authenticated account. Here `userId` is a
 * local stand-in because the Body has no login yet (see BIOMETRIC.md).
 */
import { FaceApiProvider, qualityCheck, livenessBlink, getConsent, grantConsent, withdrawConsent, status, enroll, verify, deleteProfile } from './biometric.js'

const $ = (id) => document.getElementById(id)
const provider = new FaceApiProvider()

// Local stand-in for the authenticated user id (prototype only).
let userId = localStorage.getItem('noria_local_uid')
if (!userId) { userId = 'local-' + Math.random().toString(36).slice(2, 10); localStorage.setItem('noria_local_uid', userId) }

const setStatus = (t) => ($('status').textContent = t)
const setLive = (t, cls = '') => { const el = $('live'); el.textContent = t; el.className = 'msg ' + cls }
const showResult = (obj) => { const el = $('result'); el.hidden = false; el.textContent = JSON.stringify(obj, null, 2) }

async function refresh() {
  const s = await status(userId)
  if (!s.consent) { $('consentCard').hidden = false; $('actionsCard').hidden = true; setStatus('Not set up. Consent is required before any camera use.'); return }
  $('consentCard').hidden = true; $('actionsCard').hidden = false
  $('enrollBtn').textContent = s.enrolled ? 'Re-enroll my face' : 'Enroll my face'
  $('verifyBtn').disabled = !s.enrolled
  setStatus(s.enrolled ? `Enrolled (${s.samples} samples, ${new Date(s.enrolledAt).toLocaleString()}). Consent v${s.consentVersion}.` : `Consent given (v${s.consentVersion}). Not enrolled yet.`)
}

// ── Camera helpers ────────────────────────────────────────────────────────────
async function openCam() {
  const cam = $('cam')
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360, facingMode: 'user' } })
  cam.srcObject = stream; cam.hidden = false; await cam.play()
  return () => { stream.getTracks().forEach((t) => t.stop()); cam.hidden = true; cam.srcObject = null }
}
// Grab N quality-passing descriptors (single face) over a time budget.
async function captureSamples(n, seconds) {
  const cam = $('cam'); const out = []; const start = performance.now()
  while (out.length < n && (performance.now() - start) / 1000 < seconds) {
    const a = await provider.analyze(cam)
    const q = qualityCheck(a)
    if (q.ok) out.push(a.descriptor)
    else if (a && a.faces > 1) setLive('Please make sure only your face is in view.', 'bad')
    else if (q.why) setLive('Adjust: ' + q.why, 'bad')
    await new Promise((r) => setTimeout(r, 150))
  }
  return out
}

async function ensureModels() { setLive('Loading on-device face model…'); await provider.load() }

// ── Enroll ───────────────────────────────────────────────────────────────────
$('enrollBtn').addEventListener('click', async () => {
  let close
  try {
    await ensureModels(); close = await openCam()
    setLive('Look at the camera and blink once…')
    const blinked = await livenessBlink(provider, $('cam'), { seconds: 6 })
    if (!blinked) { setLive('Liveness check failed (no blink detected). Try again.', 'bad'); return }
    setLive('Great — hold still, capturing a few angles…')
    const samples = await captureSamples(5, 8)
    if (samples.length < 3) { setLive('Not enough good samples. Better light and face the camera, then retry.', 'bad'); return }
    const r = await enroll(userId, samples)
    setLive(r.ok ? '✅ Enrolled on this device (encrypted).' : '⚠️ ' + (r.outcome || 'failed'), r.ok ? 'ok' : 'bad')
  } catch (e) { setLive('Error: ' + e.message, 'bad') } finally { if (close) close(); refresh() }
})

// ── Verify ───────────────────────────────────────────────────────────────────
$('verifyBtn').addEventListener('click', async () => {
  let close
  try {
    await ensureModels(); close = await openCam()
    setLive('Verifying — look at the camera and blink once…')
    const blinked = await livenessBlink(provider, $('cam'), { seconds: 6 })
    const a = await provider.analyze($('cam'))
    const q = qualityCheck(a)
    if (!q.ok) { setLive('Could not verify: ' + (q.outcome === 'multiple_faces_detected' ? 'multiple faces detected' : (q.why || q.outcome)), 'bad'); showResult({ status: q.outcome }); return }
    const res = await verify(userId, a.descriptor, blinked)
    if (res.status === 'verified') {
      setLive(`✅ Verified (confidence: ${res.confidence_band}).`, 'ok')
      // The ONLY biometric data handed to Noria — minimal, no embedding.
      sessionStorage.setItem('noria_verification', JSON.stringify(res))
      showResult(res)
    } else {
      const map = { liveness_failed: 'Liveness failed (no blink).', not_verified: 'Not a match. If this is you, retry or use your password/passkey.', consent_required: 'Consent required.', biometric_not_enrolled: 'No face enrolled yet.' }
      setLive('❌ ' + (map[res.status] || res.status), 'bad')
      showResult({ status: res.status, confidence_band: res.confidence_band })
    }
  } catch (e) { setLive('Error: ' + e.message, 'bad') } finally { if (close) close() }
})

// ── Delete / consent ──────────────────────────────────────────────────────────
$('deleteBtn').addEventListener('click', async () => {
  await deleteProfile(userId); sessionStorage.removeItem('noria_verification')
  setLive('🗑️ Your face profile was permanently deleted from this device.', 'ok'); $('result').hidden = true; refresh()
})
$('withdrawBtn').addEventListener('click', async () => {
  await withdrawConsent(); await deleteProfile(userId); sessionStorage.removeItem('noria_verification')
  setLive('Consent withdrawn and biometric data deleted.', 'ok'); refresh()
})
$('consentBtn').addEventListener('click', async () => { await grantConsent(); refresh() })

refresh()
