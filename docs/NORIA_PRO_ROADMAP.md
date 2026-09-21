# Noria Pro — production capability roadmap

Rule for everything below: **a capability is LIVE only when it is implemented, tested by a task in `noria-eval/bench.mjs` (or a dedicated test), and monitored.**
Otherwise it stays NOT BUILT. Noria's persona, voice, engine and reply pipeline are never modified by this work; new layers sit underneath and are added behind flags.

States: **LIVE** works in production · **CONNECTED** works through an outside service (claimed only while it answers) · **PARTIAL** part of it works, stated exactly · **NOT BUILT**.
Planned future states used by the registry: `DEGRADED` (tell the user), `REQUIRES_AUTH` (ask for authorisation), `UNCERTAIN` (verify or say so), `CONFLICT` (show the disagreement).

Status snapshot: 21 September 2026. Benchmark on that day: 94.7% (54/57) on the first harness run; see `noria-eval/bench-results/`.

## The 100 capabilities

| # | Capability | State | Notes / next step |
|---|---|---|---|
| 1 | Advanced reasoning engine | PARTIAL | Strong models first; logic-form checker; arithmetic re-check. No general chain-of-thought verifier. |
| 2 | Dynamic agent planner | PARTIAL | Read-only planner built (`agent/planner.js`, `POST /brain/plan`, Noria Pro): plan only, nothing executes. Executor not built. |
| 3 | Multi-step autonomous execution | NOT BUILT | Phase 4. Fixed pipelines only today (decide, retrieve, answer, verify, correct). |
| 4 | Parallel tool execution | PARTIAL | Searches run in parallel inside the pipeline; no general parallel tool runner. |
| 5 | Live web / search | LIVE | Tavily, Wikipedia, 16 news feeds, per-source timeouts, relevance ranking. |
| 6 | Deep research | LIVE | Noria Pro, 3 briefs a day; unsupported sentences removed. |
| 7 | Source / citation verification | LIVE | Names, years, figures, and a second-model judge. |
| 8 | Real-time weather | CONNECTED | Open-Meteo. |
| 9 | Currency | CONNECTED | Open exchange-rate feed. |
| 10 | Market / crypto data | PARTIAL | Crypto LIVE (Binance, CoinGecko). Stocks: no feed, web search only. |
| 11 | Document intelligence | LIVE | Text extraction plus relevant-passage retrieval. |
| 12 | PDF understanding | PARTIAL | Text PDFs yes (60-page test). Scanned PDFs need OCR: NOT BUILT. |
| 13 | Spreadsheet intelligence | LIVE | Exact engine, verified against pandas on 1,200 rows. |
| 14 | Image understanding | CONNECTED | Noria Pro, vision through Cloudflare; limited by the free daily allowance. |
| 15 | Audio understanding | PARTIAL | Speech-to-text for voice chat; arbitrary audio files NOT BUILT. |
| 16 | Video understanding | NOT BUILT | |
| 17 | OCR | PARTIAL | On-device text reading of photos. |
| 18 | Voice conversation | CONNECTED | Noria Pro. |
| 19 | Image generation | CONNECTED | Depends on the daily allowance; often unavailable. |
| 20 | Document generation | LIVE | Guided documents, Word/PDF/Markdown export. |
| 21 | Presentation generation | LIVE | PowerPoint export. |
| 22 | Spreadsheet generation | LIVE | Excel export. |
| 23 | Code generation | LIVE | Benchmark: 5/5 executed correctly. |
| 24 | Code execution sandbox | NOT BUILT | Phase 4: in-browser sandbox (Web Worker for JavaScript; Pyodide for Python). |
| 25 | Data-analysis engine | LIVE | See 13. |
| 26 | Statistical analysis | PARTIAL | Counts, sums, means, medians, correlation. No regression or tests. |
| 27 | Database querying | NOT BUILT | |
| 28 | SQL generation / execution | PARTIAL | Generation by the model only. |
| 29 | RAG | PARTIAL | Keyword retrieval on the device is what the app uses. A full pipeline (chunking, BM25, vector index, hybrid fusion, reranking, context selection, citation checks) is built and tested offline in `public/rag.js` but is not connected to the app. |
| 30 | Vector / hybrid search | NOT BUILT | Code exists and is tested (`rag.js`: in-memory vector index, embedder and index interfaces). No embedding service is connected; the app does not use it. |
| 31 | Knowledge-base ingestion | NOT BUILT | `KnowledgeBase.add()` exists in `rag.js`; no persistent store or upload path yet. |
| 32 | Long-term memory | NOT BUILT | Phase 3 |
| 33 | Project memory | NOT BUILT | Phase 3 |
| 34 | User preference memory | PARTIAL | Device-only profile. |
| 35 | Conversation memory | LIVE | Device history; account sync when signed in. |
| 36 | Knowledge graph | NOT BUILT | |
| 37 | Fact verification | LIVE | |
| 38 | Contradiction detection | NOT BUILT | Phase 2 (compare claims across retrieved sources). |
| 39 | Hallucination detection | PARTIAL | Benchmark hallucination traps: measured (see results). |
| 40 | Freshness detection | LIVE | Live cues, date checks, stale "most recent" rejection. |
| 41 | Uncertainty estimation | PARTIAL | Explicit "I couldn't confirm"; no calibrated confidence. |
| 42 | Self-correction | LIVE | Strict retry, plain retry, sources fallback. |
| 43 | Multi-source consensus | PARTIAL | |
| 44–50 | Browser, website, email, calendar, maps, cloud storage, external API / MCP | NOT BUILT | Phase 5. Each needs the user's authorisation (`REQUIRES_AUTH`) and approval gates first. |
| 51 | Authentication / permissions | LIVE | Accounts (PBKDF2, hashed sessions, reset). No role model. |
| 52 | Human approval gates | NOT BUILT | Phase 4, before any tool that acts. |
| 53–56 | Scheduling, recurring tasks, background jobs, queues | NOT BUILT | Phase 4/7. Free-plan limits apply. |
| 57 | Retry / recovery | LIVE | Provider fallback; client retries once on 5xx. |
| 58 | Rollback / idempotency | NOT BUILT | Needed with the first acting tool. |
| 59 | Execution tracing | PARTIAL | Debug fields on request. |
| 60 | Tool-health monitoring | PARTIAL | Public `/brain/tools` (25 tools with state), `/brain/search/providers` (per-provider health, quota) and `/brain/capabilities`. |
| 61–62 | Capability discovery / self-description | LIVE | Registry in `_worker.js`; Noria answers from it. |
| 63–64 | Multilingual / translation | LIVE | Benchmark: 4/4. |
| 65 | Tutoring | LIVE | Persona. |
| 66–72 | Science, legal-information, business, finance, travel, productivity, enterprise KB | PARTIAL | General knowledge with honest limits; enterprise KB NOT BUILT. |
| 73 | Developer assistant | LIVE | Text only. |
| 74 | Repository intelligence | NOT BUILT | |
| 75 | Debugging | LIVE | Reads code; cannot run it (see 24). |
| 76 | Test automation | NOT BUILT | |
| 77–78 | API development / web-app generation | PARTIAL | Code as text. |
| 79 | Data visualisation | LIVE | |
| 80 | Report generation | LIVE | |
| 81 | Research notebooks | NOT BUILT | |
| 82 | Artifact generation | LIVE | Documents and exports. |
| 83 | Streaming | LIVE | |
| 84 | Agent progress visibility | PARTIAL | Research progress messages. |
| 85 | User interruption | LIVE | Stop button. |
| 86 | Secure sandbox | NOT BUILT | |
| 87 | Privacy controls | PARTIAL | Delete and export account data; device memory can be cleared. |
| 88 | Permission-aware memory | NOT BUILT | |
| 89 | Audit logs | NOT BUILT | |
| 90 | Safety / policy | LIVE | Persona rules; output guard for private instructions. |
| 91 | Evaluation framework | LIVE | `bench.mjs`, `audit.mjs`, `live-check*.mjs`. |
| 92 | Regression testing | PARTIAL | Scripts exist; run by hand after every deploy. Automate: Phase 7. |
| 93 | Benchmarking | PARTIAL | Noria measured. Competitor comparison needs their outputs on the same tasks (no keys are stored here). |
| 94 | Automatic capability health tests | PARTIAL | Runtime probes in the registry. |
| 95 | Continuous monitoring | NOT BUILT | Phase 7 |
| 96 | Failure analysis | PARTIAL | Benchmark lists each failure with the answer. |
| 97–98 | Model routing / fallback models | LIVE | Groq, Mistral, Gemini, OpenRouter, Cloudflare AI, with key rotation. |
| 99 | Cost / latency optimisation | PARTIAL | Small judge calls; streaming; provider timeouts. |
| 100 | Production observability | NOT BUILT | Phase 7 |

