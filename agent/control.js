// NORIA CONTROL LOOP — what turns a persistent task graph into adaptive work.
//
//   EXECUTE -> OBSERVE -> VERIFY -> LEARN -> REVISE -> CONTINUE
//
// After each run the controller looks at what happened and chooses, for each problem, between clearly different responses:
//   RETRY     the same task, the same plan, another go. For transient trouble. Bounded by the objective's policy.
//   REPLAN    change the plan: replace what failed, re-point what depended on it. For a plan that is not sufficient. Bounded, validated,
//             and never allowed to touch finished work or to repeat a step that already failed.
//   SUPERSEDE new information invalidated finished work: give it (and what depends on it) a newer version, and keep the old outputs as history.
//   ASK       a permission, an approval, a denial, an unknown outcome: a person decides. The controller never routes around them.
//   STOP      nothing sensible is left: it says why, and the reason is on the record.
// The model only PROPOSES a revision. This module validates it against the tool registry, the graph, the failure history and the budgets.

import { extractJson } from "./planner.js";
import { canUse } from "./tools.js";
import { stableJson, checkRevision, refTaskKeys, LIMITS } from "./graph.js";

// ── 1. what kind of failure is it, and what should be done? ──────────────────────────────────────────────────────────
const TRANSIENT = /timed out|timeout|network|blip|rate limit|429|\b5\d\d\b|temporar|unavailable|overloaded|provider (?:down|failed)|connection|reset by peer/i;
const INPUT = /invalid input|missing required|cannot resolve|could not be resolved|not a plain calculation|not a question the clock|no such|not found|no (?:weather|exchange|price)|unregistered/i;
const VERIFICATION = /verification[ _]failed/i;
// code.run failures (agent/code-exec.js codes): running the same code again cannot change a deterministic failure, so the approach must change
const CODE_FAIL = /\b(?:code_error|timeout|no_code|too_large|bad_input|bad_request|unsupported_language):/i, CODE_BOUNDARY = /\boutside_boundary:/i, CODE_NO_RUNTIME = /\bno_runtime:/i;
// task: { state, error, retries, tools, verification (last verification result) }. Returns { kind, action, why }.
export function classifyFailure(task, policy) {
  const err = String(task.error || ""), retries = task.retries || 0, maxRetries = policy.max_retries == null ? 2 : policy.max_retries;
  if (["awaiting_approval", "needs_permission", "denied", "uncertain"].includes(task.state)) return { kind: "authority", action: "ask", why: "this needs a person's decision (" + task.state + "); it is never routed around" };
  if (task.state === "blocked") return { kind: "capability", action: "replan", why: "a tool it needs is not available" };
  if (CODE_BOUNDARY.test(err)) return { kind: "authority", action: "ask", why: "the code asked for something outside the sealed sandbox boundary; a person decides (it is never routed around)" };
  if (CODE_NO_RUNTIME.test(err)) return { kind: "capability", action: "replan", why: "no execution runtime is available for that language" };
  if (/permission|not authori[sz]ed|read-only live mode|acting tools/i.test(err)) return { kind: "authority", action: "ask", why: "the gate refused it; a person decides" };
  if (VERIFICATION.test(err) || (task.verification && task.verification.ok === false)) return { kind: "verification", action: "replan", why: "the result could not be verified, so the approach must change" };
  if (CODE_FAIL.test(err)) return { kind: "code", action: "replan", why: "the code failed in the sandbox (" + err.slice(0, 80).replace(/\s+/g, " ") + "); running it again would fail the same way, so the code or approach must change" };
  if (INPUT.test(err)) return { kind: "input", action: "replan", why: "the step cannot work as specified; retrying the same thing would fail the same way" };
  if (TRANSIENT.test(err)) return retries < maxRetries ? { kind: "transient", action: "retry", why: "a temporary problem; attempt " + (retries + 1) + " of " + maxRetries } : { kind: "transient", action: "replan", why: "it kept failing after " + retries + " retries" };
  return retries < 1 ? { kind: "unknown", action: "retry", why: "unrecognised failure; one more try before changing the plan" } : { kind: "unknown", action: "replan", why: "it failed again after a retry" };
}

