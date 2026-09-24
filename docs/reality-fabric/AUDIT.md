# Noria Global Reality / Live Data Fabric — System-Wide Audit

**Date:** 2026-09-24
**Scope:** Full source tree (`_worker.js`, `agent/*`, `noria-ai/*`, `public/*`) + live production (`noria.africa`) + live liveness tests of external sources.
**Rule followed:** Nothing is called "implemented" because a file/registry/test/endpoint exists, and nothing "verified" because a unit test passes. Every status is backed by a `file:line` or a live test run on 2026-09-24. Unknowns are written `UNKNOWN`.
**Status: AUDIT ONLY. No new provider infrastructure was built. Build awaits owner decision (Phase 18).**

---

## 0. Headline

Noria already has a **genuine, production-running verification core** — far more than "a list of APIs." It has an authority-weighted, cross-checking Reality Layer with data passports, freshness policies, conflict/stale detection, source locks, entity resolution, and an answer-evidence gate, all wired into live chat. This is the hard part, and it is real.

**But** the fabric is **narrow** (≈6 live domains of ~100 audited) and has **two real correctness gaps** where the architecture's own promises are not enforced in the chat path. Those two gaps matter more than any missing API.

---

## 1. The two findings that must be fixed before any expansion

### FINDING A — CRITICAL: source locks (medical / immigration / legal) are NOT enforced when a question is answered from model memory.

- **Design intent** (`agent/reality.js:130-142`, `agent/reality.js:308`): medical dosage/treatment "is never given from memory"; visa/law/medical answers must come from official/approved sources only (LOCKS, maxLevel 1-2).
- **Reality (live test, production, 2026-09-24):**
  - *"what dose of paracetamol should I give my 2 year old?"* → returned a full dosing protocol (**10–15 mg/kg, max 60 mg/kg/day**) with **no sources attached**.
  - *"what visa does a Ghanaian need to visit Germany?"* → returned Schengen Type-C details with **no sources attached**.
- **Root cause:** `detectLockDomain()` is only consulted **inside the web-search branch** of `groundMessages` (`_worker.js:1767`). When a locked-domain question does **not** trigger a live search (`liveStrength(q)` returns `"no"`), control reaches `plainVerified()` (`_worker.js:2035`) and the model answers from its own knowledge — the lock never runs. So the lock protects *search-grounded* answers but not *memory* answers, which is the exact case the lock exists to prevent.
- **Why it matters:** this is the owner's core rule ("no fabrication; only verified"). A medically/ legally/immigration-sensitive answer from model memory, correct or not, violates the stated contract.
- **Correct behavior:** a locked-domain question with no admissible connected source must **refuse or restrict**, never answer from memory — the same honest refusal the router already gives for flight/company.

### FINDING B — HIGH: the Reality Router is only half-wired into chat.

- `agent/reality-router.js` is a complete, pure domain router (finance, travel, law, immigration, company, medical…), but its header still says *"NOT wired into the chat"* (`agent/reality-router.js:11`).
- It **is** partially wired (`_worker.js:1566-1573`): `realityRouteBlock` fires **only** for `ROUTER_NEW_DOMAINS = {flight_status, traffic, stock_price, company_registration}`. For those, honest refusals work (verified live: flight ✅, company ✅).
- Everything else the router knows (medical_guidance, appointment_availability/immigration, government_announcement/legal) is **not** routed through it — which is why Finding A slips through. The router already contains the correct decision (`cannot_verify` / official-only); it simply isn't consulted for those domains.

**These two are the same underlying gap seen twice: model output is allowed to stand in for verified evidence in locked domains. Fixing it is Phase 11/14 of the directive and should precede all new sources.**

---

## 2. What EXISTS and is VERIFIED (Phase 17 · List A)

Verified = the actual production path retrieved and processed real data on 2026-09-24.

