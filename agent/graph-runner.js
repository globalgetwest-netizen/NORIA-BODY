// NORIA GRAPH RUNNER — carries an objective's task graph through the executor, persisting every step.
//
//   claim ready tasks (atomic) -> resolve data flow from stored results -> run each through the executor's gates -> record the outcome,
//   what it relied on, what verification said, artifacts, decisions and audit events -> promote what became ready -> repeat, until nothing
//   can run, a person is needed, or the session's budget is used (then it pauses with a checkpoint).
//
// The runner holds no state of its own. Everything it needs is in the store, so a run can stop at any moment (a closed tab, a crash, a
// deploy) and another runner can pick it up: work that finished is not repeated (the idempotency ledger), work that was in flight is
// recovered when its lease expires, and work that needs a person waits for them. Deciding WHAT to do about failures and new information
// is the controller's job (control.js); the runner only executes and records.

import { Executor } from "./executor.js";
import { AuditLog } from "./audit.js";
import { resolveRefs, collectRefs, refHash } from "./graph.js";
import { GraphToolRuntime, CompositeRuntime } from "./graph-tools.js";

// The executor's idempotency ledger, kept in the store.
// A step that only READS is safe to repeat, so its ledger entries stay in memory for this run (no network round trips). Every other step (anything
// that writes or acts) keeps its "started" / "done" record in the store BEFORE and AFTER it runs, exactly as before.
export class StoreLedger {
  constructor(store, catalog = []) { this.store = store; this.local = new Map(); this.reads = new Set(catalog.filter((t) => t.risk === "read").map((t) => t.name)); }
  isLocal(ctx) { return !!(ctx && this.reads.has(ctx.tool)); }
  async get(key, ctx) { if (this.local.has(key)) return this.local.get(key); return this.isLocal(ctx) ? null : await this.store.ledgerGet(key); }
  async set(key, rec, ctx) { if (this.isLocal(ctx)) this.local.set(key, rec); else await this.store.ledgerSet(key, rec, ctx); }
}

const STATE_OF = { done: "done", failed: "failed", blocked: "blocked", denied: "denied", denied_by_user: "denied", needs_permission: "needs_permission", awaiting_approval: "awaiting_approval", uncertain_outcome: "uncertain", cancelled: "ready", skipped: "failed" };

export class GraphRunner {
  // catalog: listTools(health). runtime: any runtime the executor accepts. policy: { mode, grants, attachments, ... }
  constructor({ store, catalog, runtime, policy = {}, owner, leaseMs = 60000, maxParallel = 3, sessionMaxTasks }) {
    this.store = store; this.catalog = catalog; this.baseRuntime = runtime; this.policy = policy; this.leaseMs = leaseMs; this.maxParallel = maxParallel; this.sessionMaxTasks = sessionMaxTasks;
    this.owner = owner || "runner_" + Math.random().toString(36).slice(2, 8); this.executor = null; this.stopped = false;
  }
  stop() { this.stopped = true; if (this.executor) this.executor.cancel(); }

