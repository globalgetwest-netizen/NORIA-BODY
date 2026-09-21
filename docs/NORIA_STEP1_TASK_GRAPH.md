# Step 1 — persistent, resumable objective execution

Status: built, deployed (worker and tables), tested. **Foundation only**: none of this is usable by a person yet, so no capability is marked "Implemented" (see `GET /brain/families`, entries `lt-*`, all `foundation` and verified at component level).

## 1. D1 schema (`agent/graph-store.js` `SCHEMA`, applied from `noria-ai/schema-graph.sql`)

All tables are additive (`CREATE … IF NOT EXISTS`) and every row carries `user_id`; every query is scoped to the signed-in user.

| Table | Purpose | Key |
|---|---|---|
| `g_projects` | a person's project (title, status) | `id` |
| `g_objectives` | a goal inside a project; keeps the validated plan (audit), `graph_version`, status | `id` |
| `g_tasks` | one row per task: tools, input (with `{{refs}}`), status, attempts, lease, output, error, notes, approval | `(objective_id, task_key)` |
| `g_task_deps` | dependency edges (normalised so readiness is one SQL query) | `(objective_id, task_key, depends_on)` |
| `g_attempts` | every attempt: owner, start, end, outcome (`done`, `failed`, `interrupted`…) | `id` |
| `g_ledger` | idempotency: one row per step key; `started` or `done` with the output | `idem_key` |
| `g_artifacts` | versioned outputs (name, kind, content ≤ 200 KB, sha256, task and objective that made it) | `(project_id, name, version)` |
| `g_decisions` | what was decided, why, by whom (Noria or a person) | `id` |
| `g_memory` | project memory: facts the project carries; deletable | `(project_id, mkey)` |
| `g_events` | append-only history, hash-chained per project, linked to objective, task and attempt | `(project_id, seq)` |
| `g_schedules` | when an objective should next be looked at (a stored intention; nothing runs by itself) | `objective_id` |

## 2. Model

```
User ─ Project ─┬─ Objective ─ Task graph (tasks + dependencies + inputs + states)
                ├─ Artifacts (versioned)      ├─ Decisions      ├─ Memory      ├─ History (chained events)
```
An objective is created from a **validated plan** (`validatePlan`): tasks become rows, dependencies become edges, blocked tasks start blocked, tasks with no dependencies start ready. The plan is stored with the objective. Nothing is specific to read-only work: risk, approval and authority are properties of the tools, enforced by the executor at run time.

## 3. Task lifecycle (`agent/graph.js` `TRANSITIONS`)

```
pending ─► ready ─► running ─► done
   │         │         ├─► failed ─► ready (retry) / removed
   │         │         ├─► awaiting_approval ─► ready (approved) / denied
   │         │         ├─► needs_permission ─► ready (granted)
   │         │         ├─► uncertain ─► ready / done / failed (a person resolves)
   │         │         ├─► denied, blocked
   │         │         └─► ready (interrupted or recovered)
   └─► blocked / skipped / cancelled / removed
```
`done`, `cancelled`, `removed` are final. Every move is checked against the table and applied by a compare-and-set `UPDATE … WHERE status = <from>`, so a bug or a race cannot move work backwards or overwrite another runner. Objective state (planned, running, awaiting_user, completed, partial, failed, paused, cancelled) is derived from its tasks. `promote` makes a pending task ready when all dependencies are done, and skips it when a dependency can no longer succeed.

## 4. How data moves between tasks

A task's input may contain references: `{{t1.output.value}}`, `{{t2.output.sources[0].title}}`, `{{memory.key}}`, `{{artifact.name}}`. When a task is claimed, the runner reads stored results, memory and artifacts and resolves them: a whole-string reference keeps its type (a number stays a number), one inside a longer string is inserted as text. **An unresolvable reference fails that task with the reason; nothing is ever replaced by an empty value.** A reference implies a dependency, so a task cannot run before what it reads exists. Tool outputs are stored, so data flow survives restarts. The planner prompt tells the model how to write references.

## 5. How resume works

