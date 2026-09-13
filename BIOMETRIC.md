# Noria Face Verification — architecture, threat model, and honest status

Consent-first, **1:1** face verification that unlocks a person's *own* Noria
profile. It is **not** surveillance: it never identifies unknown people, never
searches the internet or any face database, never infers demographics, and only
ever compares a face to that same person's explicitly enrolled template.

## ⚠️ Honest status: PROTOTYPE, not production security
This build (`public/biometric.js`, `verify.html`, `verify.js`) is a **real,
working, on-device demo** — good enough to try and evaluate, **not** to protect
real accounts. What's genuinely delivered vs. what production still needs:

| Area | This prototype | Production needs |
|---|---|---|
| Processing | On-device (browser), face-api.js | Same, or a server provider over TLS |
| Template storage | On-device, **encrypted** (WebCrypto AES-GCM, non-extractable key) | Server DB, encrypted at rest, **keys in a separate KMS** |
| Matching | 1:1 euclidean vs. own template | Same, tuned + monitored thresholds |
| **Liveness / anti-spoof** | **Basic blink challenge** — defeats a still photo, **NOT** video/screen replay | **Certified provider** (FaceTec / iProov / AWS Face Liveness) |
| Identity binding | Local `userId` stand-in | Bind to a **signed-in account** (real auth) |
| Audit / rate-limit | On-device audit log | Server immutable audit logs + attempt rate-limiting + lockout |
| Compliance | — | **Legal review** (BIPA, GDPR special-category data) before release |

**The three foundations production requires that don't exist yet:** real
**auth/accounts** in the Body, a **persistent database + KMS**, and a **certified
liveness provider** (almost certainly paid). Do not ship this to protect anything
real until those are in place.

## Provider abstraction
`FaceProvider.analyze(video) → { faces, score, box, landmarks, brightness, descriptor }`.
Swap `FaceApiProvider` for a server or certified provider without touching the
flows. Liveness is a separate pluggable step (`livenessBlink` here → a certified
liveness API in production).

## Pipeline
camera → face detection → single-face validation → quality gate → liveness →
embedding → encrypted 1:1 compare → typed outcome → (on success) minimal result
to Noria → session unlock.

## API shape (for the production server version)
The on-device prototype implements these as client functions; a server build
would expose them as endpoints, returning **typed, minimal** responses that never
include raw images or embeddings:

```
POST /api/biometric/consent   → { consented, version }
POST /api/biometric/enroll    → { enrolled, samples }
POST /api/biometric/verify    → { status, confidence_band }   // + user_id, verified_at when verified
GET  /api/biometric/status    → { consent, enrolled, ... }
DELETE /api/biometric/profile → { deleted: true }
```

**The only biometric data Noria ever receives** (never the embedding):
```json
{ "user_id": "...", "face_verification_status": "verified", "verified_at": "...", "confidence_band": "high" }
```
Outcomes: `verified · not_verified · liveness_failed · face_not_found ·
multiple_faces_detected · poor_quality · consent_required · biometric_not_enrolled`.
Uncertain → never guess; ask to retry or use password/passkey.

## Security & privacy rules honored
- Embedding never exposed to logs, analytics, the LLM prompt, or the network (on-device).
- Encrypted at rest; the AES key is non-extractable (its bytes can't be read back).
- Consent versioning, withdrawal, permanent deletion, no raw video/frames retained.
- A non-biometric fallback (password/passkey) must always remain — Noria is fully usable without face.

## Threat model (summary)
- **Photo spoof:** blink liveness rejects a static image. *(A video replay can still pass — hence "prototype"; production uses certified liveness with depth/challenge.)*
- **Replay/video spoof:** NOT covered here → certified liveness required.
- **Template theft:** on-device + encrypted with a non-extractable key; production adds KMS + least-privilege service accounts.
- **False match:** conservative thresholds + "uncertain → not_verified" + retry; production monitors FAR/FRR.
- **Brute force:** production rate-limits attempts and locks out repeated failures.
- **Unauthorized identify:** impossible by design — 1:1 only, no database, no search.

## Try it
Open `/verify.html` on the site (Chrome/Edge, HTTPS for camera). Consent → Enroll
(blink + a few samples) → Verify. Delete removes everything. All on your device.
