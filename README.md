# NORIA BODY

The **embodiment layer** around the existing Noria Engine. This is a **separate
project**: it never modifies the Engine, and talks to it through one HTTP call.
See [`EMBODIMENT.md`](EMBODIMENT.md) for the architecture and the isolation rules.

**Phase 2 — Virtual Noria** (this prototype): mic → Noria Engine → streamed
answer → a face that speaks, blinks, expresses and tracks your gaze.

```
YOU → 🎙️/⌨️ → Body-OS proxy → NORIA ENGINE (live) → streamed reply
                                     ↓
                    intention parser → face: eyes / mouth / expression / voice
```

## Run

```bash
cd noria-body
cp .env.example .env      # NORIA_ENGINE_URL defaults to the live Render engine
npm start                 # → http://localhost:5178
```

No dependencies to install (zero-dep Node ≥20 server). Open the URL, type or hold
the mic, and Noria answers from the **live** engine and speaks it.

- **Voice in/out & face tracking** work best in Chrome/Edge (Web Speech API;
  `FaceDetector` behind a flag). Typing + cursor-follow gaze work everywhere.
- **Noria-F / Noria-M** toggle switches the embodiment; **Vision** makes her gaze
  follow your face (webcam) or cursor.

## What's here (maps to the 8-system program)

| File | System |
|---|---|
| `server.js` | System 4 — Body OS (serves UI + proxies to the brain) |
| `public/brain.js` | System 3 — Audio (STT/TTS) + brain link |
| `public/face.js` | System 5 — Face (procedural; swappable for a rigged avatar) |
| `public/embodiment.js` | Embodiment Layer — intention parser + command executor |
| `public/app.js` | Orchestration + System 2 Vision stand-in |

## Next

- Swap `face.js` for a rigged 3D avatar (three.js + GLB blendshapes) — same
  command set, more realism.
- Then specify **NORIA-01** (physical head + neck) against this exact contract.
