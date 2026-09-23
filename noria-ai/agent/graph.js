// NORIA TASK GRAPH — the pure model (no storage, no network).
//
// An OBJECTIVE becomes a TASK GRAPH: tasks, the dependencies between them, the input each task gets, and the state each task is in.
// This module defines the vocabulary the persistent store and the runner share: the state machine, how one task's output flows into
// another task's input, how a graph is created from a validated plan, and the rules for revising a graph while work is under way.
// It is not limited to read-only work: risk, approval and authority are properties of the tools, enforced by the executor.

import { executionLevels } from "./planner.js";

// ── states ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const TASK_STATES = ["pending", "ready", "running", "done", "failed", "blocked", "awaiting_approval", "needs_permission", "denied", "uncertain", "skipped", "cancelled", "removed", "superseded"];
export const OBJECTIVE_STATES = ["draft", "planned", "running", "awaiting_user", "paused", "completed", "partial", "failed", "cancelled"];
export const PROJECT_STATES = ["active", "archived"];

// A task moves only along these edges. Anything else is refused, so a bug or a race cannot quietly move work backwards.
export const TRANSITIONS = {
  pending: ["ready", "blocked", "skipped", "cancelled", "removed"],
  ready: ["running", "skipped", "cancelled", "removed"],
  running: ["done", "failed", "ready", "awaiting_approval", "needs_permission", "denied", "blocked", "uncertain", "cancelled"],
  awaiting_approval: ["ready", "denied", "cancelled", "removed"],
  needs_permission: ["ready", "cancelled", "removed"],
  failed: ["ready", "removed", "superseded"],
  denied: ["ready", "removed"],
  blocked: ["ready", "removed"],
  uncertain: ["ready", "done", "failed", "removed"],
  skipped: ["pending", "removed", "superseded"],
  done: ["superseded"], // finished work is never rewritten; it can only be replaced by a newer version, and the old output is kept as history
  superseded: [],
  cancelled: [],
  removed: [],
};
export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);
// terminal for scheduling: no further work will happen on this task unless the graph is revised or the person acts
export const TERMINAL_OK = new Set(["done"]);
export const TERMINAL_STOP = new Set(["failed", "blocked", "denied", "skipped", "cancelled", "removed", "superseded"]); // a dependent of one of these cannot run
export const WAITING = new Set(["awaiting_approval", "needs_permission", "uncertain"]);       // need the person or an outside change
export const ACTIVE = new Set(["pending", "ready", "running"]);

// ── ids and keys ───────────────────────────────────────────────────────────────────────────────────────────────────
export function newId(prefix) {
  const b = new Uint8Array(9); crypto.getRandomValues(b);
  return prefix + "_" + [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 12);
}
export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// The idempotency key of one step: the same objective, task, tool and (resolved) input is the same step, whoever runs it and whenever.
export async function stepKey(objectiveId, taskKey, tool, input) {
  return (await sha256([objectiveId, taskKey, tool, stableJson(input)].join("|"))).slice(0, 32);
}
export function stableJson(v) {
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableJson(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}

// ── data flow: one task's output becomes another task's input ─────────────────────────────────────────────────────
// A reference is written {{t1.output.value}}, {{t2.output.sources[0].title}}, {{memory.key}} or {{artifact.name}}. A whole-string reference keeps
// its type (a number stays a number); inside a longer string it is inserted as text. A reference that cannot be resolved is an ERROR:
// nothing is ever silently replaced by an empty value.
const REF = /\{\{\s*([^{}]+?)\s*\}\}/g;
export function collectRefs(value, out = []) {
  if (typeof value === "string") { for (const m of value.matchAll(REF)) out.push(m[1]); }
  else if (Array.isArray(value)) value.forEach((v) => collectRefs(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectRefs(v, out));
  return out;
}
export function refTaskKeys(value) { return [...new Set(collectRefs(value).map((r) => /^([A-Za-z0-9_-]+)\.output\b/.exec(r)).filter(Boolean).map((m) => m[1]))]; }
function walk(obj, path) {
  const parts = String(path).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) { if (cur === null || cur === undefined || typeof cur !== "object" || !(p in cur)) return { ok: false }; cur = cur[p]; }
  return { ok: true, value: cur };
}
// ctx: { results: { t1: { output } }, memory: { key: value }, artifacts: { name: content } }
export function resolveRefs(value, ctx) {
  const errors = [];
  const one = (ref) => {
    const r = ref.trim();
    let res;
    if (r.startsWith("memory.")) res = ctx.memory && r.slice(7) in ctx.memory ? { ok: true, value: ctx.memory[r.slice(7)] } : { ok: false };
    else if (r.startsWith("artifact.")) res = ctx.artifacts && r.slice(9) in ctx.artifacts ? { ok: true, value: ctx.artifacts[r.slice(9)] } : { ok: false };
    else { const m = /^([A-Za-z0-9_-]+)\.(.+)$/.exec(r); res = m && ctx.results && ctx.results[m[1]] ? walk(ctx.results[m[1]], m[2]) : { ok: false }; }
    if (!res.ok) errors.push("cannot resolve {{" + r + "}}");
    return res;
  };
  const go = (v) => {
    if (typeof v === "string") {
      const whole = /^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$/.exec(v);
      if (whole) { const r = one(whole[1]); return r.ok ? r.value : v; }
      return v.replace(REF, (all, ref) => { const r = one(ref); return r.ok ? (typeof r.value === "object" ? JSON.stringify(r.value) : String(r.value)) : all; });
    }
    if (Array.isArray(v)) return v.map(go);
    if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = go(x); return o; }
    return v;
  };
  const resolved = go(value);
  return { value: resolved, errors: [...new Set(errors)] };
}

