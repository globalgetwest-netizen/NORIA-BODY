// NORIA EXECUTOR — a permissioned execution engine, DRY-RUN ONLY.
//
// The planner proposes, the validator decides, and this engine carries the plan out step by step. It is not autonomy: every step passes
// through the same gates, in this order, and every gate writes to a tamper-evident audit log.
//
//   PLAN (validated) -> for each task, in dependency order (safe read-only tasks of one level run in parallel):
//     1 REGISTRY        the tool must exist in the tool registry; an unregistered capability is refused
//     2 AVAILABILITY    live / connected / degraded run; not built, unsupported, or needing authorisation do not
//     3 INPUT           the input is checked against the tool's declared schema
//     4 PERMISSION      the tool's authentication class (pro / account / oauth) must have been granted, and a runtime must support it
//     5 RISK + APPROVAL a tool that changes something outside Noria (risk "write") never runs without explicit approval
//     6 IDEMPOTENCY     the same step with the same input never executes twice
//     7 EXECUTE         through the runtime, with timeout, cancellation and the tool's retry policy
//     8 OBSERVE         the result is captured; instruction-like text inside it is flagged and removed (tool output is DATA, never a command)
//     9 VERIFY          checked by the tool's declared method (schema, sources, exact, temporal)
//    10 RECOVER         retry, switch to a registered alternative, or stop honestly; never repeat blindly
//
// Steps come ONLY from the plan. Nothing a tool returns can add a step or a tool.
// Modes: "dry-run" (a simulated runtime touches nothing) and "read-only-live" (real read-only tools only; the shared read-only gate runs
// BEFORE approval, so nothing can approve its way past it). A mode that lets tools act does not exist: it is refused.
// The permission and approval logic is here, in the tool layer. No runtime, browser or otherwise, is trusted to enforce it.

import { canUse } from "./tools.js";
import { AuditLog } from "./audit.js";
import { readOnlyLiveGate, LIVE_READONLY_AUTHORISED, LIVE_ACTING_AUTHORISED } from "./gate.js";

export const LIVE_EXECUTION_AUTHORISED = false;

