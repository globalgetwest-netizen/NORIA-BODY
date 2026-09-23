# Step 2 — the control loop around the task graph

OBJECTIVE → UNDERSTAND → PLAN → TASK GRAPH → EXECUTE → OBSERVE → VERIFY → UPDATE MEMORY/ARTIFACTS → REVISE → CONTINUE → COMPLETE

Code: `agent/control.js` (Controller, failure classification, proposal validation), `agent/graph-store.js` (schema v2, revision/supersede/pause/resume),
`agent/graph-runner.js`, `agent/graph-tools.js` (artifact.write / artifact.read / project.note), `agent/background.js` (switched off).
Tests: `noria-eval/control_t.mjs` (111 checks, real SQLite), `graph_api_t.mjs` (control loop over HTTP on a local D1).

| # | Item | How |
|---|------|-----|
| 1 | Revision after failure | Controller classifies each failed/blocked task, asks a re-planner for a proposal, validates it, applies it via `reviseGraph`. |
| 2 | New information invalidates an assumption | `observe()` writes memory + decision, `staleCheck()` compares recorded `g_task_uses` hashes, `supersedeMany()` replaces stale work and its dependents. |
| 3 | Re-plan without destroying finished work | Validation refuses removing done/running work; skipped chains are re-opened after a revision. |
| 4 | Outputs/artifacts preserved | Superseded tasks keep their output; artifacts are versioned (old versions readable). |
| 5 | Retry ≠ replan | Transient → bounded retry (same plan, recorded); input/verification/capability → replan; permission/approval/denial/uncertain → always a person. |
| 6 | Verification feeds planning | `last_verification` stored per task and given to the re-planner with lessons. |
| 7 | Memory/context for later tasks | `remember` maps outputs into project memory; `{{memory.k}}`; lessons kept (latest 20). |
| 8 | Artifacts between tasks | `artifact.write/read`, `{{artifact.name}}`, `project.note` — the person's own project store only. |
| 9 | Pause/resume | Session budget → checkpoint artifact; `resumeObjective` reports what changed; survives restart. |
| 10 | Background runtime | `background.js` path written and tested; `BACKGROUND_EXECUTION_AUTHORISED = false`; nothing calls it. |

## Honest limits
* The model only proposes; tests use a scripted stand-in. How good a real model's revisions are is **not measured**.
* `/brain/replan` is Pro-gated; not smoke-tested live without a Pro code.
* No screen yet. Background execution disabled. Acting tools still not authorised; acting steps are never repeated automatically after new information.
* Judgment call for the owner: `artifact.write` / `project.note` are treated as read-only-gate-eligible because they write only into the person's own project store.
* Deploy needs the v2 D1 migration first: `noria-ai/migrate-graph-v2.sql` (production graph tables are empty).
