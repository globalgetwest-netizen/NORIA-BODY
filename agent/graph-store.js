// NORIA GRAPH STORE — persistent projects, objectives, task graphs, artifacts, decisions, memory, idempotency and events.
//
// Written against the Cloudflare D1 interface (db.prepare(sql).bind(...).run() / .first() / .all(), db.batch([...])). D1 is SQLite, so the
// same SQL runs unchanged on a local SQLite engine in the tests. EVERY query is scoped to one user: a store instance is created for a
// signed-in user and cannot read or change anyone else's rows.
//
// Concurrency: a task is claimed by one compare-and-set UPDATE (status must still be "ready", or "running" with an expired lease), so two
// runners can never both take it. Events are chained per project (UNIQUE(project_id, seq) settles races by retry).

import { TASK_STATES, canTransition, newId, sha256, stableJson, graphFromPlan, checkRevision, objectiveStateFrom, resolveRefs, refTaskKeys, LIMITS, TERMINAL_STOP, WAITING } from "./graph.js";

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS g_projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', meta TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS g_projects_user ON g_projects (user_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS g_objectives (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, graph_version INTEGER NOT NULL DEFAULT 1, plan_id TEXT, plan_json TEXT, summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER)`,
  `CREATE INDEX IF NOT EXISTS g_objectives_project ON g_objectives (project_id, user_id)`,
  `CREATE TABLE IF NOT EXISTS g_tasks (objective_id TEXT NOT NULL, task_key TEXT NOT NULL, project_id TEXT NOT NULL, user_id TEXT NOT NULL, description TEXT, tools TEXT, input TEXT, verification TEXT, status TEXT NOT NULL, approval_required INTEGER NOT NULL DEFAULT 0, graph_version INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until INTEGER, output TEXT, error TEXT, notes TEXT, approval TEXT, started_at INTEGER, finished_at INTEGER, PRIMARY KEY (objective_id, task_key))`,
  `CREATE INDEX IF NOT EXISTS g_tasks_status ON g_tasks (objective_id, status)`,
  `CREATE TABLE IF NOT EXISTS g_task_deps (objective_id TEXT NOT NULL, task_key TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (objective_id, task_key, depends_on))`,
  `CREATE TABLE IF NOT EXISTS g_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, objective_id TEXT NOT NULL, task_key TEXT NOT NULL, attempt INTEGER NOT NULL, owner TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT NOT NULL, detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS g_attempts_task ON g_attempts (objective_id, task_key)`,
  `CREATE TABLE IF NOT EXISTS g_ledger (idem_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, objective_id TEXT NOT NULL, task_key TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, output TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS g_artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, objective_id TEXT, task_key TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, content TEXT, size INTEGER NOT NULL, sha256 TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL, UNIQUE (project_id, name, version))`,
  `CREATE TABLE IF NOT EXISTS g_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, user_id TEXT NOT NULL, objective_id TEXT, task_key TEXT, decision TEXT NOT NULL, rationale TEXT, made_by TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS g_memory (project_id TEXT NOT NULL, user_id TEXT NOT NULL, mkey TEXT NOT NULL, value TEXT NOT NULL, source TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (project_id, mkey))`,
  `CREATE TABLE IF NOT EXISTS g_events (project_id TEXT NOT NULL, seq INTEGER NOT NULL, user_id TEXT NOT NULL, ts INTEGER NOT NULL, objective_id TEXT, task_key TEXT, attempt INTEGER, kind TEXT NOT NULL, data TEXT, prev TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (project_id, seq))`,
  `CREATE TABLE IF NOT EXISTS g_schedules (objective_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, next_run_at INTEGER NOT NULL, interval_seconds INTEGER, reason TEXT, enabled INTEGER NOT NULL DEFAULT 1)`,
  `CREATE INDEX IF NOT EXISTS g_schedules_due ON g_schedules (enabled, next_run_at)`,
];
export const GRAPH_TABLES = ["g_schedules", "g_events", "g_memory", "g_decisions", "g_artifacts", "g_ledger", "g_attempts", "g_task_deps", "g_tasks", "g_objectives", "g_projects"];