// ── helpers (exported for tests) ─────────────────────────────────────────────────────────────────────────────────────
const TYPE_OK = { string: (v) => typeof v === "string", number: (v) => typeof v === "number" && isFinite(v), boolean: (v) => typeof v === "boolean", array: (v) => Array.isArray(v), object: (v) => v && typeof v === "object" && !Array.isArray(v), file: (v) => v && typeof v === "object" && !!v.name };
export function validateInput(schema, input) {
  const errs = [];
  for (const [k, spec] of Object.entries(schema || {})) {
    const v = input && input[k];
    if (v === undefined || v === null || v === "") { if (spec.required) errs.push("missing required input \"" + k + "\""); continue; }
    if (spec.type && TYPE_OK[spec.type] && !TYPE_OK[spec.type](v)) errs.push("input \"" + k + "\" must be " + spec.type);
  }
  return errs;
}
// Inputs come from the task (task.input[tool], proposed by the planner). A FILE is never invented: it must be one the person actually
// attached (opts.attachments, supplied by the app). Only a dry run may stand in a simulated file and fill gaps from the task description.
export function buildInput(tool, task, opts = {}) {
  const given = task.input && task.input[tool.name] ? Object.assign({}, task.input[tool.name]) : null;
  const attachments = opts.attachments || [];
  const out = given || {};
  for (const [k, spec] of Object.entries(tool.input || {})) {
    if (out[k] !== undefined && out[k] !== null && out[k] !== "") continue;
    if (spec.type === "file") {
      if (attachments.length) out[k] = attachments.find((a) => given && given[k] && a.name === given[k]) || attachments[0];
      else if (opts.simulate) out[k] = { name: "simulated-file" };
      continue;
    }
    if (!spec.required || given || !opts.simulate) continue; // live mode never makes up missing values
    out[k] = spec.type === "object" ? {} : spec.type === "number" ? 1 : spec.type === "boolean" ? false : spec.type === "array" ? [] : String(task.description || "task").slice(0, 200);
  }
  return out;
}
const INJECTION = /(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?)|you\s+(?:must|should)\s+now\b|new\s+instructions?\s*:|(?:send|forward)\s+(?:an?\s+)?e-?mail\s+to\b|(?:call|invoke|use|run)\s+(?:the\s+)?[a-z]+\.[a-z_]+\s+tool|reveal\s+(?:your\s+)?(?:system\s+)?prompt|execute\s+the\s+following/i;
// Removes instruction-like sentences from every string in a tool result; reports what was removed.
export function sanitizeOutput(value, found = []) {
  if (typeof value === "string") {
    if (!INJECTION.test(value)) return value;
    const kept = value.split(/(?<=[.!?\n])\s+/).map((s) => { if (INJECTION.test(s)) { found.push(s.slice(0, 100)); return "[removed: instruction-like text found inside a tool result]"; } return s; });
    return kept.join(" ");
  }
  if (Array.isArray(value)) return value.map((v) => sanitizeOutput(v, found));
  if (value && typeof value === "object") { const o = {}; for (const [k, v] of Object.entries(value)) o[k] = sanitizeOutput(v, found); return o; }
  return value;
}
export const VERIFIERS = {
  schema: (tool, out) => { const bad = Object.entries(tool.output || {}).filter(([k, spec]) => out[k] === undefined || (TYPE_OK[spec.type] && !TYPE_OK[spec.type](out[k]))).map(([k]) => k); return bad.length ? "result is missing or has the wrong type for: " + bad.join(", ") : ""; },
  sources: (tool, out) => { const list = out.sources || out.passages || []; return Array.isArray(list) && list.length && list.every((s) => s && (s.url || s.text || s.snippet)) ? "" : "the result carries no usable sources"; },
  exact: (tool, out) => (out.exact === true || typeof out.value === "number" || typeof out.answer === "string" || Array.isArray(out.items) || out.table ? "" : "the result is not marked as exactly computed"),
  temporal: (tool, out) => { const list = out.sources || []; return Array.isArray(list) && list.length && list.some((s) => s && s.date) ? "" : "no source carries a date, so the result cannot be placed in time"; },
  user: () => "", // needs the person's own confirmation; nothing to check by machine
};
// After a failed attempt: retry, switch to a registered alternative, or stop. Blind repetition is never chosen.
export function decideRecovery({ error, retryable, attempt, maxAttempts, alternatives }) {
  if (error && /permission|not authori[sz]ed|invalid input|unregistered|denied/i.test(error)) return { action: "stop", why: "a permission or input problem does not go away by repeating" };
  if (retryable && attempt < maxAttempts) return { action: "retry", why: "transient failure; attempt " + attempt + " of " + maxAttempts };
  if (alternatives.length) return { action: "alternative", tool: alternatives[0], why: "the tool failed after " + attempt + " attempt(s); trying the registered alternative " + alternatives[0] };
  return { action: "stop", why: retryable ? "retries exhausted and no alternative is registered" : "the failure is not retryable and no alternative is registered" };
}
const sleep = (ms, signal) => new Promise((res, rej) => { if (!ms) return res(); if (signal && signal.aborted) return rej(Object.assign(new Error("cancelled"), { cancelled: true })); const t = setTimeout(res, ms); if (signal) signal.addEventListener("abort", () => { clearTimeout(t); rej(Object.assign(new Error("cancelled"), { cancelled: true })); }, { once: true }); });
async function keyOf(text) { const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join(""); }