| Capability | Providers (cross-checked) | Proof (live, 2026-09-24) | Verify status |
|---|---|---|---|
| **Verification core** (authority, passports, freshness, conflict/stale, locks, entity resolution, guardAnswer, evidence graph) | `reality.js`, `reality-router.js` | drives every row below | VERIFIED_REAL_RUNTIME |
| **Weather** (current temp) | Open-Meteo + MET Norway (2, cross-checked) | Accra 28.1 °C | VERIFIED_REAL_RUNTIME |
| **FX** (daily reference) | ECB/Frankfurter + open-er-api + currency-api (3) | 100 USD→1,155.11 GHS | VERIFIED_REAL_RUNTIME |
| **Crypto** (spot) | Coinbase + Kraken + Binance + CoinGecko (4) | BTC $84,159 vs Coinbase $84,176 | VERIFIED_REAL_RUNTIME |
| **Stocks** (last trade) | Yahoo + Nasdaq (2) | AAPL $336.15 | VERIFIED_REAL_RUNTIME |
| **National statistics** (pop/GDP/life exp/literacy) | World Bank (1 official) | Ghana pop 35,064,272 (2025) | VERIFIED_REAL_RUNTIME |
| **Place records** (city/town/village) | Open-Meteo geocoding (GeoNames) | Kumasi/Larteh + honest not-found | VERIFIED_REAL_RUNTIME |
| **Date / time / arithmetic** | computed | Thu 24 Sep 2026 | VERIFIED_REAL_RUNTIME |
| **News / current events** | 11 RSS feeds + web search + Wikipedia | world headlines w/ BBC+Graphic sources | VERIFIED_REAL_RUNTIME |
| **Current office-holders** | web search + answer-evidence gate | Ghana pres = J. Mahama, cross-verified | VERIFIED_REAL_RUNTIME |
| **Answer-evidence gate** | `verifyAnswer`/`checkLive` (`_worker.js:1271,1392`) | rejects 3+ digit numbers absent from evidence | VERIFIED_REAL_RUNTIME |

## 3. EXISTS but PARTIAL / UNVERIFIED (Phase 17 · List B)

| Item | State | Note |
|---|---|---|
| Reality Router → chat | PARTIAL | only 4 domains wired (Finding B) |
| Source locks in chat | PARTIAL / BYPASSABLE | not enforced on memory answers (Finding A) |
| Web search (open web) | PARTIAL | Tavily free allowance small/exhausted historically; degrades to Brave (needs key) / DDG scrape |
| Stocks | PARTIAL-QUALITY | works, but Yahoo endpoint is **unofficial** and unlicensed; US-only on Nasdaq |
| Provider registry | FOUNDATION | `SOURCES` (`reality.js:36`) is a real central registry of 17 sources, but has **no** health_status / last_success / rate_limit / fallback-chain data — it is a static description, not an operational registry |
| Company info | PARTIAL | honest refusal only; no registry source connected |
| Entity resolution | PARTIAL | strong but **hardcoded** small tables (24 airports, 5 orgs, `reality.js:245-256`); no live Wikidata/OSM resolver |

## 4. COMPLETELY MISSING — needs building (Phase 17 · List C)

No connected source today; chat correctly refuses (router) **or** wrongly answers from memory (locked domains — Finding A):

Flight status · Traffic/routing · **Medical guidance (lock bypassed)** · **Visa/immigration (lock bypassed)** · **Law/regulation (lock bypassed)** · Company registries · Earthquakes/natural hazards · Air quality · Climate · Oceans/space/satellite · Commodities/energy/bonds/central-bank rates/inflation beyond WB · Maritime/ports/trains/public-transport · Agriculture/food · Education/universities · **Sports/scores** · Scientific/scholarly lookup · Chemistry/biology · Structured-entity (Wikidata) resolution · Elections.

## 5. Free sources TESTED LIVE for the gaps (Phase 6 · full results in `providers.inventory.json`)

**Usable, free, authoritative (level 1–2), no key — strong candidates:**
- **USGS** earthquakes — 200 ✅ official real-time seismic (level 1)
- **PubChem** (NIH) chemistry — 200 ✅ (level 1)
- **Open-Meteo Air Quality** — 200 ✅ (level 2, same family as weather)
- **OSM/Nominatim** geocoding cross-check — 200 ✅ (policy: 1 req/s)
- **Wikidata** structured entities — 200 ✅ (level 3, great for entity layer)
- **OpenAlex / Crossref / Europe PMC** scholarly & biomedical literature — 200 ✅ (level 3)
- **REST Countries** reference — 301→ ✅ | **OurAirports** static reference — 200 ✅
- **NASA** space — 200 ✅ (DEMO_KEY works; free key lifts limit)

**List D — tested and NOT usable as-is:**
- **GDELT** (global events) — **429** throttled on shared IP (free but heavy throttling)
- **Stooq** stock CSV — **DEAD** (already documented `reality-feeds.js:50-55`: 404 + bot-challenge)

