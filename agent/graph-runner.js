// NORIA GRAPH RUNNER — carries an objective's task graph through the executor, persisting every step.
//
//   claim ready tasks (atomic) -> resolve data flow from stored results -> run each through the executor's gates -> record the outcome,
//   artifacts, decisions and audit events -> promote what became ready -> repeat, until nothing can run.
//
// The runner holds no state of its own. Everything it needs is in the store, so a run can stop at any moment (a closed tab, a crash, a
// deploy) and another runner can pick it up: work that finished is not repeated (the idempotency ledger), work that was in flight is
// recovered when its lease expires, and work that needs a person waits for them.

import { Executor } from "./executor.js";
import { AuditLog } from "./audit.js";
import { resolveRefs } from "./graph.js";

// The executor's idempotency ledger, kept in the store.
export class StoreLedger {
  constructor(store) { this.store = store; }
  async get(key) { return await this.store.ledgerGet(key); }
  async set(key, rec, ctx) { await this.store.ledgerSet(key, rec, ctx); }
}

const STATE_OF = { done: "done", failed: "failed", blocked: "blocked", denied: "denied", denied_by_user: "denied", needs_permission: "needs_permission", awaiting_approval: "awaiting_approval", uncertain_outcome: "uncertain", cancelled: "ready", skipped: "failed" };

export class GraphRunner {
  // catalog: listTools(health). runtime: any runtime the executor accepts. policy: { mode, grants, attachments, ... }
  constructor({ store, catalog, runtime, policy = {}, owner, leaseMs = 60000, maxParallel = 3 }) {
    this.store = store; this.catalog = catalog; this.runtime = runtime; this.policy = policy; this.leaseMs = leaseMs; this.maxParallel = maxParallel;
    this.owner = owner || "runner_" + Math.random().toString(36).slice(2, 8); this.executor = null; this.stopped = false;
  }
  stop() { this.stopped = true; if (this.executor) this.executor.cancel(); }

  // Run the objective until nothing more can run. Returns a summary; the persistent state is the real result.
  async run(objectiveId, { maxRounds = 100 } = {}) {
    const store = this.store, obj = await store.getObjective(objectiveId);
    if (!obj) throw new Error("no such objective");
    const recovered = await store.recover(objectiveId);
    await store.promote(objectiveId);
    const executor = this.executor = new Executor({ catalog: this.catalog, runtime: this.runtime, ledger: new StoreLedger(store), audit: new AuditLog(),
      policy: Object.assign({}, this.policy, { approve: async (req) => { const t = (await store.tasks(objectiveId)).find((x) => x.key === req.task); return t && t.approval && t.approval.approved ? { approved: true, by: t.approval.by } : { pending: true }; } }) });
    let ran = 0, seen = 0;
    for (let round = 0; round < maxRounds && !this.stopped; round++) {
      const claimed = await store.claimReady(objectiveId, this.owner, this.maxParallel, this.leaseMs);
      if (!claimed.length) break;
      await Promise.all(claimed.map(async (task) => { await this.runClaimed(obj, task); ran++; }));
      seen = await this.persistAudit(obj, executor, seen);
    }
    const state = await store.syncObjectiveState(objectiveId);
    return { objective: objectiveId, state, tasks_run: ran, recovered, owner: this.owner, stopped: this.stopped };
  }

  async runClaimed(obj, task) {
    const store = this.store, key = task.key;
    // 1 data flow: the values this task's input refers to come from stored results, memory and artifacts
    const ctx = await store.dataContext(obj.project_id, obj.id), inputs = {}, errs = [];
    for (const [tool, input] of Object.entries(task.input || {})) { const r = resolveRefs(input, ctx); inputs[tool] = r.value; errs.push(...r.errors); }
    if (errs.length) { await store.finishTask(obj.id, key, this.owner, "failed", { error: "input could not be resolved: " + errs.join("; ") }); return; }
    // 2 through the executor: every gate, timeout, retry, verification, injection defence; idempotency through the ledger
    const results = await store.results(obj.id);
    const plan = { audit: { planId: obj.id, executed: false }, tasks: [], execution_order: [] };
    const taskLike = { id: key, description: task.description, tools: task.tools, input: inputs, depends_on: task.depends_on, status: "ready", approval_required: task.approval_required, verification: task.verification };
    let r; try { r = await this.executor.runOne(plan, taskLike, results); } catch (e) { r = { status: "failed", error: String((e && e.message) || e) }; }
    const to = STATE_OF[r.status] || "failed";
    // 3 outputs: files a step produced become versioned artifacts; the rest is the task's stored output
    let output = r.output === undefined ? null : r.output;
    if (output && typeof output === "object" && Array.isArray(output.artifacts)) {
      const refs = [];
      for (const a of output.artifacts) { try { refs.push(await store.addArtifact(obj.project_id, { objectiveId: obj.id, taskKey: key, name: a.name, kind: a.kind, content: a.content, meta: a.meta })); } catch (e) { refs.push({ name: a && a.name, error: String(e.message) }); } }
      output = Object.assign({}, output, { artifacts: refs });
    }
    const notes = r.notes || [];
    if (notes.some((n) => /alternative/i.test(n))) await store.addDecision(obj.project_id, { objectiveId: obj.id, taskKey: key, decision: "used an alternative tool for " + key, rationale: notes.join(" "), madeBy: "noria" });
    if (r.status === "cancelled") await store.finishTask(obj.id, key, this.owner, "ready", { notes: ["interrupted; will run again"], attemptOutcome: "cancelled" });
    else await store.finishTask(obj.id, key, this.owner, to, { output, error: r.error, notes });
  }

  // The executor's own audit records are copied into the project's persistent, chained event history, linked to the task and attempt.
  async persistAudit(obj, executor, from) {
    const recs = executor.audit.records; const store = this.store;
    for (const rec of recs.slice(from)) await store.appendEvent(obj.project_id, { kind: "exec_" + rec.event, objectiveId: obj.id, taskKey: rec.task, data: { tool: rec.tool, detail: rec.detail, action: rec.action, why: rec.why, attempt: rec.attempt, verified: rec.verified, removed: rec.removed } });
    return recs.length;
  }
}