// ── 2. asking a model for a revision, and refusing what is not sound ────────────────────────────────────────────────
export function buildReplanMessages(state, catalog, todayISO) {
  const system =
    "You are the re-planning module of Noria. A task graph is partly done and something needs to change. You do NOT do the work and you do NOT answer the person; " +
    "you PROPOSE a revision to the graph as JSON only (no prose, no code fences).\n\n" +
    "Rules:\n" +
    "- Finished tasks (state done) and their results are never changed. Build on them: a new task may use their output as {{tKEY.output.field}}.\n" +
    "- Replace the task named in TRIGGER: put its key in remove, and describe the replacement in add. Anything that depended on the removed task must be re-pointed in repoint (task key: list of task keys it should now depend on).\n" +
    "- A new task may set \"replaces\" to the key it replaces (it must also be in remove): later references to the old task then read the new task's output, so dependent tasks need not be rewritten (still re-point their dependencies).\n" +
    "- Do NOT repeat a step that already failed (same tool with the same input). Change the approach: a different tool, a different input, more or fewer steps. Use the lessons and the verification results to decide.\n" +
    "- Use only tools from the TOOL CATALOG, only values that come from the objective, the results so far or memory; never invent a value. Give each new task its exact inputs.\n" +
    "- Never propose anything to get around a refusal, a missing permission or an approval. If the only way forward needs a person, set ask_user to the question to ask.\n" +
    "- If there is no sensible way forward, set give_up to a short honest reason.\n" +
    "- Keep it small: usually one to three new tasks.\n- Today is " + todayISO + ".\n\n" +
    "Return exactly this JSON shape:\n" +
    "{\"reason\":\"why the plan is changing\",\"invalidated_assumptions\":[],\"remove\":[],\"add\":[{\"key\":\"t9\",\"description\":\"\",\"tools\":[],\"inputs\":{\"tool.name\":{\"field\":\"value\"}},\"depends_on\":[],\"verification\":[],\"remember\":{}}],\"repoint\":{},\"ask_user\":\"\",\"give_up\":\"\"}\n\n" +
    "TOOL CATALOG:\n" + JSON.stringify(catalog.map((t) => ({ name: t.name, does: t.description, takes: t.input || [], state: t.state, risk: t.risk })));
  return [{ role: "system", content: system }, { role: "user", content: "CURRENT STATE:\n" + JSON.stringify(state).slice(0, 12000) }];
}
export function parseProposal(text) { return typeof text === "object" && text !== null ? text : extractJson(text); }

const sig = (tools, inputs) => (tools || []).slice().sort().join("+") + "|" + stableJson(inputs || {});
const str = (x, n) => String(x == null ? "" : x).replace(/\s+/g, " ").trim().slice(0, n);
// Inputs of a proposed task are cleaned the same way the planner cleans a plan's: the TOOL'S OWN schema says how much a field may hold (code and data are long
// and keep their line breaks; a field declared as an object may hold a small JSON object).
const cleanInputs = (o, tools, catalog = []) => {
  const out = {};
  if (o && typeof o === "object") for (const t of tools) {
    const v = o[t], schema = (catalog.find((x) => x.name === t) || {}).input || {};
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const c = {};
      for (const [k, x] of Object.entries(v).slice(0, 8)) {
        const spec = schema[k] || {}, cap = spec.maxChars || 4000;
        if (typeof x === "string") c[str(k, 40)] = spec.multiline ? String(x).replace(/\r/g, "").slice(0, cap) : str(x, cap);
        else if (typeof x === "number" || typeof x === "boolean") c[str(k, 40)] = x;
        else if (spec.type === "object" && x && typeof x === "object" && !Array.isArray(x)) { let js = ""; try { js = JSON.stringify(x); } catch (_) {} if (js && js.length <= cap) c[str(k, 40)] = JSON.parse(js); }
      }
      if (Object.keys(c).length) out[t] = c;
    }
  }
  return out;
};

