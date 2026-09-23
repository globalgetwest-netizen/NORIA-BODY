// NORIA GRAPH STORE — persistent projects, objectives, task graphs, artifacts, decisions, memory, idempotency and events.
//
// Written against the Cloudflare D1 interface (db.prepare(sql).bind(...).run() / .first() / .all(), db.batch([...])). D1 is SQLite, so the
// same SQL runs unchanged on a local SQLite engine in the tests. EVERY query is scoped to one user: a store instance is created for a
// signed-in user and cannot read or change anyone else's rows.
//
// Concurrency: a task is claimed by one compare-and-set UPDATE (status must still be "ready", or "running" with an expired lease), so two
// runners can never both take it. Events are chained per project (UNIQUE(project_id, seq) settles races by retry).

import { refHash, TASK_STATES, canTransition, newId, sha256, stableJson, graphFromPlan, checkRevision, objectiveStateFrom, resolveRefs, refTaskKeys, collectRefs, LIMITS, TERMINAL_STOP, WAITING, DEFAULT_POLICY } from "./graph.js";

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS g_projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', meta TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS g_projects_user ON g_projects (user_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS g_objectives (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, graph_version INTEGER NOT NULL DEFAULT 1, plan_id TEXT, plan_json TEXT, summary TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER, policy TEXT, revision_count INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS g_objectives_project ON g_objectives (project_id, user_id)`,
  `CREATE TABLE IF NOT EXISTS g_tasks (objective_id TEXT NOT NULL, task_key TEXT NOT NULL, project_id TEXT NOT NULL, user_id TEXT NOT NULL, description TEXT, tools TEXT, input TEXT, verification TEXT, status TEXT NOT NULL, approval_required INTEGER NOT NULL DEFAULT 0, graph_version INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_until INTEGER, output TEXT, error TEXT, notes TEXT, approval TEXT, started_at INTEGER, finished_at INTEGER, stale INTEGER NOT NULL DEFAULT 0, superseded_by TEXT, retries INTEGER NOT NULL DEFAULT 0, last_verification TEXT, remember TEXT, version INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (objective_id, task_key))`,
  `CREATE INDEX IF NOT EXISTS g_tasks_status ON g_tasks (objective_id, status)`,
  `CREATE TABLE IF NOT EXISTS g_task_deps (objective_id TEXT NOT NULL, task_key TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (objective_id, task_key, depends_on))`,
  `CREATE TABLE IF NOT EXISTS g_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, objective_id TEXT NOT NULL, task_key TEXT NOT NULL, attempt INTEGER NOT NULL, owner TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT NOT NULL, detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS g_attempts_task ON g_attempts (objective_id, task_key)`,
  `CREATE TABLE IF NOT EXISTS g_ledger (idem_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, objective_id TEXT NOT NULL, task_key TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, output TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS g_artifacts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, objective_id TEXT, task_key TEXT, name TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL, content TEXT, size INTEGER NOT NULL, sha256 TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL, UNIQUE (project_id, name, version))`,
  `CREATE TABLE IF NOT EXISTS g_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, user_id TEXT NOT NULL, objective_id TEXT, task_key TEXT, decision TEXT NOT NULL, rationale TEXT, made_by TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS g_memory (project_id TEXT NOT NULL, user_id TEXT NOT NULL, mkey TEXT NOT NULL, value TEXT NOT NULL, source TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (project_id, mkey))`,
  `CREATE TABLE IF NOT EXISTS g_events (project_id TEXT NOT NULL, seq INTEGER NOT NULL, user_id TEXT NOT NULL, ts INTEGER NOT NULL, objective_id TEXT, task_key TEXT, attempt INTEGER, kind TEXT NOT NULL, data TEXT, prev TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (project_id, seq))`,
  `CREATE TABLE IF NOT EXISTS g_task_uses (objective_id TEXT NOT NULL, task_key TEXT NOT NULL, ref TEXT NOT NULL, value_hash TEXT NOT NULL, PRIMARY KEY (objective_id, task_key, ref))`,
  `CREATE TABLE IF NOT EXISTS g_meta (k TEXT PRIMARY KEY, v TEXT)`,
  `CREATE TABLE IF NOT EXISTS g_schedules (objective_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, next_run_at INTEGER NOT NULL, interval_seconds INTEGER, reason TEXT, enabled INTEGER NOT NULL DEFAULT 1)`,
  `CREATE INDEX IF NOT EXISTS g_schedules_due ON g_schedules (enabled, next_run_at)`,
];
export const SCHEMA_VERSION = 2;
// Databases created at version 1 get these statements once (tables that did not exist are created by SCHEMA; columns are added here).
export const MIGRATION_2 = [
  `ALTER TABLE g_objectives ADD COLUMN policy TEXT`,
  `ALTER TABLE g_objectives ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE g_tasks ADD COLUMN stale INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE g_tasks ADD COLUMN superseded_by TEXT`,
  `ALTER TABLE g_tasks ADD COLUMN retries INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE g_tasks ADD COLUMN last_verification TEXT`,
  `ALTER TABLE g_tasks ADD COLUMN remember TEXT`,
  `ALTER TABLE g_tasks ADD COLUMN version INTEGER NOT NULL DEFAULT 1`,
];
export const GRAPH_TABLES = ["g_task_uses", "g_meta", "g_schedules", "g_events", "g_memory", "g_decisions", "g_artifacts", "g_ledger", "g_attempts", "g_task_deps", "g_tasks", "g_objectives", "g_projects"];