## Build order (dependencies first)

0. **Measure** — done: `bench.mjs` (57 tasks). Grow it to hundreds of tasks; add competitor answer files for side-by-side scoring.
1. **Trust layer** — done: grounding, verification, judge, fiction and stale checks, private-instruction guard, capability registry.
2. **Knowledge** — embeddings and vector index (Cloudflare Vectorize plus Workers AI embeddings, both within free limits but sharing the daily neuron allowance), hybrid retrieval, contradiction detection across sources, knowledge-base ingestion.
3. **Memory v2** — server-side memory in D1 with user control (view, edit, delete), project memory, permission-aware retrieval.
4. **Tool layer and orchestrator** — tool registry with health, approval gates, execution tracing, audit log, in-browser code sandbox; then an agent loop (plan, act, observe, verify) starting with read-only tools (search, fetch, calculate, data, documents) and only later tools that act.
5. **Connectors** — email, calendar, maps, cloud storage, MCP. Each needs the user's own authorisation and never runs without an approval gate.
6. **Multimodal expansion** — scanned-PDF OCR, audio files, video (limited by free allowances).
7. **Operations** — scheduled benchmark runs with alerts, monitoring, observability.

## Constraints to plan around (free tiers only)

- Workers AI: 10,000 neurons a day, shared by vision, embeddings, images and speech. Anything new that uses it competes with what exists.
- Pages Functions and Workers on the free plan have a small CPU budget per request; long agent loops need to be split across requests, run in the browser, or wait for a paid plan (not planned).
- Every new capability is added flagged, tested on the benchmark before and after, and marked LIVE in the registry only when it passes.