export class Executor {
  // catalog: listTools(health) (each tool with .available). policy: { mode, grants[], approve(request), maxParallel, timeoutCapMs, backoffScale }
  constructor({ catalog, runtime, policy = {}, audit = null, ledger = null }) {
    if (LIVE_EXECUTION_AUTHORISED !== false || LIVE_ACTING_AUTHORISED !== false) throw new Error("an acting-execution flag is set: refusing to start");
    if (policy.mode === "dry-run") { if (!runtime || runtime.dryRun !== true) throw new Error("a runtime that can touch the real world is refused in dry-run mode"); }
    else if (policy.mode === "read-only-live") {
      if (LIVE_READONLY_AUTHORISED !== true) throw new Error("read-only live execution is not authorised");
      if (!runtime || runtime.readOnly !== true || runtime.dryRun === true) throw new Error("read-only live mode needs a runtime that declares itself read-only and is not a simulation");
    } else throw new Error("live execution is not authorised: modes are dry-run and read-only-live only");
    this.mode = policy.mode;
    this.catalog = catalog; this.byName = new Map(catalog.map((t) => [t.name, t])); this.runtime = runtime;
    this.attachments = Array.isArray(policy.attachments) ? policy.attachments : []; this.grants = new Set(policy.grants || []); this.approve = policy.approve || null; this.maxParallel = policy.maxParallel || 4; this.timeoutCapMs = policy.timeoutCapMs || 0; this.backoffScale = policy.backoffScale == null ? 1 : policy.backoffScale;
    this.audit = audit || new AuditLog(); this.ledger = ledger || new Map(); this.abort = new AbortController();
  }
  cancel() { this.abort.abort(); }
  async log(ev) { return this.audit.append(ev); }

  // res: the output of validatePlan ({ valid, plan }). Returns the full outcome.
  async execute(res) {
    if (!res || !res.plan) throw new Error("no plan to execute");
    if (res.valid === false) { await this.log({ event: "refused", detail: "the plan is not valid", issues: res.issues || [] }); return this.finish(res.plan, {}, "refused"); }
    const plan = res.plan, planId = plan.audit && plan.audit.planId;
    if (plan.audit && plan.audit.executed !== false) { await this.log({ event: "refused", plan: planId, detail: "plan is already marked executed" }); return this.finish(plan, {}, "refused"); }
    await this.log({ event: "plan_started", plan: planId, mode: this.mode, tasks: plan.tasks.length, runtime: this.runtime.id });
    const results = {}, byId = new Map(plan.tasks.map((t) => [t.id, t]));
    for (const group of plan.execution_order) {
      const pool = []; let idx = 0;
      const worker = async () => { while (idx < group.length) { const id = group[idx++]; results[id] = await this.runTask(plan, byId.get(id), results); } };
      for (let i = 0; i < Math.min(this.maxParallel, group.length); i++) pool.push(worker());
      await Promise.all(pool);
    }
    return this.finish(plan, results);
  }

  async finish(plan, results, force) {
    const tasks = (plan.tasks || []).map((t) => Object.assign({ id: t.id, description: t.description }, results[t.id] || { status: "not_run", notes: ["the plan was refused or cancelled before this task"] }));
    const st = tasks.map((t) => t.status), done = st.filter((s) => s === "done").length;
    let state = force || (this.abort.signal.aborted ? "cancelled" : done === tasks.length ? "completed" : st.includes("awaiting_approval") && !st.includes("failed") ? "awaiting_approval" : done ? "partial" : "failed");
    await this.log({ event: "plan_finished", plan: plan.audit && plan.audit.planId, state, done, total: tasks.length });
    return { state, mode: this.mode, dry_run: this.mode === "dry-run", tasks, counts: { done, total: tasks.length }, side_effects: Array.isArray(this.runtime.touched) ? this.runtime.touched.length : 0, side_effect_report: typeof this.runtime.report === "function" ? this.runtime.report() : null, audit: { records: this.audit.records.length, chain: await this.audit.verify() } };
  }

  // Runs ONE task through every gate (the persistent runner calls this; execute() calls it for a whole plan). results: { key: { status, output } }.
  async runOne(plan, task, results) { return this.runTask(plan, task, results); }