**List E — free but NOT authoritative enough for a locked domain:**
- **disease.sh** (health) — works, but aggregates JHU/WHO; **not admissible for the medical lock** — needs WHO/CDC/national-health direct.
- **OpenSky** (flights) — live *positions* only; not per-flight schedule/delay, and anonymous access is heavily rate-limited.

**List F — require a (free) key:** FRED (US economics, 400→needs key), EIA (energy, 403→needs key), Brave Search, Tavily, NASA (for volume). All have free tiers.

**List G — no reliable FREE live source found for:** real-time **flight status/delay** (schedules), real-time **road traffic**, **company-ownership/registry** across most jurisdictions, **licensed real-time equity** quotes, per-country **visa/appointment** systems, most **court/legislation** feeds. These are genuinely hard/paid — the honest current answer for them is refusal, which Noria (mostly) already does.

## 6. Sector coverage summary (Phase 4, 100-sector list)

- **Connected & verified (≈9):** weather, FX, crypto, stocks(partial-quality), country statistics, places/geography, time/math, news/events, current office-holders.
- **Cheap, authoritative, free source READY to wire (≈8):** earthquakes (USGS), air quality (Open-Meteo AQ), chemistry (PubChem), scholarly/science (OpenAlex/Crossref/Europe PMC), structured entities (Wikidata), country reference (REST Countries), space (NASA), geocoding cross-check (OSM).
- **Refuses honestly, needs infra (≈ the rest):** flights, traffic, maritime, transport, medical guidance, immigration, law, company registry, energy/commodities, agriculture, education, sports, elections, oceans/climate/satellite.

## 7. Per-gap build notes (Phase 18 — for decision, not yet built)

For each, the pattern is identical and cheap because the core already exists: **add an adapter that returns `makePassport()` facts → `resolveFacts()` → verdict**; register domain state in `reality.js:DOMAINS`; wire one line in `groundMessages`. No core change.

1. **FIX LOCKS FIRST (Finding A/B)** — *not a source, a safety fix.* Route medical/immigration/legal through `realityRouteBlock` (extend `ROUTER_NEW_DOMAINS`) **and** apply `detectLockDomain` before `plainVerified`, so a locked question with no admissible source refuses instead of answering from memory. Dependency: none. Security: closes a fabrication path. **Highest priority, no new API needed.**
2. **Earthquakes** — USGS adapter (level 1, free, real-time). Trivial. High user value, fully authoritative.
3. **Air quality** — Open-Meteo AQ adapter (reuses weather geocode). Trivial.
4. **Structured entities (Wikidata)** — replaces hardcoded entity tables; cross-checks names/office-holders. Medium.
5. **Science/scholarly** — OpenAlex + Crossref + Europe PMC adapters; answers "what does research say" with real citations. Medium.
6. **Chemistry** — PubChem adapter (level 1). Small.
7. **Country reference** — REST Countries for capital/currency/region (cross-check GeoNames). Small.
8. **Medical (do it properly)** — WHO/CDC/national-health adapters to make the medical lock *answerable* instead of only refusing. Larger; authoritative sources are the gate.
9. **Sports, flights, traffic, company registry, energy** — no free authoritative real-time source (List F/G); keep refusing until a paid/official source is chosen. Do **not** fake with general web.

## 8. Non-negotiables re-affirmed (already largely true in code)

`MODEL OUTPUT ≠ VERIFIED EVIDENCE` — enforced by `verifyAnswer`/`guardAnswer` **except** the locked-memory path (Finding A). No-evidence→no-fact, conflict→CONFLICTING, stale→STALE, unknown→UNKNOWN are all implemented in `resolveFacts` (`reality.js:153-199`) and proven live. Fixing Finding A makes the invariant hold everywhere.

---

## 9. Recommended sequence (for owner approval — build starts only after you approve)

1. **Fix the lock bypass (Finding A + B)** — safety, no new source, ~1 focused change + tests.
2. **Wire the 3 trivial authoritative free sources** — USGS earthquakes, Open-Meteo air quality, PubChem.
3. **Wikidata entity layer + REST Countries** — strengthens what already exists.
4. **Scholarly/science trio** (OpenAlex/Crossref/Europe PMC).
5. **Then** decide medical (WHO/CDC) and any paid domains (flights/traffic/registry) deliberately.

**No build proceeds until you choose the sequence.**
