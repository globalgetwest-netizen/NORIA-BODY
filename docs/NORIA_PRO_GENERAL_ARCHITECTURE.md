# Noria Pro — general architecture (designed from the goal backwards)

**The goal.** Noria and Noria Pro should be able to take almost any legitimate objective, from a quick question to a months-long project, work out what it needs, use the right knowledge, models, tools and data, produce real work, verify it, recover from failure, ask for approval where it matters, remember what happened, and keep going as the world changes.

**What the tests are.** They are instruments that measure the machinery. They are not a list of what Noria can do, and no capability is defined by what has passed. Every capability is tracked as three separate facts (`GET /brain/families`, `agent/families.js`):

- **Target**: what Noria is meant to become. This is the ambition and is never a claim.
- **Implemented**: none, architecture, foundation, partial, yes. What has actually been built.
- **Verified**: none, component, read_only, real_runtime. What has been tested for real.

Rules enforced by `families_t.mjs`: verified needs evidence and evidence must be real; verified cannot exceed implemented; a capability resting only on tools that are not built cannot be implemented; a partial capability must say what is missing. Today: 12 families, 59 target capabilities, of which 15 are "yes", 15 "partial", 7 "foundation", 4 "architecture" and 18 "none"; verified: 5 in the real runtime, 1 read-only, 15 at component level, 38 not verified.

## 1. The loop

```
OBJECTIVE ──► UNDERSTAND ──► DECOMPOSE ──► TASK GRAPH ──► SCHEDULE ──► EXECUTE ──► OBSERVE
    ▲                                            ▲                                   │
    │                                            └── REVISE ◄── VERIFY ◄────────────┘
    └──────────── MEMORY (project, decisions, history, new information) ◄── COMPLETE
```

Nothing in it is specific to a topic. A market report, a visa checklist, a course in four languages, a software build and a monitoring job are all objectives that become task graphs over the same registered tools.

## 2. What exists (foundation) and what does not

| Layer | Exists | Missing |
|---|---|---|
| Understand and plan | Read-only planner: tasks, tools, per-tool inputs, dependencies, verification, missing capabilities, audit stamp | Replanning after results; plans that persist and change |
| Tool registry | 25 tools with schema, auth, permissions, risk, timeout, retry, verification, runtime, provider, tests | Most tools that create or act; connector plug-ins |
| Executor | Dry-run and read-only-live modes; gates, approval, idempotency, timeout, cancellation, retry, recovery, verification, injection defence, hash-chained audit | Data flow between tasks (a step using an earlier result); persistence; resume |
| Runtimes | Browser runtime (read-only) with side-effect monitor | Server / background runtime |
| Knowledge | Search layer with provider health; RAG pipeline (offline) | Embedding service; persistent index; connection to documents |
| Memory | Device facts; account conversation sync | Project, task, decision, permission-aware memory |
| Verification | Sources, figures, temporal, office evidence, fiction, judge, citation checks | Contradiction detection; calibrated confidence |
| Control | Read-only gate; approval gates; health states | Acting tools; per-project budgets and scopes; approval UI |
| Evaluation | Regression suites and a benchmark | Unseen-task evaluation (section 6) |

## 3. Data model for long-running work

```
User ─┬─ Project ─┬─ Objective ── TaskGraph ─┬─ Task ── Step ── Result
      │           │                          └─ Checkpoint
      │           ├─ Artifact (document, dataset, code, image; versioned)
      │           ├─ Decision (what was chosen, why, by whom)
      │           ├─ Memory (facts, preferences, corrections; deletable)
      │           ├─ Schedule (when to run or re-check)
      │           └─ Authority (tools allowed, budgets, approvals required)
      └─ Audit (append-only, hash-chained; every gate, approval, result)
```

- **Persistence**: the free plan already has D1 (accounts), KV, the Cache API and a 10-minute Cron Trigger on `noria-ai`. A task graph is stored as rows plus an append-only event log, so a run can be resumed after a crash, a closed tab or a deploy. A step is idempotent by key, so resuming never repeats an action.
- **Artifacts** are first-class: every document, spreadsheet, chart or code file a task makes is stored with its version, the task that made it and the sources it used, so a report can be regenerated when new information arrives.
- **Authority** is per project and enforced in the tool layer: which tools, which sources, which budgets (time, calls, cost), what needs approval. It is never granted by a runtime.