The runner keeps no state. Everything is in D1.
1. A runner **claims** ready tasks by one atomic UPDATE that also sets an owner and a **lease** (default 60 s). Two runners cannot claim the same task.
2. If the runner dies (closed tab, crash, deploy) its tasks stay `running` until the lease expires.
3. Any later run starts with `recover`: a `running` task whose lease has expired returns to `ready`, its attempt is recorded as `interrupted`, and a `task_recovered` event is written.
4. The run continues; finished tasks are never touched. A new process, browser or day can do this.

## 6. How idempotency is enforced

Every step has a key (objective, task, tool, resolved input). Before a tool runs, the executor reads `g_ledger`:
- **done** → the stored result is returned; the tool is **not** run again (crash after the tool ran but before the result was recorded).
- **started, tool only reads** → safe to run again.
- **started, tool acts (risk write)** → **not** run again. The task becomes `uncertain` ("it may already have happened"), and a person resolves it. This check happens before approval, so nothing that may have happened is re-approved or repeated.
The `started` marker is written before the tool runs. Approvals and permissions never bypass it.

## 7. Project memory

`g_memory` holds keyed facts (strings or JSON, ≤ 20 KB, ≤ 500 per project). `memSearch` ranks by shared words; `context()` gathers relevant memory, recent decisions and artifact names for a step; `{{memory.key}}` feeds inputs. Facts can be corrected and deleted; the deletion event records the key only, never the value. Deleting a project or an account deletes all of it (tested: zero rows remain).

## 8. How the existing executor connects

`GraphRunner` (`agent/graph-runner.js`) claims tasks, resolves inputs, and calls `Executor.runOne` for each, so every gate is unchanged: registry, availability, input schema, read-only gate, permission, idempotency, approval, timeout, retry, verification, injection defence. Changes to the executor for persistence: an async ledger (memory or D1), the `started` marker, "pending approval" as a resumable wait, and the idempotency check moved ahead of approval. Outcomes are mapped to task states; artifacts a step returns are stored and replaced by references; the executor's audit records are copied into the project's chained history with the task and attempt. Runs in the browser today (through `agent/graph-client.js` over `POST /graph/op` on the accounts worker); the same runner and store work on a server runtime later.

## 9. Tests

| Suite | Checks | What it proves |
|---|---|---|
| `graph_t.mjs` (real SQL on SQLite, which is what D1 is) | 108 | schema, isolation between users, graph creation, state machine, runs, data flow and its errors, **persistence across a process restart (file-backed)**, **resume after interruption**, **crash after the tool ran (no repeat)**, **uncertain acting steps**, **two concurrent runners (each task once)**, failure and revision, approvals and permissions, cancellation and pause, artifacts, memory, tamper detection, concurrent history writes, scheduling, account deletion |
| `graph_api_t.mjs` (real routes, real sessions, local D1) | 27 | access control, allow-listed operations only, a run over HTTP, a "restart" with a new client and runner, crash and recovery, approval, isolation between two accounts, account deletion |
| `families_t.mjs` | 25 | Target / Implemented / Verified rules; the new capabilities are foundation and component-verified only; plain-language labels |
| all offline suites (`arch_tests.mjs`) | 476 | regression and infrastructure evidence |

Bugs the tests found and fixed: a plan referring to a non-existent task crashed the cycle check instead of being refused; the idempotency check ran after approval; event-chain writes lost races under six concurrent writers (now backed off and retried); revisions could not re-point dependents of a removed task. In production the tables and routes exist and refuse unauthenticated calls; a test account made while checking was removed.

## 10. What remains missing after Step 1

- **Nothing a person can use**: no screen for projects, and the runner is not connected to the planner route or the app. No real account has run a graph in production.
- **Replanning from results**: a graph can be revised (by code or a person) but nothing decides to revise it after a failure or new information.
- **Background continuation**: schedules are stored; nothing triggers a run when the page is closed.
- **Artifact producers**: no tool yet returns artifacts, and there is no artifact viewer.
- **Automatic memory writes** and richer retrieval (embeddings).
- **A model step executor**: reasoning and writing steps are handed back to the conversation, not run by the graph.
- **Approval experience**: approvals exist as state and a call; there is no interface.
- **Acting tools**, connectors, code sandbox, RAG connection (each needs its own decision and tests).
- **D1 free-plan write limits** have not been measured under a long run.
- The history detects changes and removals but is not signed.