  async runTask(plan, task, results) {
    const planId = plan.audit && plan.audit.planId, base = { plan: planId, task: task.id };
    if (this.abort.signal.aborted) return { status: "cancelled", notes: ["cancelled before start"] };
    if (task.status === "blocked") { await this.log(Object.assign({ event: "blocked", detail: (task.blocked_by || []).join("; ") }, base)); return { status: "blocked", notes: task.blocked_by || [] }; }
    for (const d of task.depends_on || []) { const r = results[d]; if (!r || r.status !== "done") { await this.log(Object.assign({ event: "skipped", detail: "dependency " + d + " did not complete (" + (r ? r.status : "not run") + ")" }, base)); return { status: r && r.status === "awaiting_approval" ? "awaiting_approval" : "skipped", notes: ["dependency " + d + " did not complete"] }; } }
    if (!task.tools || !task.tools.length) {
      // A reasoning or writing step needs no tool. The executor does not call a model: in a dry run it is simulated, and in live mode it is handed back to Noria's normal conversation, which does the writing.
      const live = this.mode !== "dry-run";
      await this.log(Object.assign({ event: live ? "model_step_deferred" : "model_step_simulated" }, base));
      return { status: "done", tool: null, notes: [live ? "reasoning or writing step: not executed here; Noria's conversation writes it" : "reasoning or writing step (simulated in dry-run)"], output: live ? { executed: false, handled_by: "noria-conversation" } : { simulated: true } };
    }
    const outs = [], notes = []; let attemptsTotal = 0;
    for (const name of task.tools) {
      const r = await this.runTool(plan, task, name, base);
      attemptsTotal += r.attempts || 0; notes.push(...(r.notes || []));
      if (!r.ok) return { status: r.status, tool: r.tool || name, attempts: attemptsTotal, notes, error: r.error };
      outs.push({ tool: r.tool, output: r.output, deduplicated: !!r.deduplicated });
    }
    return { status: "done", tool: outs.map((o) => o.tool).join("+"), attempts: attemptsTotal, output: outs.length === 1 ? outs[0].output : outs, deduplicated: outs.every((o) => o.deduplicated), notes };
  }