const j = (v) => (v === undefined ? null : JSON.stringify(v));
const p = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch (_) { return d; } };
const words = (t) => String(t || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

export class GraphStore {
  constructor(db, userId, opts = {}) { if (!userId) throw new Error("a graph store needs a user"); this.db = db; this.u = String(userId); this.clock = opts.clock || (() => Date.now()); }
  now() { return this.clock(); }
  async init() { for (const s of SCHEMA) await this.db.prepare(s).run(); }
  q(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  async one(sql, ...args) { return await this.q(sql, ...args).first(); }
  async all(sql, ...args) { const r = await this.q(sql, ...args).all(); return r.results || r; }
  async run(sql, ...args) { return await this.q(sql, ...args).run(); }
  changes(r) { return (r && r.meta && r.meta.changes) || (r && r.changes) || 0; }

  // ── projects ──
  async createProject({ title, meta } = {}) {
    const id = newId("prj"), t = this.now();
    await this.run(`INSERT INTO g_projects (id, user_id, title, status, meta, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`, id, this.u, String(title || "Untitled project").slice(0, 200), "active", j(meta), t, t);
    await this.appendEvent(id, { kind: "project_created", data: { title } });
    return id;
  }
  async getProject(id) { const r = await this.one(`SELECT * FROM g_projects WHERE id = ? AND user_id = ?`, id, this.u); return r ? Object.assign(r, { meta: p(r.meta, {}) }) : null; }
  async listProjects() { return await this.all(`SELECT id, title, status, created_at, updated_at FROM g_projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100`, this.u); }
  async archiveProject(id) { const r = await this.run(`UPDATE g_projects SET status = 'archived', updated_at = ? WHERE id = ? AND user_id = ?`, this.now(), id, this.u); if (this.changes(r)) await this.appendEvent(id, { kind: "project_archived" }); return this.changes(r) === 1; }
  async deleteProject(id) {
    if (!(await this.getProject(id))) return false;
    const stmts = GRAPH_TABLES.filter((t) => t !== "g_projects" && t !== "g_task_deps" && t !== "g_attempts" && t !== "g_ledger" && t !== "g_schedules").map((t) => this.q(`DELETE FROM ${t} WHERE project_id = ? AND user_id = ?`, id, this.u));
    const objs = (await this.all(`SELECT id FROM g_objectives WHERE project_id = ? AND user_id = ?`, id, this.u)).map((o) => o.id);
    for (const o of objs) for (const t of ["g_task_deps", "g_attempts"]) stmts.push(this.q(`DELETE FROM ${t} WHERE objective_id = ?`, o));
    for (const o of objs) { stmts.push(this.q(`DELETE FROM g_ledger WHERE objective_id = ? AND user_id = ?`, o, this.u)); stmts.push(this.q(`DELETE FROM g_schedules WHERE objective_id = ? AND user_id = ?`, o, this.u)); }
    stmts.push(this.q(`DELETE FROM g_projects WHERE id = ? AND user_id = ?`, id, this.u));
    await this.db.batch(stmts); return true;
  }
  async deleteAllForUser() { for (const pr of await this.listProjects()) await this.deleteProject(pr.id); await this.run(`DELETE FROM g_projects WHERE user_id = ?`, this.u); }

  // ── objectives and their task graphs ──
  // planResult: the output of validatePlan. The plan is stored with the objective (audit), and its tasks become rows.
  async createObjective(projectId, text, planResult) {
    if (!(await this.getProject(projectId))) throw new Error("no such project");
    const g = graphFromPlan(planResult); if (!g.ok) throw new Error("cannot create the graph: " + g.problems.join("; "));
    const id = newId("obj"), t = this.now(), plan = planResult.plan;
    const stmts = [this.q(`INSERT INTO g_objectives (id, project_id, user_id, text, status, graph_version, plan_id, plan_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, id, projectId, this.u, String(text || plan.objective).slice(0, LIMITS.textBytes), "planned", 1, plan.audit && plan.audit.planId, j(plan), t, t)];
    for (const k of g.tasks) {
      stmts.push(this.q(`INSERT INTO g_tasks (objective_id, task_key, project_id, user_id, description, tools, input, verification, status, approval_required, graph_version, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, k.key, projectId, this.u, k.description, j(k.tools), j(k.input), j(k.verification), k.state, k.approval_required ? 1 : 0, 1, j(k.blocked_by)));
      for (const d of k.depends_on) stmts.push(this.q(`INSERT INTO g_task_deps (objective_id, task_key, depends_on) VALUES (?,?,?)`, id, k.key, d));
    }
    await this.db.batch(stmts);
    await this.appendEvent(projectId, { kind: "objective_created", objectiveId: id, data: { tasks: g.tasks.length, plan: plan.audit && plan.audit.planId } });
    await this.touch(projectId);
    return id;
  }
  async touch(projectId) { await this.run(`UPDATE g_projects SET updated_at = ? WHERE id = ? AND user_id = ?`, this.now(), projectId, this.u); }
  async getObjective(id) { const r = await this.one(`SELECT * FROM g_objectives WHERE id = ? AND user_id = ?`, id, this.u); return r ? Object.assign(r, { plan: p(r.plan_json, null) }) : null; }
  async listObjectives(projectId) { return await this.all(`SELECT id, text, status, graph_version, created_at, updated_at, completed_at FROM g_objectives WHERE project_id = ? AND user_id = ? ORDER BY created_at`, projectId, this.u); }
  async tasks(objectiveId) {
    const rows = await this.all(`SELECT * FROM g_tasks WHERE objective_id = ? AND user_id = ? ORDER BY rowid`, objectiveId, this.u);
    const deps = await this.all(`SELECT task_key, depends_on FROM g_task_deps WHERE objective_id = ?`, objectiveId);
    return rows.map((r) => ({ key: r.task_key, description: r.description, tools: p(r.tools, []), input: p(r.input, {}), verification: p(r.verification, []), state: r.status, approval_required: !!r.approval_required, graph_version: r.graph_version, attempts: r.attempts, lease_owner: r.lease_owner, lease_until: r.lease_until, output: p(r.output, null), error: r.error, notes: p(r.notes, []), approval: p(r.approval, null), started_at: r.started_at, finished_at: r.finished_at, depends_on: deps.filter((d) => d.task_key === r.task_key).map((d) => d.depends_on) }));
  }
  // the results of finished tasks, for data flow and for the executor's dependency check
  async results(objectiveId) { const out = {}; for (const t of await this.tasks(objectiveId)) out[t.key] = { status: t.state, output: t.output, error: t.error, tool: (t.tools || []).join("+") }; return out; }

  async syncObjectiveState(objectiveId) {
    const ts = await this.tasks(objectiveId), state = objectiveStateFrom(ts.map((x) => x.state)), o = await this.getObjective(objectiveId);
    if (!o || o.status === "cancelled" || o.status === "paused") return o && o.status;
    if (o.status !== state) {
      await this.run(`UPDATE g_objectives SET status = ?, updated_at = ?, completed_at = ? WHERE id = ? AND user_id = ?`, state, this.now(), state === "completed" ? this.now() : null, objectiveId, this.u);
      await this.appendEvent(o.project_id, { kind: "objective_" + state, objectiveId, data: { from: o.status } });
    }
    return state;
  }
  async setObjectiveStatus(objectiveId, status, why) {
    if (!["paused", "cancelled", "planned", "running"].includes(status)) throw new Error("bad status");
    const o = await this.getObjective(objectiveId); if (!o) return false;
    await this.run(`UPDATE g_objectives SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?`, status, this.now(), objectiveId, this.u);
    if (status === "cancelled") await this.run(`UPDATE g_tasks SET status = 'cancelled' WHERE objective_id = ? AND user_id = ? AND status IN ('pending','ready','awaiting_approval','needs_permission')`, objectiveId, this.u);
    await this.appendEvent(o.project_id, { kind: "objective_" + status, objectiveId, data: { why } }); return true;
  }

  // ── the task lifecycle ──
  // Take up to `limit` ready tasks (or running tasks whose lease has expired) for this owner. Each is claimed by one compare-and-set UPDATE.
  async claimReady(objectiveId, owner, limit = 4, leaseMs = 60000) {
    const t = this.now(), o = await this.getObjective(objectiveId);
    if (!o || ["cancelled", "paused"].includes(o.status)) return [];
    const cands = await this.all(`SELECT task_key FROM g_tasks WHERE objective_id = ? AND user_id = ? AND (status = 'ready' OR (status = 'running' AND lease_until < ?)) ORDER BY rowid LIMIT ?`, objectiveId, this.u, t, limit * 3);
    const got = [];
    for (const c of cands) {
      if (got.length >= limit) break;
      const r = await this.run(`UPDATE g_tasks SET status = 'running', lease_owner = ?, lease_until = ?, attempts = attempts + 1, started_at = ? WHERE objective_id = ? AND task_key = ? AND user_id = ? AND (status = 'ready' OR (status = 'running' AND lease_until < ?))`, owner, t + leaseMs, t, objectiveId, c.task_key, this.u, t);
      if (this.changes(r) === 1) {
        const task = (await this.tasks(objectiveId)).find((x) => x.key === c.task_key);
        await this.run(`INSERT INTO g_attempts (objective_id, task_key, attempt, owner, started_at, outcome) VALUES (?,?,?,?,?, 'running')`, objectiveId, c.task_key, task.attempts, owner, t);
        await this.appendEvent(o.project_id, { kind: "task_started", objectiveId, taskKey: c.task_key, attempt: task.attempts, data: { owner } });
        got.push(task);
      }
    }
    if (got.length) await this.run(`UPDATE g_objectives SET status = 'running', updated_at = ? WHERE id = ? AND user_id = ? AND status IN ('planned')`, t, objectiveId, this.u);
    return got;
  }
  // Finish (or park) a task this owner holds. `to` must be a legal transition from "running"; the owner check stops a stale runner overwriting.
  async finishTask(objectiveId, key, owner, to, { output, error, notes, attemptOutcome } = {}) {
    if (!TASK_STATES.includes(to) || !canTransition("running", to)) throw new Error("illegal transition running -> " + to);
    const t = this.now(), o = await this.getObjective(objectiveId); if (!o) return false;
    const r = await this.run(`UPDATE g_tasks SET status = ?, output = ?, error = ?, notes = ?, finished_at = ?, lease_owner = NULL, lease_until = NULL WHERE objective_id = ? AND task_key = ? AND user_id = ? AND status = 'running' AND lease_owner = ?`, to, j(output), error || null, j(notes || []), t, objectiveId, key, this.u, owner);
    if (this.changes(r) !== 1) return false; // we no longer hold it (lease expired and someone else took it)
    await this.run(`UPDATE g_attempts SET finished_at = ?, outcome = ?, detail = ? WHERE objective_id = ? AND task_key = ? AND finished_at IS NULL`, t, attemptOutcome || to, error || null, objectiveId, key);
    await this.appendEvent(o.project_id, { kind: "task_" + to, objectiveId, taskKey: key, data: { error: error || undefined } });
    await this.promote(objectiveId); await this.syncObjectiveState(objectiveId);
    return true;
  }
  // A guarded state change made by a person or the system (approve, retry, unblock…). `from` must match.
  async transition(objectiveId, key, from, to, { note, by } = {}) {
    if (!canTransition(from, to)) throw new Error("illegal transition " + from + " -> " + to);
    const o = await this.getObjective(objectiveId); if (!o) return false;
    const r = await this.run(`UPDATE g_tasks SET status = ?, lease_owner = NULL, lease_until = NULL, error = CASE WHEN ? = 'ready' THEN NULL ELSE error END WHERE objective_id = ? AND task_key = ? AND user_id = ? AND status = ?`, to, to, objectiveId, key, this.u, from);
    if (this.changes(r) !== 1) return false;
    await this.appendEvent(o.project_id, { kind: "task_" + from + "_to_" + to, objectiveId, taskKey: key, data: { note, by } });
    await this.promote(objectiveId); await this.syncObjectiveState(objectiveId);
    return true;
  }
  async approveTask(objectiveId, key, by) {
    const o = await this.getObjective(objectiveId); if (!o) return false;
    const r = await this.run(`UPDATE g_tasks SET status = 'ready', approval = ?, lease_owner = NULL, lease_until = NULL WHERE objective_id = ? AND task_key = ? AND user_id = ? AND status = 'awaiting_approval'`, j({ approved: true, by, at: this.now() }), objectiveId, key, this.u);
    if (this.changes(r) !== 1) return false;
    await this.addDecision(o.project_id, { objectiveId, taskKey: key, decision: "approved " + key, rationale: "approval given by " + by, madeBy: by });
    await this.appendEvent(o.project_id, { kind: "task_approved", objectiveId, taskKey: key, data: { by } }); await this.syncObjectiveState(objectiveId); return true;
  }
  // pending -> ready when every dependency is done; pending -> skipped when a dependency can no longer succeed. Repeats until nothing changes.
  async promote(objectiveId) {
    for (let i = 0; i < 25; i++) {
      const a = await this.run(`UPDATE g_tasks SET status = 'ready' WHERE objective_id = ? AND user_id = ? AND status = 'pending' AND NOT EXISTS (SELECT 1 FROM g_task_deps d JOIN g_tasks t2 ON t2.objective_id = d.objective_id AND t2.task_key = d.depends_on WHERE d.objective_id = g_tasks.objective_id AND d.task_key = g_tasks.task_key AND t2.status != 'done')`, objectiveId, this.u);
      const stop = TERMINAL_STOP.has ? [...TERMINAL_STOP].map((s) => `'${s}'`).join(",") : "'failed'";
      const b = await this.run(`UPDATE g_tasks SET status = 'skipped', error = 'a task it depends on did not complete' WHERE objective_id = ? AND user_id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM g_task_deps d JOIN g_tasks t2 ON t2.objective_id = d.objective_id AND t2.task_key = d.depends_on WHERE d.objective_id = g_tasks.objective_id AND d.task_key = g_tasks.task_key AND t2.status IN (${stop}))`, objectiveId, this.u);
      if (!this.changes(a) && !this.changes(b)) break;
    }
  }
  // After an interruption: a task still "running" whose lease has expired goes back to "ready" and its attempt is recorded as interrupted.
  async recover(objectiveId) {
    const t = this.now(), o = await this.getObjective(objectiveId); if (!o) return [];
    const stale = await this.all(`SELECT task_key, lease_owner FROM g_tasks WHERE objective_id = ? AND user_id = ? AND status = 'running' AND lease_until < ?`, objectiveId, this.u, t);
    for (const s of stale) {
      const r = await this.run(`UPDATE g_tasks SET status = 'ready', lease_owner = NULL, lease_until = NULL WHERE objective_id = ? AND task_key = ? AND user_id = ? AND status = 'running' AND lease_until < ?`, objectiveId, s.task_key, this.u, t);
      if (this.changes(r) === 1) {
        await this.run(`UPDATE g_attempts SET finished_at = ?, outcome = 'interrupted', detail = 'the runner stopped before finishing' WHERE objective_id = ? AND task_key = ? AND finished_at IS NULL`, t, objectiveId, s.task_key);
        await this.appendEvent(o.project_id, { kind: "task_recovered", objectiveId, taskKey: s.task_key, data: { was_held_by: s.lease_owner } });
      }
    }
    if (stale.length) await this.syncObjectiveState(objectiveId);
    return stale.map((s) => s.task_key);
  }
  async attempts(objectiveId, key) { return await this.all(`SELECT attempt, owner, started_at, finished_at, outcome, detail FROM g_attempts WHERE objective_id = ? AND task_key = ? ORDER BY id`, objectiveId, key); }

  // ── idempotency ledger: one row per step (key = objective + task + tool + resolved input) ──
  async ledgerGet(key) { const r = await this.one(`SELECT status, output FROM g_ledger WHERE idem_key = ? AND user_id = ?`, key, this.u); return r ? (r.status === "done" ? { ok: true, output: p(r.output, {}) } : { started: true }) : undefined; }
  async ledgerSet(key, rec, ctx = {}) {
    const t = this.now(), status = rec && rec.ok ? "done" : "started";
    await this.run(`INSERT INTO g_ledger (idem_key, user_id, objective_id, task_key, tool, status, output, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(idem_key) DO UPDATE SET status = excluded.status, output = excluded.output, updated_at = excluded.updated_at`, key, this.u, ctx.objectiveId || "", ctx.taskKey || "", ctx.tool || "", status, status === "done" ? j(rec.output) : null, t, t);
  }

  // ── artifacts (versioned by name) ──
  async addArtifact(projectId, { objectiveId, taskKey, name, kind, content, meta }) {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    if (Buffer_len(text) > LIMITS.artifactBytes) throw new Error("artifact is larger than " + LIMITS.artifactBytes + " bytes");
    if (!(await this.getProject(projectId))) throw new Error("no such project");
    const last = await this.one(`SELECT MAX(version) AS v FROM g_artifacts WHERE project_id = ? AND name = ? AND user_id = ?`, projectId, String(name), this.u), version = ((last && last.v) || 0) + 1, id = newId("art"), digest = await sha256(text);
    await this.run(`INSERT INTO g_artifacts (id, project_id, user_id, objective_id, task_key, name, kind, version, content, size, sha256, meta, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, projectId, this.u, objectiveId || null, taskKey || null, String(name).slice(0, 200), String(kind || "text").slice(0, 40), version, text, Buffer_len(text), digest, j(meta), this.now());
    await this.appendEvent(projectId, { kind: "artifact_added", objectiveId, taskKey, data: { name, version, sha256: digest.slice(0, 16) } });
    return { id, name, version, sha256: digest };
  }
  async getArtifact(projectId, name, version) {
    const r = version ? await this.one(`SELECT * FROM g_artifacts WHERE project_id = ? AND name = ? AND version = ? AND user_id = ?`, projectId, name, version, this.u) : await this.one(`SELECT * FROM g_artifacts WHERE project_id = ? AND name = ? AND user_id = ? ORDER BY version DESC LIMIT 1`, projectId, name, this.u);
    return r ? Object.assign(r, { meta: p(r.meta, {}) }) : null;
  }
  async listArtifacts(projectId) { return await this.all(`SELECT id, name, kind, version, size, sha256, task_key, objective_id, created_at FROM g_artifacts WHERE project_id = ? AND user_id = ? ORDER BY name, version`, projectId, this.u); }

  // ── decisions ──
  async addDecision(projectId, { objectiveId, taskKey, decision, rationale, madeBy }) {
    await this.run(`INSERT INTO g_decisions (project_id, user_id, objective_id, task_key, decision, rationale, made_by, created_at) VALUES (?,?,?,?,?,?,?,?)`, projectId, this.u, objectiveId || null, taskKey || null, String(decision).slice(0, 500), rationale ? String(rationale).slice(0, 1000) : null, madeBy || "noria", this.now());
  }
  async decisions(projectId, limit = 50) { return await this.all(`SELECT id, objective_id, task_key, decision, rationale, made_by, created_at FROM g_decisions WHERE project_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?`, projectId, this.u, limit); }

  // ── project memory: facts the project should carry, always deletable by the person ──
  async memSet(projectId, key, value, source = "user") {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (Buffer_len(text) > LIMITS.memoryValueBytes) throw new Error("memory value too large");
    if (!(await this.getProject(projectId))) throw new Error("no such project");
    const n = await this.one(`SELECT COUNT(*) AS n FROM g_memory WHERE project_id = ? AND user_id = ?`, projectId, this.u);
    const has = await this.one(`SELECT 1 AS x FROM g_memory WHERE project_id = ? AND mkey = ? AND user_id = ?`, projectId, key, this.u);
    if (!has && n && n.n >= LIMITS.memoryKeys) throw new Error("project memory is full");
    await this.run(`INSERT INTO g_memory (project_id, user_id, mkey, value, source, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id, mkey) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`, projectId, this.u, String(key).slice(0, 120), text, source, this.now());
    await this.appendEvent(projectId, { kind: "memory_set", data: { key, source } });
  }
  async memGet(projectId, key) { const r = await this.one(`SELECT value, source, updated_at FROM g_memory WHERE project_id = ? AND mkey = ? AND user_id = ?`, projectId, key, this.u); return r ? { value: p(r.value, r.value), source: r.source, updated_at: r.updated_at } : null; }
  async memList(projectId) { const rows = await this.all(`SELECT mkey, value, source, updated_at FROM g_memory WHERE project_id = ? AND user_id = ? ORDER BY mkey`, projectId, this.u); return rows.map((r) => ({ key: r.mkey, value: p(r.value, r.value), source: r.source, updated_at: r.updated_at })); }
  async memMap(projectId) { const o = {}; for (const m of await this.memList(projectId)) o[m.key] = m.value; return o; }
  async memDelete(projectId, key) {
    const r = await this.run(`DELETE FROM g_memory WHERE project_id = ? AND mkey = ? AND user_id = ?`, projectId, key, this.u);
    if (this.changes(r)) await this.appendEvent(projectId, { kind: "memory_deleted", data: { key } }); // the event names the key, never the value
    return this.changes(r) === 1;
  }
  // The memory most relevant to a question: keys and values ranked by shared words.
  async memSearch(projectId, query, limit = 5) {
    const q = new Set(words(query)); if (!q.size) return [];
    return (await this.memList(projectId)).map((m) => { const w = words(m.key + " " + (typeof m.value === "string" ? m.value : JSON.stringify(m.value))); return { ...m, score: w.filter((x) => q.has(x)).length / Math.sqrt(w.length || 1) }; }).filter((m) => m.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  }
  // Everything a task or a model step should know about the project right now.
  async context(projectId, objectiveId, question) {
    return { memory: await this.memSearch(projectId, question || "", 5), decisions: (await this.decisions(projectId, 5)).map((d) => ({ decision: d.decision, by: d.made_by })), artifacts: (await this.listArtifacts(projectId)).slice(-10).map((a) => a.name + " v" + a.version), objective: objectiveId };
  }
  // The values a task's input references ({{memory.key}}, {{artifact.name}}, {{t1.output.x}}).
  async dataContext(projectId, objectiveId) {
    const artifacts = {}; for (const a of await this.listArtifacts(projectId)) { const full = await this.getArtifact(projectId, a.name); artifacts[a.name] = full.content; }
    return { results: await this.results(objectiveId), memory: await this.memMap(projectId), artifacts };
  }

  // ── events: the audit history, hash-chained per project ──
  async appendEvent(projectId, ev) {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, Math.random() * 6)); // several writers at once: back off a little and read again
      const last = await this.one(`SELECT seq, hash FROM g_events WHERE project_id = ? ORDER BY seq DESC LIMIT 1`, projectId), seq = last ? last.seq + 1 : 1, prev = last ? last.hash : "genesis", ts = this.now();
      const data = ev.data === undefined ? null : JSON.stringify(ev.data).slice(0, 4000), body = stableJson({ seq, ts, kind: ev.kind, objective: ev.objectiveId || null, task: ev.taskKey || null, attempt: ev.attempt || null, data, prev });
      const hash = await sha256(prev + body);
      try { await this.run(`INSERT INTO g_events (project_id, seq, user_id, ts, objective_id, task_key, attempt, kind, data, prev, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, projectId, seq, this.u, ts, ev.objectiveId || null, ev.taskKey || null, ev.attempt || null, ev.kind, data, prev, hash); return seq; }
      catch (e) { if (!/UNIQUE|constraint|PRIMARY/i.test(String(e && e.message))) throw e; } // another writer took this seq: read again and retry
    }
    throw new Error("could not append the event (too much contention)");
  }
  async events(projectId, { objectiveId, limit = 200 } = {}) { return await this.all(`SELECT seq, ts, objective_id, task_key, attempt, kind, data, hash FROM g_events WHERE project_id = ? AND user_id = ? ${objectiveId ? "AND objective_id = ?" : ""} ORDER BY seq DESC LIMIT ?`, ...[projectId, this.u].concat(objectiveId ? [objectiveId] : [], [limit])); }
  async verifyEvents(projectId) {
    const rows = await this.all(`SELECT * FROM g_events WHERE project_id = ? AND user_id = ? ORDER BY seq`, projectId, this.u); let prev = "genesis", n = 0;
    for (const r of rows) {
      const body = stableJson({ seq: r.seq, ts: r.ts, kind: r.kind, objective: r.objective_id, task: r.task_key, attempt: r.attempt, data: r.data, prev });
      if (r.prev !== prev || r.hash !== (await sha256(prev + body))) return { ok: false, brokenAt: r.seq, events: rows.length };
      prev = r.hash; n++;
    }
    return { ok: true, events: n };
  }

  // ── revising a graph ──
  async reviseGraph(objectiveId, revision, { reason, by = "noria" } = {}) {
    const o = await this.getObjective(objectiveId); if (!o) throw new Error("no such objective");
    const current = await this.tasks(objectiveId), chk = checkRevision(current, revision);
    if (!chk.ok) return { ok: false, problems: chk.problems };
    const version = o.graph_version + 1, stmts = [];
    for (const k of revision.remove || []) stmts.push(this.q(`UPDATE g_tasks SET status = 'removed', graph_version = ? WHERE objective_id = ? AND task_key = ? AND user_id = ?`, version, objectiveId, k, this.u));
    for (const a of revision.add || []) {
      const deps = [...new Set([...(a.depends_on || []), ...refTaskKeys(a.input || {})])];
      stmts.push(this.q(`INSERT INTO g_tasks (objective_id, task_key, project_id, user_id, description, tools, input, verification, status, approval_required, graph_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, objectiveId, a.key, o.project_id, this.u, a.description || "", j(a.tools || []), j(a.input || {}), j(a.verification || []), "pending", a.approval_required ? 1 : 0, version));
      for (const d of deps) stmts.push(this.q(`INSERT INTO g_task_deps (objective_id, task_key, depends_on) VALUES (?,?,?)`, objectiveId, a.key, d));
    }
    // re-point dependents of removed tasks that the revision names, and re-open tasks that were skipped only because of a removed one
    for (const [key, deps] of Object.entries(revision.repoint || {})) { stmts.push(this.q(`DELETE FROM g_task_deps WHERE objective_id = ? AND task_key = ?`, objectiveId, key)); for (const d of deps) stmts.push(this.q(`INSERT INTO g_task_deps (objective_id, task_key, depends_on) VALUES (?,?,?)`, objectiveId, key, d)); stmts.push(this.q(`UPDATE g_tasks SET status = 'pending', error = NULL WHERE objective_id = ? AND task_key = ? AND user_id = ? AND status IN ('skipped','failed','blocked')`, objectiveId, key, this.u)); }
    stmts.push(this.q(`UPDATE g_objectives SET graph_version = ?, updated_at = ?, status = 'running' WHERE id = ? AND user_id = ? AND status NOT IN ('cancelled')`, version, this.now(), objectiveId, this.u));
    await this.db.batch(stmts);
    await this.addDecision(o.project_id, { objectiveId, decision: "revised the task graph to version " + version, rationale: reason || "", madeBy: by });
    await this.appendEvent(o.project_id, { kind: "graph_revised", objectiveId, data: { version, added: (revision.add || []).map((a) => a.key), removed: revision.remove || [], reason } });
    await this.promote(objectiveId); await this.syncObjectiveState(objectiveId);
    return { ok: true, version };
  }

  // ── a clean path to background continuation (scheduling only: no background execution is switched on) ──
  async setSchedule(objectiveId, { nextRunAt, intervalSeconds, reason }) {
    const o = await this.getObjective(objectiveId); if (!o) return false;
    await this.run(`INSERT INTO g_schedules (objective_id, project_id, user_id, next_run_at, interval_seconds, reason, enabled) VALUES (?,?,?,?,?,?,1) ON CONFLICT(objective_id) DO UPDATE SET next_run_at = excluded.next_run_at, interval_seconds = excluded.interval_seconds, reason = excluded.reason, enabled = 1`, objectiveId, o.project_id, this.u, nextRunAt, intervalSeconds || null, reason || null);
    await this.appendEvent(o.project_id, { kind: "schedule_set", objectiveId, data: { nextRunAt, intervalSeconds, reason } }); return true;
  }
  async dueObjectives(nowMs = this.now()) { return await this.all(`SELECT s.objective_id, s.project_id, s.next_run_at, s.interval_seconds, s.reason FROM g_schedules s JOIN g_objectives o ON o.id = s.objective_id WHERE s.user_id = ? AND s.enabled = 1 AND s.next_run_at <= ? AND o.status NOT IN ('completed','cancelled')`, this.u, nowMs); }
}
// bytes of a string (works in Workers and Node without Buffer)
function Buffer_len(s) { return new TextEncoder().encode(String(s)).length; }