// ctx: { tasks (from store.tasks), catalog (with .available), policy, revisionsUsed, trigger: { key, ... } }
// Returns { ok, decision: "revise" | "ask" | "give_up", revision, reason, question, problems }.
export function validateProposal(raw, ctx) {
  const problems = [];
  if (!raw || typeof raw !== "object") return { ok: false, decision: "refused", problems: ["the proposal is not usable (no JSON object)"] };
  if (raw.give_up && String(raw.give_up).trim()) return { ok: true, decision: "give_up", reason: str(raw.give_up, 400), problems: [] };
  if (raw.ask_user && String(raw.ask_user).trim()) return { ok: true, decision: "ask", question: str(raw.ask_user, 400), reason: str(raw.reason, 400), problems: [] };
  const { tasks, catalog, policy, trigger } = ctx, byKey = Object.fromEntries(tasks.map((t) => [t.key, t])), byTool = Object.fromEntries(catalog.map((t) => [t.name, t]));
  const maxRev = policy.max_revisions == null ? 3 : policy.max_revisions;
  if ((ctx.revisionsUsed || 0) >= maxRev) return { ok: false, decision: "refused", problems: ["the objective has used its revision budget (" + maxRev + ")"] };
  const remove = [...new Set((Array.isArray(raw.remove) ? raw.remove : []).map((k) => str(k, 40)).filter(Boolean))];
  for (const k of remove) {
    const t = byKey[k];
    if (!t) problems.push("cannot remove " + k + ": no such task");
    else if (["done", "running", "superseded", "removed"].includes(t.state)) problems.push("cannot remove " + k + ": it is " + t.state + " (finished or running work is never changed)");
    else if (["denied", "awaiting_approval", "needs_permission", "uncertain"].includes(t.state)) problems.push("cannot remove " + k + ": it is " + t.state + ", which a person must decide");
  }
  // steps that already failed (the same tool with the same input) must not come back
  const failedSigs = new Set(tasks.filter((t) => ["failed", "superseded", "removed", "skipped"].includes(t.state) && t.error && !TRANSIENT.test(String(t.error))).map((t) => sig(t.tools, t.input)));
  const add = [], usedKeys = new Set(tasks.map((t) => t.key));
  for (const a of (Array.isArray(raw.add) ? raw.add : []).slice(0, 8)) {
    const key = str(a && a.key, 40).replace(/[^a-zA-Z0-9_~-]/g, "");
    if (!key || usedKeys.has(key)) { problems.push("new task key \"" + key + "\" is empty or already used"); continue; }
    usedKeys.add(key);
    const tools = (Array.isArray(a.tools) ? a.tools : []).map((x) => str(x, 40)).filter((x) => !/^(?:\[\]|none|model|reasoning|writing)$/i.test(x));
    let approval = false;
    for (const name of tools) {
      const tool = byTool[name];
      if (!tool) problems.push(key + " names a tool that does not exist: " + name);
      else if (!canUse(tool)) problems.push(key + " needs " + name + ", which is " + tool.available);
      else if (tool.risk === "write") approval = true; // a step that acts is proposed only; it will wait for approval
    }
    const inputs = cleanInputs(a.inputs, tools, catalog);
    if (tools.length && failedSigs.has(sig(tools, inputs))) problems.push(key + " repeats a step that already failed (" + tools.join("+") + " with the same input)");
    add.push({ key, replaces: a.replaces && remove.includes(str(a.replaces, 40)) ? str(a.replaces, 40) : undefined, description: str(a.description, 240), tools, input: inputs, depends_on: (Array.isArray(a.depends_on) ? a.depends_on : []).map((x) => str(x, 40)), verification: (Array.isArray(a.verification) ? a.verification : []).map((x) => str(x, 160)).slice(0, 5), approval_required: approval, remember: a.remember && typeof a.remember === "object" ? Object.fromEntries(Object.entries(a.remember).filter(([k, v]) => /^[a-z0-9_.-]{1,60}$/i.test(k) && typeof v === "string").slice(0, 5)) : undefined });
  }
  const repoint = {};
  if (raw.repoint && typeof raw.repoint === "object") for (const [k, v] of Object.entries(raw.repoint).slice(0, 20)) if (Array.isArray(v)) repoint[str(k, 40)] = [...new Set(v.map((x) => str(x, 40)))];
  if (!remove.length && !add.length && !Object.keys(repoint).length) problems.push("the proposal changes nothing");
  if (trigger && trigger.key && !remove.includes(trigger.key) && byKey[trigger.key] && !["superseded", "removed"].includes(byKey[trigger.key].state)) problems.push("the proposal does not deal with " + trigger.key + " (remove it and replace it)");
  if (tasks.filter((t) => !["removed", "superseded"].includes(t.state)).length - remove.length + add.length > LIMITS.tasks) problems.push("that would exceed " + LIMITS.tasks + " tasks");
  const revision = { add, remove, repoint };
  if (!problems.length) { const chk = checkRevision(tasks, revision); if (!chk.ok) problems.push(...chk.problems); }
  return problems.length ? { ok: false, decision: "refused", problems } : { ok: true, decision: "revise", revision, reason: str(raw.reason, 500), assumptions: (Array.isArray(raw.invalidated_assumptions) ? raw.invalidated_assumptions : []).map((x) => str(x, 200)).slice(0, 5), problems: [] };
}

