// NORIA PLANNER — read-only.
//
// Turns an objective into an auditable plan. It DOES NOT execute anything. A model proposes the plan; this module then checks it
// against the tool registry and rewrites it into a safe, normalised form. Nothing the model says is trusted:
//   - unknown tools are dropped and reported as missing capabilities
//   - tools that are not usable right now (not built, unsupported, need authorisation) block their task, and every task that depends
//     on it, with the reason stated
//   - tools that change something outside Noria (risk "write") are never planned as runnable: they are "proposed only" and carry an
//     approval requirement
//   - dependencies are checked; a cycle makes the plan invalid; the execution order is computed from them, not taken from the model
//   - every plan carries an audit block that says it was not executed
//
// plan = {
//   objective, tasks: [{ id, description, tools, requires_info, depends_on, verification, status, blocked_by, approval_required }],
//   execution_order: [[ids that may run in parallel], …], verification_requirements, expected_result,
//   missing_capabilities: [{ tool, state, reason }], audit: { planId, createdAt, registryVersion, objectiveHash, mode: "plan-only", executed: false }
// }

import { canUse, REGISTRY_VERSION } from "./tools.js";

export function buildPlannerMessages(objective, catalog, todayISO) {
  const system =
    "You are the planning module of Noria, an AI assistant. You do NOT answer the person's objective and you do NOT execute anything. " +
    "You produce a PLAN as JSON only (no prose, no code fences).\n\n" +
    "Rules:\n" +
    "- Break the objective into at most 10 tasks. Each task: id (t1, t2, …), description (one clear sentence), tools (names taken ONLY from the TOOL CATALOG; use [] for a step that is only reasoning or writing), " +
    "requires_info (what must be known or found first), depends_on (ids of tasks that must finish first), verification (how the result will be checked), " +
    "inputs (for each tool the task uses, the exact input to give it, using the field names in that tool's \"takes\" list and only values that come from the objective; never invent a value).\n" +
    "- Prefer the MOST SPECIFIC tool whose description matches the task (for example a tool built for spreadsheets over a general reader plus a calculator). Use a tool only when the task needs it.\n" +
    "- Choose tools only from the catalog. If the objective needs a capability the catalog does not have, do not invent a tool: put it in missing_capabilities.\n" +
    "- Tools with risk \"write\" change something outside Noria (send, book, save, post). Include such a step only if the objective really asks for it.\n" +
    "- Independent tasks should not depend on each other, so they can run in parallel. Verification of important facts is a separate task or part of the task.\n" +
    "- Today is " + todayISO + ".\n\n" +
    "Return exactly this JSON shape:\n" +
    "{\"tasks\":[{\"id\":\"t1\",\"description\":\"\",\"tools\":[],\"requires_info\":[],\"depends_on\":[],\"verification\":[],\"inputs\":{\"tool.name\":{\"field\":\"value\"}}}],\"verification_requirements\":[],\"expected_result\":\"\",\"missing_capabilities\":[{\"need\":\"\",\"reason\":\"\"}]}\n\n" +
    "TOOL CATALOG:\n" + JSON.stringify(catalog.map((t) => ({ name: t.name, does: t.description, takes: t.input || [], state: t.state, risk: t.risk }))) ;
  return [{ role: "system", content: system }, { role: "user", content: "OBJECTIVE: " + String(objective || "").slice(0, 1200) }];
}

// First balanced JSON object in a model reply (tolerates code fences and stray words around it).
export function extractJson(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, i + 1)); } catch (_) { return null; } } }
  }
  return null;
}

// Words a model uses for "no tool, I just think or write": these are not tool names.
const NO_TOOL = /^(?:\[\]|none|null|n\/a|na|model|llm|reasoning|writing|write|think|thinking|noria|self|internal|manual|-|—)$/i;
const str = (x, n) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, n);
const list = (x, n, m) => (Array.isArray(x) ? x : []).map((v) => str(v, m)).filter(Boolean).slice(0, n);
const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };

// Levels of a dependency graph (Kahn). Returns null when there is a cycle.
export function executionLevels(ids, deps) {
  const indeg = new Map(ids.map((i) => [i, 0])), out = new Map(ids.map((i) => [i, []]));
  for (const i of ids) for (const d of deps[i] || []) { indeg.set(i, indeg.get(i) + 1); out.get(d).push(i); }
  let level = ids.filter((i) => indeg.get(i) === 0); const levels = []; let seen = 0;
  while (level.length) {
    levels.push(level); seen += level.length; const next = [];
    for (const i of level) for (const j of out.get(i)) { indeg.set(j, indeg.get(j) - 1); if (indeg.get(j) === 0) next.push(j); }
    level = next;
  }
  return seen === ids.length ? levels : null;
}

// raw: the model's parsed JSON. catalog: listTools(health) (with .available). Returns { valid, plan, issues }.
export function validatePlan(raw, objective, catalog, opts = {}) {
  const issues = [];
  const byName = new Map(catalog.map((t) => [t.name, t]));
  const missing = [], degraded = [];
  const addMissing = (tool, state, reason) => { if (!missing.some((m) => m.tool === tool && m.reason === reason)) missing.push({ tool, state, reason }); };
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.tasks) || !raw.tasks.length) {
    return { valid: false, plan: null, issues: ["the model did not return a usable list of tasks"] };
  }
  let tasks = raw.tasks.slice(0, 12).map((t, i) => ({ id: str((t && t.id) || "t" + (i + 1), 12).replace(/[^a-zA-Z0-9_-]/g, "") || "t" + (i + 1), description: str(t && t.description, 240), tools: list(t && t.tools, 6, 40), requires_info: list(t && t.requires_info, 6, 160), depends_on: list(t && t.depends_on, 8, 12), verification: list(t && t.verification, 5, 160) }));
  if (raw.tasks.length > 12) issues.push("more than 12 tasks: the extra ones were cut");
  // unique ids
  const used = new Set();
  tasks.forEach((t, i) => { let id = t.id, n = 2; while (used.has(id)) id = t.id + "_" + n++; if (id !== t.id) issues.push("duplicate task id " + t.id + " renamed " + id); t.id = id; used.add(id); });
  const ids = tasks.map((t) => t.id);
  // dependencies must point at other, existing tasks
  const deps = {};
  for (const t of tasks) {
    t.depends_on = [...new Set(t.depends_on.filter((d) => { const ok = d !== t.id && ids.includes(d); if (!ok) issues.push("task " + t.id + " depended on \"" + d + "\", which is not another task: ignored"); return ok; }))];
    deps[t.id] = t.depends_on;
  }
  // tools: registry check, availability, risk
  for (const t of tasks) {
    const usable = []; t.status = "ready"; t.blocked_by = []; t.approval_required = false;
    for (const name of t.tools.filter((n) => !NO_TOOL.test(String(n).trim()))) {
      const tool = byName.get(name);
      if (!tool) { issues.push("task " + t.id + " named an unknown tool \"" + name + "\": dropped"); addMissing(name, "not_in_registry", "the planner named a tool that does not exist"); t.blocked_by.push(name + " (unknown)"); continue; }
      if (!canUse(tool)) { addMissing(name, tool.available, tool.available === "requires_auth" ? "needs the person's authorisation" : tool.available === "unsupported" ? "not supported by policy or design" : "not built yet"); t.blocked_by.push(name + " (" + tool.available + ")"); continue; }
      if (tool.risk === "write") { t.approval_required = true; }
      if (tool.available === "unknown") { t.notes = (t.notes || []).concat(name + " has no recent health check: it will be tried and observed"); if (!degraded.includes(name)) degraded.push(name); }
      if (tool.available === "degraded") { t.notes = (t.notes || []).concat(name + " is degraded right now: expect fewer or weaker results"); if (!degraded.includes(name)) degraded.push(name); }
      usable.push(name);
    }
    t.tools = usable;
    // proposed inputs: only for tools the task really uses, plain values only (the executor still validates them against the tool's schema)
    const rawTask = raw.tasks.find((x, i) => x && (str(x.id, 12).replace(/[^a-zA-Z0-9_-]/g, "") || "t" + (i + 1)) === t.id) || {}, rawIn = rawTask.inputs;
    if (rawIn && typeof rawIn === "object") { t.input = {}; for (const n of usable) { const o = rawIn[n]; if (o && typeof o === "object" && !Array.isArray(o)) { const clean = {}; for (const [k, v] of Object.entries(o).slice(0, 8)) if (["string", "number", "boolean"].includes(typeof v)) clean[str(k, 40)] = typeof v === "string" ? str(v, 300) : v; if (Object.keys(clean).length) t.input[n] = clean; } } if (!Object.keys(t.input).length) delete t.input; }
    if (t.blocked_by.length) t.status = "blocked";
    else if (t.approval_required) t.status = "proposed_only"; // never runnable by the planner: it needs an explicit approval gate
    if (!t.verification.length) t.verification = [...new Set(t.tools.map((n) => byName.get(n).verify).filter((v) => v && v !== "schema" && v !== "user"))].map((v) => ({ sources: "answer must be supported by the sources", exact: "result is computed exactly", temporal: "dates in the result match the moment asked about", schema: "" , user: "" }[v])).filter(Boolean);
  }
  // capabilities the model itself said were missing
  for (const m of Array.isArray(raw.missing_capabilities) ? raw.missing_capabilities.slice(0, 8) : []) { const need = str(m && (m.need || m.tool), 80); if (need && !NO_TOOL.test(need)) addMissing(need, "not_built", str(m && m.reason, 160) || "reported by the planner"); }
  // a task that depends on a blocked one is blocked too
  let changed = true;
  while (changed) { changed = false; for (const t of tasks) { if (t.status === "blocked") continue; const b = t.depends_on.filter((d) => tasks.find((x) => x.id === d).status === "blocked"); if (b.length) { t.status = "blocked"; t.blocked_by.push("depends on blocked " + b.join(", ")); changed = true; } } }
  const levels = executionLevels(ids, deps);
  let valid = true;
  if (!levels) { valid = false; issues.push("the dependencies contain a cycle, so no execution order exists"); }
  // parallel only when it is safe: a level's read-only ready tasks together; anything that proposes a write stands alone
  let order = [];
  if (levels) for (const lv of levels) {
    const safe = lv.filter((id) => { const t = tasks.find((x) => x.id === id); return t.status === "ready"; });
    const other = lv.filter((id) => !safe.includes(id));
    if (safe.length) order.push(safe);
    for (const id of other) order.push([id]);
  }
  const plan = {
    objective: str(objective, 1200),
    tasks,
    execution_order: order,
    verification_requirements: list(raw.verification_requirements, 8, 200),
    expected_result: str(raw.expected_result, 400),
    missing_capabilities: missing,
    degraded_tools: degraded,
    audit: { planId: "plan_" + hash(str(objective, 1200) + (opts.now || "")) + "_" + tasks.length, createdAt: opts.now || new Date().toISOString(), registryVersion: REGISTRY_VERSION, objectiveHash: hash(str(objective, 1200)), mode: "plan-only", executed: false },
  };
  if (!plan.verification_requirements.length) plan.verification_requirements = ["every factual claim must be supported by a retrieved source or an exact computation", "the dates in the result must match the moment asked about"];
  const ready = tasks.filter((t) => t.status === "ready").length;
  plan.summary = { tasks: tasks.length, ready, blocked: tasks.filter((t) => t.status === "blocked").length, proposed_only: tasks.filter((t) => t.status === "proposed_only").length, parallel_groups: order.filter((g) => g.length > 1).length };
  return { valid, plan, issues };
}