const j = (v) => (v === undefined ? null : JSON.stringify(v));
const p = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch (_) { return d; } };
const words = (t) => String(t || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);

// The store operations a batch may contain: everything the runner and controller do, and nothing that deletes a project or account data.
export const BATCHABLE = new Set(["getObjective", "getPolicy", "recover", "promote", "syncObjectiveState", "recordUses", "finishTask", "staleCheck", "tasks", "memSet", "learnFromFailure", "addDecision", "getProject", "listObjectives", "results", "appendEvent", "appendEvents", "transition", "retryTask", "supersedeMany", "reviseGraph", "attempts", "getArtifact", "listArtifacts", "memList", "memGet", "decisions", "events"]);

export class GraphStore {
  constructor(db, userId, opts = {}) { if (!userId) throw new Error("a graph store needs a user"); this.db = db; this.u = String(userId); this.clock = opts.clock || (() => Date.now()); }
  now() { return this.clock(); }
  async init() {
    for (const s of SCHEMA) await this.db.prepare(s).run();
    await this.migrate();
  }
  // Brings a database created by an older version up to date, once. Safe to call again.
  async migrate() {
    const v = await this.one(`SELECT v FROM g_meta WHERE k = 'schema_version'`);
    if (v && Number(v.v) >= SCHEMA_VERSION) return SCHEMA_VERSION;
    const cols = (await this.all(`PRAGMA table_info(g_tasks)`)).map((c) => c.name);
    if (!cols.includes("stale")) for (const m of MIGRATION_2) await this.db.prepare(m).run(); // a version-1 database: add the columns
    await this.run(`INSERT INTO g_meta (k, v) VALUES ('schema_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, String(SCHEMA_VERSION));
    return SCHEMA_VERSION;
  }
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
    const stmts = GRAPH_TABLES.filter((t) => !["g_projects", "g_task_deps", "g_attempts", "g_ledger", "g_schedules", "g_task_uses", "g_meta"].includes(t)).map((t) => this.q(`DELETE FROM ${t} WHERE project_id = ? AND user_id = ?`, id, this.u));
    const objs = (await this.all(`SELECT id FROM g_objectives WHERE project_id = ? AND user_id = ?`, id, this.u)).map((o) => o.id);
    for (const o of objs) for (const t of ["g_task_deps", "g_attempts", "g_task_uses"]) stmts.push(this.q(`DELETE FROM ${t} WHERE objective_id = ?`, o));
    for (const o of objs) { stmts.push(this.q(`DELETE FROM g_ledger WHERE objective_id = ? AND user_id = ?`, o, this.u)); stmts.push(this.q(`DELETE FROM g_schedules WHERE objective_id = ? AND user_id = ?`, o, this.u)); }
    stmts.push(this.q(`DELETE FROM g_projects WHERE id = ? AND user_id = ?`, id, this.u));
    await this.db.batch(stmts); return true;
  }
  async deleteAllForUser() { for (const pr of await this.listProjects()) await this.deleteProject(pr.id); await this.run(`DELETE FROM g_projects WHERE user_id = ?`, this.u); }

  // ── objectives and their task graphs ──
  // planResult: the output of validatePlan. The plan is stored with the objective (audit), and its tasks become rows.
  async createObjective(projectId, text, planResult, policy) {
    if (!(await this.getProject(projectId))) throw new Error("no such project");
    const g = graphFromPlan(planResult); if (!g.ok) throw new Error("cannot create the graph: " + g.problems.join("; "));
    const id = newId("obj"), t = this.now(), plan = planResult.plan;
    const stmts = [this.q(`INSERT INTO g_objectives (id, project_id, user_id, text, status, graph_version, plan_id, plan_json, created_at, updated_at, policy) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, projectId, this.u, String(text || plan.objective).slice(0, LIMITS.textBytes), "planned", 1, plan.audit && plan.audit.planId, j(plan), t, t, j(Object.assign({}, DEFAULT_POLICY, policy || {})))];
    for (const k of g.tasks) {
      stmts.push(this.q(`INSERT INTO g_tasks (objective_id, task_key, project_id, user_id, description, tools, input, verification, status, approval_required, graph_version, notes, remember) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, k.key, projectId, this.u, k.description, j(k.tools), j(k.input), j(k.verification), k.state, k.approval_required ? 1 : 0, 1, j(k.blocked_by), j(k.remember)));
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
    return rows.map((r) => ({ key: r.task_key, description: r.description, tools: p(r.tools, []), input: p(r.input, {}), verification: p(r.verification, []), state: r.status, approval_required: !!r.approval_required, graph_version: r.graph_version, attempts: r.attempts, lease_owner: r.lease_owner, lease_until: r.lease_until, output: p(r.output, null), error: r.error, notes: p(r.notes, []), approval: p(r.approval, null), started_at: r.started_at, finished_at: r.finished_at, stale: !!r.stale, superseded_by: r.superseded_by, retries: r.retries || 0, last_verification: p(r.last_verification, null), remember: p(r.remember, null), version: r.version || 1, depends_on: deps.filter((d) => d.task_key === r.task_key).map((d) => d.depends_on) }));
  }
  // the results of finished tasks, for data flow and for the executor's dependency check
  // A task that was replaced by a newer version answers with the NEWEST version's result, so a reference {{t2.output.x}} always reads current work.
  async results(objectiveId) {
    const ts = await this.tasks(objectiveId), by = Object.fromEntries(ts.map((t) => [t.key, t])), out = {};
    for (const t of ts) { let cur = t, hops = 0; while (cur.superseded_by && by[cur.superseded_by] && hops++ < 20) cur = by[cur.superseded_by]; out[t.key] = { status: cur.state, output: cur.output, error: cur.error, tool: (cur.tools || []).join("+"), version: cur.version, key: cur.key }; }
    return out;
  }

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
  async finishTask(objectiveId, key, owner, to, { output, error, notes, attemptOutcome, verification } = {}) {
    if (!TASK_STATES.includes(to) || !canTransition("running", to)) throw new Error("illegal transition running -> " + to);
    const t = this.now(), o = await this.getObjective(objectiveId); if (!o) return false;
    const r = await this.run(`UPDATE g_tasks SET status = ?, output = ?, error = ?, notes = ?, last_verification = COALESCE(?, last_verification), finished_at = ?, lease_owner = NULL, lease_until = NULL WHERE objective_id = ? AND task_key = ? AND user_id = ? AND status = 'running' AND lease_owner = ?`, to, j(output), error || null, j(notes || []), j(verification), t, objectiveId, key, this.u, owner);
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
  // Several events in ONE go: the chain is read once, every hash is computed here, and all rows are written in one atomic batch.
  async appendEvents(projectId, list) {
    if (!list || !list.length) return 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, Math.random() * 6));
      const last = await this.one(`SELECT seq, hash FROM g_events WHERE project_id = ? ORDER BY seq DESC LIMIT 1`, projectId);
      let seq = last ? last.seq : 0, prev = last ? last.hash : "genesis"; const stmts = [];
      for (const ev of list) {
        seq += 1; const ts = this.now(), data = ev.data === undefined ? null : JSON.stringify(ev.data).slice(0, 4000);
        const body = stableJson({ seq, ts, kind: ev.kind, objective: ev.objectiveId || null, task: ev.taskKey || null, attempt: ev.attempt || null, data, prev });
        const hash = await sha256(prev + body);
        stmts.push(this.q(`INSERT INTO g_events (project_id, seq, user_id, ts, objective_id, task_key, attempt, kind, data, prev, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, projectId, seq, this.u, ts, ev.objectiveId || null, ev.taskKey || null, ev.attempt || null, ev.kind, data, prev, hash));
        prev = hash;
      }
      try { await this.db.batch(stmts); return list.length; }
      catch (e) { if (!/UNIQUE|constraint|PRIMARY/i.test(String(e && e.message))) throw e; } // another writer took a seq: read again and retry the whole group
    }
    throw new Error("could not append the events (too much contention)");
  }
  // Claim ready tasks AND return what they need to run (data context and stored results): one request instead of three or more.
  async claimReadyContext(objectiveId, owner, limit = 4, leaseMs = 60000) {
    const tasks = await this.claimReady(objectiveId, owner, limit, leaseMs);
    if (!tasks.length) return { tasks: [], context: null, results: null };
    const o = await this.getObjective(objectiveId), context = await this.dataContext(o.project_id, objectiveId);
    return { tasks, context, results: context.results };
  }
  // Several store operations in one request, run in order. Only the operations listed here are allowed; the first error stops the rest and is thrown
  // (what already ran stays done: every operation is its own atomic step, exactly as if they had been called one by one).
  async batch(calls) {
    if (!Array.isArray(calls) || calls.length < 1 || calls.length > 12) throw new Error("a batch is 1 to 12 operations");
    const out = [];
    for (const c of calls) {
      if (!c || !BATCHABLE.has(c.op)) throw new Error("that operation cannot be batched: " + (c && c.op));
      out.push(await this[c.op](...(Array.isArray(c.args) ? c.args : [])));
    }
    return out;
  }
  // Everything the projects screen shows for one project, in one read.
  async projectSnapshot(projectId) {
    const proj = await this.getProject(projectId); if (!proj) return null;
    const objs = await this.listObjectives(projectId), full = [];
    for (const o of objs) {
      const [obj, tasks, policy] = [await this.getObjective(o.id), await this.tasks(o.id), await this.getPolicy(o.id)], attempts = {};
      for (const t of tasks) if (t.attempts > 0) attempts[t.key] = await this.attempts(o.id, t.key);
      full.push({ ...o, revision_count: obj && obj.revision_count, policy, tasks, attempts });
    }
    const arts = await this.listArtifacts(projectId), checkpoints = {};
    for (const a of arts) if (a.name.startsWith("checkpoint:")) { const oid = a.name.slice(11), best = checkpoints[oid]; if (!best || a.version > best.version) { const full2 = await this.getArtifact(projectId, a.name, a.version); checkpoints[oid] = { version: a.version, content: full2 && full2.content }; } }
    return { proj, objs: full, arts, checkpoints, mem: await this.memList(projectId), decs: await this.decisions(projectId, 60), evs: await this.events(projectId, { limit: 200 }), chain: await this.verifyEvents(projectId) };
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
      stmts.push(this.q(`INSERT INTO g_tasks (objective_id, task_key, project_id, user_id, description, tools, input, verification, status, approval_required, graph_version, remember) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, objectiveId, a.key, o.project_id, this.u, a.description || "", j(a.tools || []), j(a.input || {}), j(a.verification || []), "pending", a.approval_required ? 1 : 0, version, j(a.remember)));
      for (const d of deps) stmts.push(this.q(`INSERT INTO g_task_deps (objective_id, task_key, depends_on) VALUES (?,?,?)`, objectiveId, a.key, d));
      // a replacement names what it replaces: references to the old task ({{old.output.x}}) then read the new task's output, so dependents need not be rewritten
      if (a.replaces && (revision.remove || []).includes(a.replaces)) stmts.push(this.q(`UPDATE g_tasks SET superseded_by = ? WHERE objective_id = ? AND task_key = ? AND user_id = ?`, a.key, objectiveId, a.replaces, this.u));
    }
    // re-point dependents of removed tasks that the revision names, and re-open tasks that were skipped only because of a removed one
    for (const [key, deps] of Object.entries(revision.repoint || {})) { stmts.push(this.q(`DELETE FROM g_task_deps WHERE objective_id = ? AND task_key = ?`, objectiveId, key)); for (const d of deps) stmts.push(this.q(`INSERT INTO g_task_deps (objective_id, task_key, depends_on) VALUES (?,?,?)`, objectiveId, key, d)); stmts.push(this.q(`UPDATE g_tasks SET status = 'pending', error = NULL WHERE objective_id = ? AND task_key = ? AND user_id = ? AND status IN ('skipped','failed','blocked')`, objectiveId, key, this.u)); }
    stmts.push(this.q(`UPDATE g_objectives SET graph_version = ?, updated_at = ?, revision_count = revision_count + 1, status = 'running' WHERE id = ? AND user_id = ? AND status NOT IN ('cancelled')`, version, this.now(), objectiveId, this.u));
    await this.db.batch(stmts);
    await this.addDecision(o.project_id, { objectiveId, decision: "revised the task graph to version " + version, rationale: reason || "", madeBy: by });
    await this.appendEvent(o.project_id, { kind: "graph_revised", objectiveId, data: { version, added: (revision.add || []).map((a) => a.key), removed: revision.remove || [], reason } });
    // work that was skipped only because of a task this revision replaced comes back with it (the rest of the chain, not just the re-pointed task)
    for (let i = 0; i < 25; i++) { const r = await this.run(`UPDATE g_tasks SET status = 'pending', error = NULL WHERE objective_id = ? AND user_id = ? AND status = 'skipped' AND error = 'a task it depends on did not complete' AND EXISTS (SELECT 1 FROM g_task_deps d JOIN g_tasks t2 ON t2.objective_id = d.objective_id AND t2.task_key = d.depends_on WHERE d.objective_id = g_tasks.objective_id AND d.task_key = g_tasks.task_key AND t2.status IN ('pending','ready'))`, objectiveId, this.u); if (!this.changes(r)) break; }
    await this.promote(objectiveId); await this.syncObjectiveState(objectiveId);
    return { ok: true, version };
  }


  // ════════ CONTROL LOOP SUPPORT (schema v2) ════════
  // ── the objective's own limits: how many times it may be revised or retried, how much one session may do ──
  async getPolicy(objectiveId) { const o = await this.getObjective(objectiveId); return o ? Object.assign({}, DEFAULT_POLICY, p(o.policy, {})) : null; }
  async setPolicy(objectiveId, patch) {
    const cur = await this.getPolicy(objectiveId); if (!cur) return null;
    const next = Object.assign({}, cur); for (const k of Object.keys(DEFAULT_POLICY)) if (patch && k in patch) next[k] = patch[k];
    await this.run(`UPDATE g_objectives SET policy = ? WHERE id = ? AND user_id = ?`, j(next), objectiveId, this.u); return next;
  }
  // ── retrying is not replanning: the same task, the same plan, another go (bounded by the policy) ──
  async retryTask(objectiveId, key, { reason, by = "noria" } = {}) {
    const o = await this.getObjective(objectiveId); if (!o) return false;
    const r = await this.run(`UPDATE g_tasks SET status = 'ready', retries = retries + 1, error = NULL, lease_owner = NULL, lease_until = NULL WHERE objective_id = ? AND task_key = ? AND user_id = ? AND status = 'failed'`, objectiveId, key, this.u);
    if (this.changes(r) !== 1) return false;
    await this.addDecision(o.project_id, { objectiveId, taskKey: key, decision: "retry " + key + " (same plan)", rationale: reason || "", madeBy: by });
    await this.appendEvent(o.project_id, { kind: "task_retry_decided", objectiveId, taskKey: key, data: { reason } });
    await this.promote(objectiveId); await this.syncObjectiveState(objectiveId); return true;
  }
  // ── what the tasks used: the value of every {{reference}} as it was when the task ran, so a change in it can be noticed later ──
  async recordUses(objectiveId, key, uses) {
    const stmts = [this.q(`DELETE FROM g_task_uses WHERE objective_id = ? AND task_key = ?`, objectiveId, key)];
    for (const u of uses || []) stmts.push(this.q(`INSERT OR REPLACE INTO g_task_uses (objective_id, task_key, ref, value_hash) VALUES (?,?,?,?)`, objectiveId, key, String(u.ref).slice(0, 200), u.hash));
    await this.db.batch(stmts);
  }
  async currentRefHash(ref, ctx) { return await refHash(ref, ctx); }
  // Finds work whose inputs have changed since it ran (new information): finished or failed tasks whose recorded references now read differently.
  // Marks them stale (never rewrites them) and returns what it found, with the reasons.
  async staleCheck(objectiveId) {
    const o = await this.getObjective(objectiveId); if (!o) return [];
    const ctx = await this.dataContext(o.project_id, objectiveId), tasks = await this.tasks(objectiveId);
    const uses = await this.all(`SELECT task_key, ref, value_hash FROM g_task_uses WHERE objective_id = ?`, objectiveId);
    const found = new Map();
    for (const u of uses) {
      const t = tasks.find((x) => x.key === u.task_key); if (!t || ["removed", "superseded", "cancelled"].includes(t.state)) continue;
      if (!["done", "failed", "running", "uncertain"].includes(t.state)) continue;
      const now = await this.currentRefHash(u.ref, ctx);
      if (now !== u.value_hash) { if (!found.has(t.key)) found.set(t.key, { key: t.key, state: t.state, changed: [] }); found.get(t.key).changed.push(u.ref); }
    }
    const out = [...found.values()];
    for (const f of out) {
      const r = await this.run(`UPDATE g_tasks SET stale = 1 WHERE objective_id = ? AND task_key = ? AND user_id = ? AND stale = 0`, objectiveId, f.key, this.u);
      if (this.changes(r)) await this.appendEvent(o.project_id, { kind: "task_stale", objectiveId, taskKey: f.key, data: { changed: f.changed } });
    }
    return out;
  }
  // New information arrives: it is written to project memory, recorded as a decision, and the work it invalidates is marked stale.
  async observe(objectiveId, { key, value, source, note }) {
    const o = await this.getObjective(objectiveId); if (!o) throw new Error("no such objective");
    await this.memSet(o.project_id, key, value, source || "observation");
    await this.addDecision(o.project_id, { objectiveId, decision: "new information: " + key, rationale: note || "", madeBy: source || "observation" });
    await this.appendEvent(o.project_id, { kind: "observation", objectiveId, data: { key, note } });
    return await this.staleCheck(objectiveId);
  }
  // ── replacing finished work with a newer version WITHOUT destroying it ──
  // The named tasks, and every finished task that depends on them, get a new version (key~2, key~3…). The old rows are marked superseded and keep
  // their output; references and dependents move to the new versions. A step that acts outside Noria is never re-run here: it is left stale for a person.
  async supersedeMany(objectiveId, keys, { reason, by = "noria" } = {}) {
    const o = await this.getObjective(objectiveId); if (!o) throw new Error("no such objective");
    const tasks = await this.tasks(objectiveId), byKey = Object.fromEntries(tasks.map((t) => [t.key, t])), live = (t) => !["removed", "superseded", "cancelled"].includes(t.state);
    const closure = new Set(keys.filter((k) => byKey[k] && live(byKey[k])));
    for (let grew = true; grew;) { grew = false; for (const t of tasks) if (live(t) && !closure.has(t.key) && ["done", "failed", "skipped"].includes(t.state) && t.depends_on.some((d) => closure.has(d))) { closure.add(t.key); grew = true; } }
    const held = [], redo = [];
    for (const k of closure) { const t = byKey[k]; if (t.state === "running") continue; (t.approval_required ? held : redo).push(k); }
    for (const k of held) { await this.run(`UPDATE g_tasks SET stale = 1 WHERE objective_id = ? AND task_key = ? AND user_id = ?`, objectiveId, k, this.u); await this.appendEvent(o.project_id, { kind: "stale_needs_person", objectiveId, taskKey: k, data: { why: "it acts outside Noria; it is not repeated automatically" } }); }
    if (!redo.length) return { ok: true, replaced: [], held };
    // order so a task's dependencies are replaced before it
    const order = []; const left = new Set(redo);
    while (left.size) { const next = [...left].filter((k) => byKey[k].depends_on.every((d) => !left.has(d))); if (!next.length) throw new Error("cannot order the replacement (cycle)"); for (const k of next) { order.push(k); left.delete(k); } }
    const newKey = {}; const base = (k) => k.replace(/~\d+$/, "");
    const taken = new Set(tasks.map((t) => t.key));
    for (const k of order) { let n = (byKey[k].version || 1) + 1, nk = base(k) + "~" + n; while (taken.has(nk)) nk = base(k) + "~" + (++n); taken.add(nk); newKey[k] = nk; }
    const stmts = [], t0 = this.now();
    for (const k of order) {
      const t = byKey[k], nk = newKey[k], deps = t.depends_on.map((d) => newKey[d] || d);
      stmts.push(this.q(`INSERT INTO g_tasks (objective_id, task_key, project_id, user_id, description, tools, input, verification, status, approval_required, graph_version, remember, version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, objectiveId, nk, o.project_id, this.u, t.description, j(t.tools), j(t.input), j(t.verification), "pending", 0, o.graph_version, j(t.remember), (t.version || 1) + 1));
      for (const d of deps) stmts.push(this.q(`INSERT INTO g_task_deps (objective_id, task_key, depends_on) VALUES (?,?,?)`, objectiveId, nk, d));
      stmts.push(this.q(`UPDATE g_tasks SET status = 'superseded', superseded_by = ?, stale = 0 WHERE objective_id = ? AND task_key = ? AND user_id = ?`, nk, objectiveId, k, this.u));
    }
    // anything else that waited on an old version now waits on the new one
    const exclude = [...order, ...order.map((x) => newKey[x])], ph = exclude.map(() => "?").join(",");
    for (const k of order) stmts.push(this.q(`UPDATE g_task_deps SET depends_on = ? WHERE objective_id = ? AND depends_on = ? AND task_key NOT IN (${ph})`, newKey[k], objectiveId, k, ...exclude)); // the old versions keep their old edges: that is the history
    stmts.push(this.q(`UPDATE g_objectives SET graph_version = graph_version + 1, updated_at = ?, status = 'running' WHERE id = ? AND user_id = ? AND status NOT IN ('cancelled')`, t0, objectiveId, this.u));
    await this.db.batch(stmts);
    await this.addDecision(o.project_id, { objectiveId, decision: "replaced " + order.join(", ") + " with newer versions", rationale: reason || "", madeBy: by });
    await this.appendEvent(o.project_id, { kind: "tasks_superseded", objectiveId, data: { replaced: newKey, held, reason } });
    await this.promote(objectiveId); await this.syncObjectiveState(objectiveId);
    return { ok: true, replaced: order.map((k) => ({ from: k, to: newKey[k] })), held };
  }
  // ── learning: what went wrong is remembered, briefly, so the next plan can avoid it ──
  async learnFromFailure(objectiveId, key) {
    const o = await this.getObjective(objectiveId); if (!o) return;
    const t = (await this.tasks(objectiveId)).find((x) => x.key === key); if (!t) return;
    const seq = 1 + Math.max(0, ...(await this.memList(o.project_id)).filter((m) => m.key.startsWith("lesson:")).map((m) => (m.value && m.value.seq) || 0)); // order by sequence: clocks can tie
    const lesson = { seq, task: key, tools: t.tools, error: String(t.error || "").slice(0, 200), verification: t.last_verification || undefined, input: JSON.stringify(t.input).slice(0, 160) };
    await this.memSet(o.project_id, "lesson:" + key, lesson, "noria");
    const all = (await this.memList(o.project_id)).filter((m) => m.key.startsWith("lesson:")).sort((a, b) => ((a.value && a.value.seq) || 0) - ((b.value && b.value.seq) || 0));
    for (const old of all.slice(0, Math.max(0, all.length - 20))) await this.memDelete(o.project_id, old.key); // keep the most recent 20
  }
  // ── pausing and resuming a long objective ──
  // A checkpoint is a versioned artifact: what is done, what is open, what is waiting on a person, what changed. Resuming reports what happened since.
  async checkpoint(objectiveId, note) {
    const o = await this.getObjective(objectiveId); if (!o) throw new Error("no such objective");
    const ts = await this.tasks(objectiveId), live = ts.filter((t) => !["removed"].includes(t.state));
    const snap = { objective: o.text, status: o.status, note: note || "", revision: o.graph_version, at: this.now(),
      done: live.filter((t) => t.state === "done").map((t) => ({ task: t.key, summary: JSON.stringify(t.output || {}).slice(0, 200) })),
      open: live.filter((t) => ["pending", "ready", "running"].includes(t.state)).map((t) => t.key),
      waiting_on_a_person: live.filter((t) => WAITING.has(t.state)).map((t) => ({ task: t.key, state: t.state })),
      failed: live.filter((t) => t.state === "failed").map((t) => ({ task: t.key, error: t.error })),
      stale: live.filter((t) => t.stale && t.state !== "superseded").map((t) => t.key),
      recent_decisions: (await this.decisions(o.project_id, 5)).map((d) => d.decision), memory_keys: (await this.memList(o.project_id)).map((m) => m.key).slice(0, 30) };
    const art = await this.addArtifact(o.project_id, { objectiveId, name: "checkpoint:" + objectiveId, kind: "checkpoint", content: JSON.stringify(snap) });
    const seq = await this.appendEvent(o.project_id, { kind: "checkpoint", objectiveId, data: { version: art.version, note } });
    return { version: art.version, seq, snapshot: snap };
  }
  async pauseObjective(objectiveId, reason) {
    const o = await this.getObjective(objectiveId); if (!o || ["completed", "cancelled"].includes(o.status)) return null;
    const cp = await this.checkpoint(objectiveId, reason);
    await this.run(`UPDATE g_objectives SET status = 'paused', updated_at = ? WHERE id = ? AND user_id = ?`, this.now(), objectiveId, this.u);
    await this.appendEvent(o.project_id, { kind: "objective_paused", objectiveId, data: { reason } });
    return cp;
  }
  async resumeObjective(objectiveId) {
    const o = await this.getObjective(objectiveId); if (!o || o.status !== "paused") return null;
    const last = await this.getArtifact(o.project_id, "checkpoint:" + objectiveId);
    const since = last ? (JSON.parse(last.content || "{}").at || 0) : 0;
    await this.run(`UPDATE g_objectives SET status = 'planned', updated_at = ? WHERE id = ? AND user_id = ?`, this.now(), objectiveId, this.u);
    const recovered = await this.recover(objectiveId), changes = (await this.events(o.project_id, { limit: 400 })).filter((e) => (!e.objective_id || e.objective_id === objectiveId) && e.ts >= since && !/^(exec_|task_started|task_done|checkpoint|objective_paused)/.test(e.kind)).map((e) => e.kind + (e.task_key ? " " + e.task_key : ""));
    await this.appendEvent(o.project_id, { kind: "objective_resumed", objectiveId, data: { recovered } });
    await this.syncObjectiveState(objectiveId);
    return { since, recovered, changed_since_pause: changes.slice(0, 40), checkpoint: last ? JSON.parse(last.content) : null };
  }
  // The state a re-planner needs: goals, tasks with outputs and failures, verification results, lessons, memory, decisions, limits.
  async revisionState(objectiveId) {
    const o = await this.getObjective(objectiveId); if (!o) return null;
    const ts = await this.tasks(objectiveId), mem = await this.memList(o.project_id), pol = await this.getPolicy(objectiveId);
    return { objective: o.text, revision: o.graph_version, revisions_used: o.revision_count, policy: pol,
      tasks: ts.filter((t) => t.state !== "removed").map((t) => ({ key: t.key, state: t.state, description: t.description, tools: t.tools, input: t.input, depends_on: t.depends_on, output: t.state === "done" ? JSON.stringify(t.output || {}).slice(0, 300) : undefined, error: t.error || undefined, verification: t.last_verification || undefined, retries: t.retries, stale: t.stale || undefined })),
      lessons: mem.filter((m) => m.key.startsWith("lesson:")).map((m) => m.value), memory: mem.filter((m) => !m.key.startsWith("lesson:")).map((m) => ({ key: m.key, value: typeof m.value === "string" ? m.value.slice(0, 200) : JSON.stringify(m.value).slice(0, 200) })).slice(0, 30),
      decisions: (await this.decisions(o.project_id, 10)).map((d) => ({ decision: d.decision, by: d.made_by })) };
  }

  // ── a clean path to background continuation (scheduling only: no background execution is switched on) ──
  async setSchedule(objectiveId, { nextRunAt, intervalSeconds, reason }) {
    const o = await this.getObjective(objectiveId); if (!o) return false;
    await this.run(`INSERT INTO g_schedules (objective_id, project_id, user_id, next_run_at, interval_seconds, reason, enabled) VALUES (?,?,?,?,?,?,1) ON CONFLICT(objective_id) DO UPDATE SET next_run_at = excluded.next_run_at, interval_seconds = excluded.interval_seconds, reason = excluded.reason, enabled = 1`, objectiveId, o.project_id, this.u, nextRunAt, intervalSeconds || null, reason || null);
    await this.appendEvent(o.project_id, { kind: "schedule_set", objectiveId, data: { nextRunAt, intervalSeconds, reason } }); return true;
  }
  // after a pass: look again at nextRunAt, or stop (null)
  async advanceSchedule(objectiveId, nextRunAt) { const r = nextRunAt == null ? await this.run(`UPDATE g_schedules SET enabled = 0 WHERE objective_id = ? AND user_id = ?`, objectiveId, this.u) : await this.run(`UPDATE g_schedules SET next_run_at = ?, enabled = 1 WHERE objective_id = ? AND user_id = ?`, nextRunAt, objectiveId, this.u); return this.changes(r) === 1; }
  async dueObjectives(nowMs = this.now()) { return await this.all(`SELECT s.objective_id, s.project_id, s.next_run_at, s.interval_seconds, s.reason FROM g_schedules s JOIN g_objectives o ON o.id = s.objective_id WHERE s.user_id = ? AND s.enabled = 1 AND s.next_run_at <= ? AND o.status NOT IN ('completed','cancelled')`, this.u, nowMs); }
}
// bytes of a string (works in Workers and Node without Buffer)
function Buffer_len(s) { return new TextEncoder().encode(String(s)).length; }
