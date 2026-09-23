// NORIA BACKGROUND CONTINUATION — the path by which a long objective could continue without the screen open. SHIPPED SWITCHED OFF.
//
// The pieces exist: objectives can carry a schedule (when to look again), the runner can resume from stored state, the controller can
// revise, and every run is bounded and audited. What does NOT exist: authority. Nothing runs in the background until the owner authorises it,
// and even then only objectives that individually opted in (policy.background), only through read-only live execution, only within their
// budgets. A tick per signed-in user is meant to be called by a scheduled job (the accounts worker already has a 10-minute cron); today no
// scheduled job calls it.

import { Controller } from "./control.js";

export const BACKGROUND_EXECUTION_AUTHORISED = false;

// What is due, for this user, and would it be allowed to run? Runs nothing.
export async function planTick(store, nowMs = store.now()) {
  const out = [];
  for (const d of await store.dueObjectives(nowMs)) {
    const policy = await store.getPolicy(d.objective_id);
    out.push({ objective: d.objective_id, project: d.project_id, next_run_at: d.next_run_at, interval_seconds: d.interval_seconds, reason: d.reason, opted_in: policy.background === true, would_run: policy.background === true && BACKGROUND_EXECUTION_AUTHORISED });
  }
  return out;
}

// The tick a scheduled job would call. Without authority it records that it declined, and does nothing else.
export async function runTick(store, deps, { nowMs } = {}) {
  const plan = await planTick(store, nowMs);
  if (!BACKGROUND_EXECUTION_AUTHORISED) {
    for (const p of plan) await store.appendEvent(p.project, { kind: "background_skipped", objectiveId: p.objective, data: { reason: "background execution is not authorised" } });
    return { authorised: false, ran: [], skipped: plan.map((p) => ({ objective: p.objective, reason: "background execution is not authorised" })) };
  }
  return await runDue(store, deps, plan, nowMs);
}

// The future path, and the test hook: runs only objectives that opted in, only in read-only live mode, each within its own limits.
export async function runDue(store, deps, plan, nowMs = store.now()) {
  if (!deps || !deps.makeRunner || !deps.policy || deps.policy.mode !== "read-only-live") throw new Error("background runs are read-only live only");
  const ran = [], skipped = [];
  for (const p of plan) {
    if (!p.opted_in) { skipped.push({ objective: p.objective, reason: "this objective has not opted in to background work" }); continue; }
    const controller = new Controller({ store, runner: deps.makeRunner(store), replanner: deps.replanner, catalog: deps.catalog });
    const res = await controller.run(p.objective, { maxIterations: 2 }); // a background pass is short; anything longer waits for the next tick
    await store.appendEvent(p.project, { kind: "background_ran", objectiveId: p.objective, data: { state: res.state, retries: res.retries, revisions: res.revisions } });
    const pol = await store.getPolicy(p.objective), o = await store.getObjective(p.objective);
    await store.advanceSchedule(p.objective, o.status === "completed" || o.status === "cancelled" ? null : (p.interval_seconds ? nowMs + p.interval_seconds * 1000 : null));
    ran.push({ objective: p.objective, state: res.state });
  }
  return { authorised: true, ran, skipped };
}