  // Run the objective until nothing more can run. Returns a summary; the persistent state is the real result.
  async run(objectiveId, { maxRounds = 100 } = {}) {
    const store = this.store;
    const [obj, pol, recovered] = await store.batch([{ op: "getObjective", args: [objectiveId] }, { op: "getPolicy", args: [objectiveId] }, { op: "recover", args: [objectiveId] }, { op: "promote", args: [objectiveId] }]); // one request
    if (!obj) throw new Error("no such objective");
    const budget = this.sessionMaxTasks || pol.session_max_tasks;
    // the project's own tools (artifacts, notes) are served next to whatever the base runtime serves
    const runtime = new CompositeRuntime([new GraphToolRuntime(store, { projectId: obj.project_id, objectiveId: obj.id }, this.baseRuntime.dryRun === true), this.baseRuntime]);
    const executor = this.executor = new Executor({ catalog: this.catalog, runtime, ledger: new StoreLedger(store, this.catalog), audit: new AuditLog(),
      policy: Object.assign({}, this.policy, { approve: async (req) => { const t = (await store.tasks(objectiveId)).find((x) => x.key === req.task); return t && t.approval && t.approval.approved ? { approved: true, by: t.approval.by } : { pending: true }; } }) });
    let ran = 0, seen = 0, paused = null;
    for (let round = 0; round < maxRounds && !this.stopped; round++) {
      if (budget && ran >= budget) { paused = await store.pauseObjective(objectiveId, "the session's task budget (" + budget + ") was used"); break; }
      const room = budget ? Math.min(this.maxParallel, budget - ran) : this.maxParallel;
      const got = await store.claimReadyContext(objectiveId, this.owner, room, this.leaseMs), claimed = got.tasks; // claim + data context + stored results: one request
      if (!claimed.length) break;
      const prepared = await Promise.all(claimed.map((task) => this.prepareClaimed(obj, task, got.context, got.results)));
      await this.flushPrepared(prepared); ran += prepared.length;
      seen = await this.persistAudit(obj, executor, seen);
    }
    const state = await store.syncObjectiveState(objectiveId);
    return { objective: objectiveId, state: paused ? "paused" : state, tasks_run: ran, recovered, owner: this.owner, stopped: this.stopped, paused: !!paused, checkpoint: paused ? paused.version : undefined };
  }

  // Runs one claimed task through the executor (every gate, timeout, retry, verification, injection defence; idempotency through the ledger) and
  // returns what must be PERSISTED, without sending it yet: `ops` (recordUses/finishTask, or the single finishTask for a cancelled task), which
  // index in `ops` is the finishTask call, and `after(ok)` — the memory/lesson operations that depend on whether this runner still held the lease
  // when finishTask ran (computed only once that is known). `flushPrepared` sends every claimed task's ops together, round trips permitting; each
  // task's OWN validation, verification and audit logic here is untouched — only when its results are SENT to the store changes.
  async prepareClaimed(obj, task, ctx, results) {
    const store = this.store, key = task.key;
    // 1 data flow: the values this task's input refers to come from stored results, memory and artifacts
    const inputs = {}, errs = [], uses = [];
    for (const [tool, input] of Object.entries(task.input || {})) { const r = resolveRefs(input, ctx); inputs[tool] = r.value; errs.push(...r.errors); for (const ref of new Set(collectRefs(input))) uses.push({ ref: ref.trim(), hash: await refHash(ref.trim(), ctx) }); }
    // what this task relied on is recorded together with its outcome, so a later change can be noticed
    if (errs.length) return { key, ops: [{ op: "recordUses", args: [obj.id, key, uses] }, { op: "finishTask", args: [obj.id, key, this.owner, "failed", { error: "input could not be resolved: " + errs.join("; ") }] }, { op: "learnFromFailure", args: [obj.id, key] }], finishAt: 1, after: null };
    // 2 through the executor
    const plan = { audit: { planId: obj.id, executed: false }, tasks: [], execution_order: [] };
    const taskLike = { id: key, description: task.description, tools: task.tools, input: inputs, depends_on: task.depends_on, status: "ready", approval_required: task.approval_required, verification: task.verification };
    let r; try { r = await this.executor.runOne(plan, taskLike, results); } catch (e) { r = { status: "failed", error: String((e && e.message) || e) }; }
    const to = STATE_OF[r.status] || "failed";
    // 3 what verification said about it (this feeds planning later)
    const rec = this.executor.audit.records.filter((x) => x.task === key), vfail = rec.filter((x) => x.event === "verification_failed").pop(), vok = rec.filter((x) => x.event === "completed").pop();
    const verification = vfail ? { ok: false, method: vfail.method, detail: vfail.detail } : vok && vok.verified ? { ok: true, method: vok.verified } : null;
    // 4 outputs: files a step produced become versioned artifacts; the rest is the task's stored output (each artifact is its own call: content
    // can be large, and one artifact's failure must not affect the others — not folded into the batched round trip below)
    let output = r.output === undefined ? null : r.output;
    if (output && typeof output === "object" && Array.isArray(output.artifacts)) {
      const refs = [];
      for (const a of output.artifacts) { try { refs.push(await store.addArtifact(obj.project_id, { objectiveId: obj.id, taskKey: key, name: a.name, kind: a.kind, content: a.content, meta: a.meta })); } catch (e) { refs.push({ name: a && a.name, error: String(e.message) }); } }
      output = Object.assign({}, output, { artifacts: refs });
    }
    const notes = r.notes || [];
    if (notes.some((n) => /alternative/i.test(n))) await store.addDecision(obj.project_id, { objectiveId: obj.id, taskKey: key, decision: "used an alternative tool for " + key, rationale: notes.join(" "), madeBy: "noria" });
    if (r.status === "cancelled") return { key, ops: [{ op: "finishTask", args: [obj.id, key, this.owner, "ready", { notes: ["interrupted; will run again"], attemptOutcome: "cancelled" }] }], finishAt: 0, after: null };
    return { key, ops: [{ op: "recordUses", args: [obj.id, key, uses] }, { op: "finishTask", args: [obj.id, key, this.owner, to, { output, error: r.error, notes, verification }] }], finishAt: 1,
      // 5 memory and lessons: decided only once `ok` (did this runner still hold the lease when finishTask ran) is known
      after: (ok) => {
        const post = [];
        if (ok && to === "done" && task.remember) for (const [mkey, path] of Object.entries(task.remember)) {
          const p = /^output\b/.test(path) ? path : "output." + path, got = resolveRefs("{{" + key + "." + p + "}}", { results: { [key]: { output } } });
          if (!got.errors.length && got.value !== undefined && got.value !== null) post.push({ op: "memSet", args: [obj.project_id, mkey, typeof got.value === "string" ? got.value : JSON.stringify(got.value), "task:" + key] });
        }
        if (ok && to === "failed") post.push({ op: "learnFromFailure", args: [obj.id, key] }); // what went wrong is kept, briefly, for the next plan
        return post;
      } };
  }