// ── creating a graph from a validated plan ─────────────────────────────────────────────────────────────────────────
export const DEFAULT_POLICY = { max_revisions: 3, max_retries: 2, max_iterations: 6, session_max_tasks: 40, background: false };
export const LIMITS = { tasks: 60, artifactBytes: 200000, memoryValueBytes: 20000, memoryKeys: 500, textBytes: 4000 };
// planResult: the output of validatePlan ({ valid, plan }). Returns { ok, tasks, problems }; a task's initial state follows from the plan.
export function graphFromPlan(planResult) {
  const problems = [];
  if (!planResult || !planResult.plan) return { ok: false, tasks: [], problems: ["there is no plan"] };
  if (planResult.valid === false) return { ok: false, tasks: [], problems: ["the plan is not valid (" + (planResult.issues || []).join("; ") + ")"] };
  const plan = planResult.plan;
  if (plan.tasks.length > LIMITS.tasks) problems.push("more than " + LIMITS.tasks + " tasks");
  const keys = new Set(plan.tasks.map((t) => t.id));
  const tasks = plan.tasks.map((t) => {
    const refs = refTaskKeys(t.input || {});
    for (const r of refs) if (!keys.has(r)) problems.push(t.id + " refers to a task that does not exist: " + r);
    const depends_on = [...new Set([...(t.depends_on || []), ...refs.filter((r) => r !== t.id)])]; // data flow implies dependency
    if (refs.includes(t.id)) problems.push(t.id + " refers to its own output");
    return { key: t.id, description: t.description, tools: t.tools || [], input: t.input || {}, depends_on, verification: t.verification || [], approval_required: !!t.approval_required, plan_status: t.status, blocked_by: t.blocked_by || [], remember: t.remember || null };
  });
  const levels = executionLevels(tasks.map((t) => t.key), Object.fromEntries(tasks.map((t) => [t.key, t.depends_on])));
  if (!levels && !problems.length) problems.push("the dependencies contain a cycle");
  for (const t of tasks) t.state = t.plan_status === "blocked" ? "blocked" : t.depends_on.length ? "pending" : "ready";
  return { ok: problems.length === 0, tasks, problems };
}

// ── revising a graph while it runs ─────────────────────────────────────────────────────────────────────────────────
// Work that is finished or running is never rewritten. A revision may add tasks, remove tasks that have not started, and replace a failed
// or blocked one; the new graph must still be acyclic and every dependency must exist.
// current: [{ key, state, depends_on }]; revision: { add: [{ key, description, tools, input, depends_on }], remove: [keys], repoint: { key: [new dependencies] } }
export function checkRevision(current, revision) {
  const problems = [], byKey = new Map(current.map((t) => [t.key, t]));
  const remove = new Set(revision.remove || []);
  for (const k of remove) {
    const t = byKey.get(k);
    if (!t) problems.push("cannot remove " + k + ": no such task");
    else if (["running", "done", "removed"].includes(t.state)) problems.push("cannot remove " + k + ": it is " + t.state);
  }
  const add = revision.add || [];
  for (const a of add) if (byKey.has(a.key) && !remove.has(a.key)) problems.push("cannot add " + a.key + ": that key already exists");
  const finalKeys = new Set([...byKey.keys()].filter((k) => !remove.has(k) && byKey.get(k).state !== "removed")); for (const a of add) finalKeys.add(a.key);
  const deps = {}, repoint = revision.repoint || {};
  for (const [k, ds] of Object.entries(repoint)) { if (!finalKeys.has(k)) problems.push("cannot re-point " + k + ": it is not in the graph"); for (const d of ds) if (!finalKeys.has(d)) problems.push("re-pointing " + k + " to " + d + ", which is not in the graph"); }
  for (const t of current) if (finalKeys.has(t.key)) deps[t.key] = (repoint[t.key] || t.depends_on).filter((d) => finalKeys.has(d) || (byKey.get(d) && byKey.get(d).state === "done"));
  for (const a of add) { const d = [...new Set([...(a.depends_on || []), ...refTaskKeys(a.input || {})])]; for (const x of d) if (!finalKeys.has(x)) problems.push(a.key + " depends on " + x + ", which is not in the graph"); deps[a.key] = d.filter((x) => finalKeys.has(x)); }
  for (const t of current) if (finalKeys.has(t.key) && !repoint[t.key]) for (const d of t.depends_on) if (remove.has(d)) problems.push(t.key + " depends on " + d + ", which the revision removes (replace or re-point it)");
  if (finalKeys.size > LIMITS.tasks) problems.push("more than " + LIMITS.tasks + " tasks");
  if (!problems.length && !executionLevels([...finalKeys], deps)) problems.push("the revised graph contains a cycle");
  return { ok: problems.length === 0, problems };
}

// What state should an objective be in, given its tasks?
export function objectiveStateFrom(taskStates) {
  const s = taskStates.filter((x) => x !== "removed" && x !== "superseded");
  if (!s.length) return "draft";
  if (s.every((x) => x === "done")) return "completed";
  if (s.some((x) => x === "running")) return "running";
  if (s.some((x) => x === "ready")) return "running";
  if (s.some((x) => WAITING.has(x))) return "awaiting_user";
  if (s.some((x) => x === "pending")) return "running"; // waiting on tasks that are themselves progressing (the runner promotes them)
  const done = s.filter((x) => x === "done").length;
  if (s.every((x) => x === "cancelled")) return "cancelled";
  return done ? "partial" : "failed";
}

// The fingerprint of what a reference reads right now. Pure (no store needed), so callers compute it locally instead of asking the server.
export async function refHash(ref, ctx) {
  const r = resolveRefs("{{" + ref + "}}", ctx);
  return r.errors.length ? "missing" : (await sha256(stableJson(r.value))).slice(0, 24);
}