// A replanner is anything with propose(state, catalog) -> proposal (object or text). This one asks a model through `complete(messages) -> text`.
export function modelReplanner(complete, catalog) {
  return { async propose(state) { const text = await complete(buildReplanMessages(state, catalog, new Date().toISOString().slice(0, 10)), state); return parseProposal(text); } };
}

// The browser side of the same thing: asks the site's Pro-gated /brain/replan route for a proposal. Validation still happens in the caller.
export function httpReplanner(base, proCode, fetchFn = fetch) {
  return { async propose(state) {
    const r = await fetchFn(base + "/brain/replan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pro: proCode, state }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "replan request failed (" + r.status + ")");
    return j.proposal;
  } };
}

// ── 3. the controller: run, observe, decide, continue ─────────────────────────────────────────────────────────────────
export class Controller {
  // runner: a GraphRunner. replanner: { propose(state) }. catalog: listTools(health).
  constructor({ store, runner, replanner, catalog }) { this.store = store; this.runner = runner; this.replanner = replanner; this.catalog = catalog; }
  async run(objectiveId, { maxIterations } = {}) {
    const store = this.store, log = { iterations: 0, retries: 0, revisions: 0, superseded: 0, asked: [], stopped: [], refused: [], paused: false, actions: [] };
    let policy = await store.getPolicy(objectiveId); const limit = maxIterations || policy.max_iterations;
    for (let it = 0; it < limit; it++) {
      log.iterations++;
      await this.runner.run(objectiveId);
      const [obj, stale, pol0, tasks0] = await store.batch([{ op: "getObjective", args: [objectiveId] }, { op: "staleCheck", args: [objectiveId] }, { op: "getPolicy", args: [objectiveId] }, { op: "tasks", args: [objectiveId] }]), project = obj.project_id; // one request
      if (obj.status === "paused") { log.paused = true; break; }
      if (obj.status === "cancelled") break;
      let changed = false;
      // OBSERVE: has anything the finished work relied on changed?
      if (stale.length) {
        const res = await store.supersedeMany(objectiveId, stale.map((s) => s.key), { reason: "inputs changed: " + [...new Set(stale.flatMap((s) => s.changed))].join(", ") });
        if (res.replaced.length) { changed = true; log.superseded += res.replaced.length; log.actions.push({ action: "supersede", tasks: res.replaced }); }
        for (const h of res.held) log.asked.push({ task: h, why: "changed inputs, but it acts outside Noria: a person decides whether to repeat it" });
      }
      // DECIDE for each problem: retry, replan, ask or stop
      policy = pol0;
      for (const t of (stale.length ? await store.tasks(objectiveId) : tasks0).filter((x) => ["failed", "blocked", "awaiting_approval", "needs_permission", "denied", "uncertain"].includes(x.state) && !x.stale)) {
        const c = classifyFailure(t, policy);
        if (c.action === "ask") { if (!log.asked.some((a) => a.task === t.key)) log.asked.push({ task: t.key, why: c.why }); continue; }
        if (c.action === "retry") { if (await store.retryTask(objectiveId, t.key, { reason: c.why })) { changed = true; log.retries++; log.actions.push({ action: "retry", task: t.key, why: c.why }); } continue; }
        // REPLAN: at most one per pass, then run again to see whether it worked
        if (changed && log.actions.some((a) => a.action === "replan")) continue;
        const out = await this.replan(objectiveId, project, t, c);
        log.actions.push({ action: "replan", task: t.key, applied: out.applied, why: out.why });
        if (out.applied) { changed = true; log.revisions++; } else if (out.ask) log.asked.push({ task: t.key, why: out.ask }); else log.refused.push({ task: t.key, why: out.why });
      }
      if (!changed) break;
    }
    log.state = await store.syncObjectiveState(objectiveId);
    return log;
  }

  async replan(objectiveId, projectId, failed, c) {
    const store = this.store, policy = await store.getPolicy(objectiveId), obj = await store.getObjective(objectiveId);
    const decide = async (text, kind, data) => { await store.addDecision(projectId, { objectiveId, taskKey: failed.key, decision: text, rationale: c.why, madeBy: "noria" }); await store.appendEvent(projectId, { kind, objectiveId, taskKey: failed.key, data }); };
    if (obj.revision_count >= policy.max_revisions) { await decide("stopped replanning " + failed.key + ": revision budget used (" + policy.max_revisions + ")", "replan_refused", { why: "budget" }); return { applied: false, why: "the revision budget is used" }; }
    const state = await store.revisionState(objectiveId); state.trigger = { key: failed.key, kind: c.kind, why: c.why, error: failed.error, verification: failed.last_verification };
    let raw; try { raw = await this.replanner.propose(state); } catch (e) { await decide("could not get a revision for " + failed.key, "replan_refused", { error: String(e.message).slice(0, 120) }); return { applied: false, why: "the re-planner did not answer: " + String(e.message).slice(0, 80) }; }
    const v = validateProposal(raw, { tasks: await store.tasks(objectiveId), catalog: this.catalog, policy, revisionsUsed: obj.revision_count, trigger: { key: failed.key } });
    if (v.decision === "ask") { await decide("needs a person: " + v.question, "replan_needs_person", { question: v.question }); return { applied: false, ask: v.question, why: v.question }; }
    if (v.decision === "give_up") { await decide("gave up on " + failed.key + ": " + v.reason, "replan_gave_up", { reason: v.reason }); return { applied: false, why: v.reason }; }
    if (!v.ok) { await decide("refused a revision for " + failed.key + ": " + v.problems.join("; ").slice(0, 300), "replan_refused", { problems: v.problems }); return { applied: false, why: v.problems.join("; ") }; }
    const res = await store.reviseGraph(objectiveId, v.revision, { reason: v.reason + (v.assumptions.length ? " (assumptions no longer held: " + v.assumptions.join("; ") + ")" : ""), by: "noria" });
    if (!res.ok) { await decide("could not apply the revision for " + failed.key, "replan_refused", { problems: res.problems }); return { applied: false, why: res.problems.join("; ") }; }
    await store.appendEvent(projectId, { kind: "replan_decided", objectiveId, taskKey: failed.key, data: { kind: c.kind, version: res.version, removed: v.revision.remove, added: v.revision.add.map((a) => a.key) } });
    return { applied: true, version: res.version, why: v.reason };
  }
}