## Design principles (added 2026-09-21)

- The benchmark **measures** Noria; it does not define her. No fix is written for one benchmark question. Fixes are mechanisms for a whole class of problems. Example: the **Temporal Evidence Resolver** (`temporalIntent` / `temporalIssues` in `_worker.js`) works out whether a question means the newest, this-year, last-year, next or an explicitly named moment, and checks the answer's years against it. It covers sports, elections, releases, holidays and prices, not just one event (`noria-eval/temporal_t.mjs`, 15 cases).
- The capability registry is the single source of truth. States: `LIVE`, `CONNECTED`, `DEGRADED` (set automatically at runtime, e.g. live search when the open web returns nothing), `REQUIRES_AUTH`, `NOT_BUILT`, `UNSUPPORTED` (refused on purpose). `UNCERTAIN` and `CONFLICT` describe an answer, not a capability: she says she is unsure, or shows the disagreement.
- Nothing becomes LIVE without the implementation, a runtime path and tests. Noria never says an outside action was done when it was not.

## Orchestrator design (Phase 4, not built)

Objective, then plan, then act, then observe, then verify, then correct or retry, then finish, then remember.

1. **Tool registry**: every tool declares a name, input schema, risk class (`read` or `write`), whether it needs the user's authorisation, and its registry state. The planner may only choose tools that are LIVE or CONNECTED.
2. **Planner**: a model call turns the objective into a short plan over registry tools (no per-topic workflows; the same planner handles a market report, a visa checklist or a data question). Independent steps are marked parallel.
3. **Executor**: runs in the **browser**, calling small worker routes one step at a time. Reason: the free plan gives each request a small CPU budget, so a long loop cannot live in one request. Step results are saved (D1) so a task can resume.
4. **Read-only tools first**: web search, page fetch, calculator, clock, weather, currency, spreadsheet queries (device), document search (device), deep research.
5. **Observe and verify each step** with the existing verifiers (sources, figures, temporal check, judge). A failed step is retried once, then reported plainly with what is missing.
6. **Write tools last**, each behind an explicit approval gate and an audit log entry; never chained silently.
7. **Progress and control** stay visible: the plan is shown, steps stream, the Stop button cancels.

## Decisions needed from the owner

1. **Search keys**: check the Tavily dashboard and add new keys (and optionally a free Brave key) with your usual secret step. Until then live search reports DEGRADED.
2. **Orchestrator location**: browser-side (free, works today, only while the page is open) or a paid always-on Worker (background and scheduled tasks). The roadmap assumes browser-side unless you decide otherwise.
3. **First connectors**: email, calendar, maps and cloud storage each need an OAuth app created under your own accounts (for example a Google Cloud project). Which first, if any.
4. **Vector index**: Cloudflare Vectorize plus embeddings use the same 10,000 neurons a day as vision, voice and images. Accept that trade-off, or keep retrieval keyword-based.

## Architecture status (2026-09-21, second pass)

Built, deployed and tested (all in `agent/` and `public/rag.js`; 135 offline checks in `noria-eval/arch_tests.mjs`):

- **Search layer** (`agent/search.js`): provider registry with per-provider timeout, retry, quota awareness (401/402/403/429 and Tavily 432/433), automatic pause, shared health, merge and de-duplication with provenance (`via`, `src`). Live finding: Tavily reports HTTP 432 on every key, so the open web is DEGRADED and Wikipedia plus news carry the load. To add a provider (for example Brave) add one entry to `SEARCH_PROVIDERS`; keys stay in secrets.
- **Tool registry** (`agent/tools.js`): 25 tools, each with name, description, input and output schema, auth, permissions, state, dependency, risk, timeout, retry, verification method and runtime. All acting tools (email, calendar, files, API) are NOT BUILT, need the person's own authorisation, and are risk `write`. Public view: `GET /brain/tools`.
- **Read-only planner** (`agent/planner.js`, `POST /brain/plan`, Noria Pro, 20 a day): the model proposes, the validator decides. Unknown tools are dropped and reported, unusable tools block their task and everything depending on it, write tools are proposed-only, cycles invalidate, the execution order is computed from dependencies, degraded tools are flagged, and every plan is stamped `executed: false`.
- **RAG pipeline** (`public/rag.js`): built and tested offline, not connected (see rows 29 to 31).

Not built: executor (sequential and parallel runs, observation, retry, cancellation, approval gates), a runtime abstraction for browser and server execution, embeddings service, persistent knowledge store, long-term memory, code sandbox, and every connector.

Runtime abstraction (for the executor): one contract, two runtimes. `run(step, tool, input, signal) -> { ok, output, observation, ms }`. The browser runtime calls the worker routes and runs the device tools; the server runtime is the same loop inside a Worker or a job. The planner, registry and verifiers do not change between them.