## 4. Capability families and what each needs

Each family is a set of tools plus the verification that suits it; none is a hard-coded workflow.

- **Research**: providers (web, news, official, academic, specialised), source ranking, contradiction detection, longitudinal monitoring, citation. Needs: more providers, a claim store.
- **Documents**: parsing (PDF, Office, scans with OCR), chunking, hybrid retrieval, structured extraction, generation and transformation. Needs: OCR service, persistent knowledge store, connection of the RAG pipeline.
- **Code**: an isolated sandbox (in-browser Web Worker for JavaScript, Pyodide for Python first), test runner, repository access, deployment. Needs: the sandbox, then repository connectors.
- **Data**: exact table engine, SQL against connected databases (read-only first), statistics, forecasting, dashboards.
- **Creation**: text, images, slides, sites and apps as artifacts that are built, run and checked, not only written.
- **Multimodal**: vision, audio, video with their own verification (for example, OCR text compared with the page).
- **Business and productivity**: email, calendar, storage, CRM and similar as connector tools, each with its own authorisation and approval policy.
- **Long-term**: projects, tasks and decisions above; background runtime for scheduled and long jobs.

## 5. Build order (each step is useful alone and unblocks the next)

1. **Task-graph state and resume** (read-only tools first): data flow between steps, checkpoints, persistence in D1, revise-after-result. Unblocks everything long-running.
2. **Artifact store** with versions and provenance.
3. **Connect RAG** to real embeddings and a persistent index, then to the document path.
4. **Code sandbox** in the browser (no network, time and memory limits), then test running.
5. **Project memory** (facts, decisions, corrections) with view, edit and delete.
6. **Approval experience** in the app (what will happen, on what data, approve or refuse) and the app screen for read-only execution.
7. **Server / background runtime** so scheduled and long tasks run when the page is closed (the free plan's cron gives 10-minute granularity; anything finer or heavier needs a decision).
8. **Connectors** one at a time, each with your own account authorisation, tests and an explicit decision before any acting tool is enabled.
9. **Broader providers**: more search and academic sources, document OCR.

## 6. Evaluation that cannot be gamed

The regression suite (`arch_tests.mjs`, `bench.mjs`) checks that known behaviour does not break. It says nothing about generality. Generality is measured on tasks Noria has never seen:

- A **held-out pool** of objectives across every family, written and kept apart from development, never used to tune a prompt, rule or threshold. Tasks rotate, and any task used in a fix is retired from the pool.
- **Generated variation**: objectives assembled from family × domain × constraint templates (for example, "compare X and Y using Z sources and produce W"), so the pool is far larger than anyone can memorise.
- **Grading**: objective checks where they exist (a computed number, a coded result that runs, a cited source that supports the claim); otherwise rubric grading by an independent judge model plus a sample checked by a person.
- **Reported per family, and by outcome**: completed, partially completed with honest gaps, correctly declined for a missing capability, wrong. The last is what matters most.
- **The scoreboard is the three facts**: Target, Implemented, Verified, per capability, with the evidence linked.

## 7. Constraints that shape the design (free tiers)

Workers AI 10,000 neurons a day is shared by vision, voice, images and any embeddings; the open-web search provider is currently out of allowance; a request has a small CPU budget (so long loops run in the browser or in short resumable steps); the cron granularity is 10 minutes. The architecture assumes these limits can be lifted later without redesign: the runtime, providers and stores are behind interfaces.

## 8. Decisions needed from the owner

1. **Persistence for task graphs**: D1 on the free plan (recommended to start), or something else.
2. **Background runtime**: free cron-driven resumable steps first, or an always-on worker.
3. **Order**: whether step 1 (task graphs and resume) comes before connecting RAG and the app screen for read-only execution.
4. **Search coverage**: new search keys or a second provider so the research family stops being degraded.
5. **Any acting tool**: individually, in writing, after you have seen its tests and its side-effect audit.