  // Sends every claimed task's ops in as few round trips as the store's batch cap allows (chunked, in order), then — now that each task's real
  // finishTask result is known — sends the memory/lesson follow-ups the same way. If the combined send fails for any reason, falls back to one
  // call per task so a single bad task can never block another task's own, independent persistence (the same isolation a separate call per task
  // always had); this is strictly an additional network path, never a substitute for the per-task validation done in prepareClaimed above.
  async flushPrepared(prepared) {
    if (!prepared.length) return;
    const allOps = [], spans = [];
    for (const p of prepared) { spans.push({ start: allOps.length, finishAt: p.finishAt }); allOps.push(...p.ops); }
    let results;
    try { results = await this.sendBatched(allOps); }
    catch (_) {
      results = new Array(allOps.length);
      for (let i = 0; i < prepared.length; i++) {
        try { const r = await this.store.batch(prepared[i].ops); for (let j = 0; j < r.length; j++) results[spans[i].start + j] = r[j]; } catch (_) { /* this task's own persistence failed; its `after` sees ok=false, same as a lost lease */ }
      }
    }
    const post = [];
    prepared.forEach((p, i) => { if (p.after) post.push(...p.after(results[spans[i].start + spans[i].finishAt])); });
    if (!post.length) return;
    try { await this.sendBatched(post); }
    catch (_) { for (const op of post) { try { await this.store.batch([op]); } catch (_) {} } }
  }
  // The store's own batch() caps how many operations one call may carry; chunk transparently so a round with many tasks still works.
  async sendBatched(ops, chunk = 12) {
    const out = [];
    for (let i = 0; i < ops.length; i += chunk) out.push(...(await this.store.batch(ops.slice(i, i + chunk))));
    return out;
  }

  // The executor's own audit records are copied into the project's persistent, chained event history, linked to the task and attempt.
  async persistAudit(obj, executor, from) {
    const recs = executor.audit.records; const store = this.store;
    if (recs.length <= from) return from;
    await store.appendEvents(obj.project_id, recs.slice(from).map((rec) => ({ kind: "exec_" + rec.event, objectiveId: obj.id, taskKey: rec.task, data: { tool: rec.tool, detail: rec.detail, action: rec.action, why: rec.why, attempt: rec.attempt, verified: rec.verified, removed: rec.removed } }))); // one request per round
    return recs.length;
  }
}
