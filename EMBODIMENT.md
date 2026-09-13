# NORIA Embodiment Architecture

**The rule that makes this safe:** the Noria *Engine* (the brain) is never modified.
Noria *Body* is a **separate project** that consumes the Engine only through its
existing public HTTP API — exactly like the SkyGlobe website does. If the Body
crashes, the Engine never notices. This document defines the seam between them.

```
              NORIA
                │
   ┌────────────┴────────────┐
   │                         │
NORIA ENGINE            NORIA BODY
(intelligence,          (this project —
 already exists)         separate repo)
   │                         │
 HTTP API  ◄──── consumes ───┘
 /v1/ask/stream
```

---

## 1. Isolation guarantees (non-negotiable)

| Concern | Guarantee |
|---|---|
| Engine code | **Zero changes.** No new routes, deps, or redeploys. |
| Process | Body runs in its own process. Engine is unaware of it. |
| Failure | A Body crash / motor fault cannot affect Engine uptime. |
| Load | Body is just another HTTP client; Engine already handles concurrent clients, rate-limiting and failover. |
| Deploy | Body versions and deploys independently. |

The Body talks to the Engine through **one call**: `POST {NORIA_ENGINE_URL}/v1/ask/stream`.
Nothing else about the Engine is assumed or required.

---

## 2. The Embodiment Layer (the contract)

The Engine returns **plain text** (and `{done, sources, provider}`). It does **not**
emit motor commands, and we will **not** change it to. Instead, the Body derives
*intentions* locally from Noria's words + the conversation state, and translates
them into a small, stable command set the physical/virtual body understands.

```
NORIA ENGINE  ──text──►  INTENTION PARSER  ──►  EMBODIMENT COMMANDS  ──►  BODY (virtual or physical)
 (unchanged)              (in the Body)          (this contract)          (face / motors)
```

### Embodiment command set (v0)

| Command | Params | Meaning |
|---|---|---|
| `LOOK_AT` | `{x, y}` / `person` | Aim gaze |
| `BLINK` | `{double?}` | Blink once / twice |
| `SPEAK` | `{text}` | Voice output (drives visemes) |
| `SET_EXPRESSION` | `neutral \| smile \| curious \| concerned \| thinking` | Facial pose |
| `TURN_HEAD` | `{yaw, pitch}` | Neck orientation |
| `GESTURE` | `nod \| shake \| tilt \| greet` | Head/hand gesture |
| `LISTEN` | `{on}` | Enter/leave listening state (mic) |
| `OBSERVE` | — | Capture a frame from the eye camera (future: feed to Engine) |
| `IDLE` | — | Return to natural resting motion |

This command set is the **only thing the body hardware must implement.** Swap the
renderer (procedural face → rigged 3D avatar → physical NORIA-01 head) without
changing the Engine or the parser — only the executor of these commands changes.

### Intention parser (local, in the Body)

Because the Engine stays plain-text, the Body infers expression/gesture from
Noria's reply (greeting → `SET_EXPRESSION smile` + `GESTURE greet`; a question
back → `curious`; apology/empathy → `concerned`; while generating → `thinking`).
If the Engine ever *chooses* to emit explicit intention tags later, the parser
can read them — but it is never required to.

---

## 3. The 8-system program

| # | System | Status | Phase |
|---|---|---|---|
| 1 | **NORIA ENGINE** — intelligence | exists, untouched | — |
| 2 | **NORIA VISION** — cameras / visual perception | webcam in prototype | 2 → 3 |
| 3 | **NORIA AUDIO** — hearing (STT) + speech (TTS) | browser APIs in prototype | 2 |
| 4 | **NORIA BODY OS** — controls the body, runs the command set | this project's server + executor | 2 |
| 5 | **NORIA FACE** — eyes, eyelids, mouth, expressions | procedural → rigged avatar → actuators | 2 → 3 |
| 6 | **NORIA MOTION** — neck, arms, hands, legs | virtual first | 3 → 4 |
| 7 | **NORIA SAFETY** — e-stop, limits, collision, hardware protection | designed before any motor moves | 3 |
| 8 | **NORIA-M / NORIA-F** — the two embodiments | virtual avatars first | 2 → 3 |

---

## 4. Roadmap (disciplined, risk-tiered)

- **Phase 1 — Contract** (this doc). $0. Zero risk.
- **Phase 2 — Virtual Noria** (this prototype): mic → Engine → streamed answer →
  speaking, blinking, gaze-tracking face. Procedural face first, then a rigged
  realistic 3D avatar. $0. Zero Engine risk.
- **Phase 3 — NORIA-01**: physical **head + neck only** (cameras-in-eyes,
  mic-in-ears, actuated face/jaw, motorized neck) + Safety system. Real hardware.
  Prove: *See → Understand → Look → Speak → Express → Listen → Respond.*
- **Phase 4+ — Torso → arms/hands → legs/walking.** The large robotics program,
  only after NORIA-01 is reliable.

**Everything buildable today lives in Phases 1–2** — free, and it cannot
destabilize the Engine, because it only ever makes one HTTP call to it.