  async runTool(plan, task, name, base, triedAlt = new Set()) {
    const planId = base.plan, notes = [];
    const fail = async (status, error, extra = {}) => { await this.log(Object.assign({ event: status, tool: name, detail: error }, base)); return Object.assign({ ok: false, status, error, notes: [error], tool: name }, extra); };
    // 1 registry
    const tool = this.byName.get(name);
    if (!tool) return fail("denied", "unregistered tool \"" + name + "\": only registered tools may run");
    // 2 availability (a read-only tool whose health is unknown may be tried; a tool that acts may not)
    if (!canUse(tool)) return fail("blocked", name + " is " + tool.available);
    // 2b the read-only gate, ahead of everything that could grant permission: approval cannot override it
    if (this.mode === "read-only-live") { const g = readOnlyLiveGate(tool); if (!g.ok) return fail("denied", "not permitted in read-only live mode: " + g.reason); }
    // 3 input
    const input = buildInput(tool, task, { attachments: this.attachments, simulate: this.mode === "dry-run" }), verrs = validateInput(tool.input, input);
    if (verrs.length) return fail("failed", "invalid input: " + verrs.join("; ") + (tool.input && Object.values(tool.input).some((x) => x.type === "file") && !this.attachments.length && this.mode !== "dry-run" ? " (no file is attached)" : ""));
    // 4 permission and runtime
    if (tool.auth !== "none" && !this.grants.has(tool.auth)) return fail("needs_permission", "invalid permission: " + name + " needs \"" + tool.auth + "\" authorisation, which has not been granted");
    if (!this.runtime.supports(tool)) return fail("failed", "no runtime available for " + name + " (it runs in: " + tool.runtime.join(", ") + ")");
    // 5 idempotency (BEFORE approval: something that already ran, or may have run, is never re-approved or run again)
    const key = await keyOf([planId, task.id, name, JSON.stringify(input)].join("|"));
    const prior = await this.ledger.get(key), ctxL = { objectiveId: planId, taskKey: task.id, tool: name };
    if (prior && prior.started && tool.risk === "write") return fail("uncertain_outcome", "an earlier attempt at " + name + " started and did not record how it ended: it may already have happened, so it is not run again until a person confirms");
    if (prior && prior.ok) { await this.log(Object.assign({ event: "deduplicated", tool: name, key }, base)); return { ok: true, status: "done", tool: name, output: prior.output, deduplicated: true, attempts: 0, notes: ["already executed: not run again"] }; }
    // 6 risk and approval
    if (tool.risk === "write" || task.approval_required) {
      if (!this.approve) return Object.assign(await this.awaiting(name, base, "approval is required and no approver is configured"), { ok: false });
      const ap = await this.approve({ plan: planId, task: task.id, tool: name, risk: tool.risk, input });
      if (ap && ap.pending) return Object.assign(await this.awaiting(name, base, "waiting for approval"), { ok: false });
      await this.log(Object.assign({ event: ap && ap.approved ? "approved" : "approval_denied", tool: name, by: ap && ap.by || "unknown", reason: ap && ap.reason || "" }, base));
      if (!ap || !ap.approved) return { ok: false, status: "denied_by_user", tool: name, notes: ["approval was not given"], error: "approval was not given" };
    }
    // 7 to 10: execute, observe, verify, recover
    const maxAttempts = 1 + Math.min(2, (tool.retry && tool.retry.max) || 0);
    await this.ledger.set(key, { started: true }, ctxL); // written BEFORE the tool runs: if the runner dies now, the resume can tell
    let lastError = "", lastRetryable = false, attempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      if (this.abort.signal.aborted) return { ok: false, status: "cancelled", tool: name, attempts, notes: ["cancelled"] };
      const timeoutMs = this.timeoutCapMs ? Math.min(tool.timeoutMs, this.timeoutCapMs) : tool.timeoutMs;
      await this.log(Object.assign({ event: "attempt", tool: name, attempt, timeoutMs }, base));
      let r;
      try { r = await this.withLimits(this.runtime.run(task, tool, input, { signal: this.abort.signal, timeoutMs, attempt }), timeoutMs); }
      catch (e) {
        if (e && e.cancelled) { await this.log(Object.assign({ event: "cancelled", tool: name }, base)); return { ok: false, status: "cancelled", tool: name, attempts, notes: ["cancelled during execution"] }; }
        r = { ok: false, error: e && e.timeout ? "timed out after " + timeoutMs + " ms" : String((e && e.message) || e), retryable: true };
      }
      if (r.ok) {
        // 8 observe (tool output is data: instruction-like text is removed and reported)
        const found = []; const output = sanitizeOutput(r.output || {}, found);
        if (found.length) await this.log(Object.assign({ event: "injection_suspected", tool: name, removed: found.length, sample: found[0] }, base));
        // 9 verify
        const problem = (VERIFIERS[tool.verify] || VERIFIERS.schema)(tool, output);
        if (!problem) { await this.ledger.set(key, { ok: true, output }, ctxL); await this.log(Object.assign({ event: "completed", tool: name, attempts, verified: tool.verify }, base)); return { ok: true, status: "done", tool: name, output, attempts, notes: found.length ? ["instruction-like text in the tool result was removed"] : [] }; }
        await this.log(Object.assign({ event: "verification_failed", tool: name, method: tool.verify, detail: problem }, base));
        lastError = "verification failed: " + problem; lastRetryable = true;
      } else { lastError = r.error || "tool failed"; lastRetryable = r.retryable !== false; await this.log(Object.assign({ event: "tool_failed", tool: name, detail: lastError, retryable: lastRetryable }, base)); }
      // 10 recover
      const alts = (tool.alternatives || []).filter((a) => !triedAlt.has(a) && this.byName.has(a) && canUse(this.byName.get(a)));
      const dec = decideRecovery({ error: lastError, retryable: lastRetryable, attempt, maxAttempts, alternatives: alts });
      await this.log(Object.assign({ event: "recovery", tool: name, action: dec.action, why: dec.why }, base));
      if (dec.action === "retry") { await sleep(((tool.retry && tool.retry.backoffMs) || 0) * this.backoffScale, this.abort.signal).catch(() => {}); continue; }
      if (dec.action === "alternative") { triedAlt.add(name); const alt = await this.runTool(plan, task, dec.tool, base, triedAlt); alt.notes = ["used alternative " + dec.tool + " after " + name + " failed"].concat(alt.notes || []); alt.attempts = (alt.attempts || 0) + attempts; return alt; }
      break;
    }
    return { ok: false, status: "failed", tool: name, attempts, error: lastError, notes: [lastError] };
  }

  async awaiting(name, base, why) { await this.log(Object.assign({ event: "awaiting_approval", tool: name, detail: why }, base)); return { status: "awaiting_approval", tool: name, notes: [why], error: why }; }
  withLimits(promise, ms) { let timer; const t = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { timeout: true })), ms); }); return Promise.race([promise, t]).finally(() => clearTimeout(timer)); }
}
