// NORIA GRAPH API — the server end of the persistent task-graph store, inside the accounts worker (it owns D1 and the sessions).
//
// One endpoint: POST /graph/op { op, args }. Only the operations on the allow-list below can be called; each runs on a GraphStore built for
// the SIGNED-IN user, so every query is scoped to that user. Nothing here runs a tool: it stores and retrieves state. The permission and
// approval rules stay in the executor and the tool layer.
import { GraphStore, SCHEMA } from './agent/graph-store.js'

// operation name -> the store method it calls. Anything not listed is refused.
export const GRAPH_OPS = new Set([
  'createProject', 'listProjects', 'getProject', 'archiveProject', 'deleteProject',
  'createObjective', 'getObjective', 'listObjectives', 'setObjectiveStatus', 'syncObjectiveState',
  'tasks', 'results', 'claimReady', 'finishTask', 'transition', 'approveTask', 'promote', 'recover', 'attempts', 'reviseGraph',
  'ledgerGet', 'ledgerSet',
  'addArtifact', 'getArtifact', 'listArtifacts',
  'addDecision', 'decisions',
  'memSet', 'memGet', 'memList', 'memMap', 'memDelete', 'memSearch', 'context', 'dataContext',
  'appendEvent', 'events', 'verifyEvents',
  'setSchedule', 'dueObjectives', 'advanceSchedule',
  // control loop (schema v2)
  'getPolicy', 'setPolicy', 'retryTask', 'recordUses', 'currentRefHash', 'staleCheck', 'observe', 'supersedeMany', 'learnFromFailure',
  'checkpoint', 'pauseObjective', 'resumeObjective', 'revisionState',
  // fewer round trips (the store restricts what a batch may contain)
  'batch', 'appendEvents', 'claimReadyContext', 'projectSnapshot',
])
const MAX_BODY = 400000

export async function handleGraph(request, env, url, json, user) {
  if (!user) return json({ error: 'Sign in to use projects.' }, 401)
  if (url.pathname === '/graph/ping') return json({ ok: true, ops: GRAPH_OPS.size })
  if (url.pathname !== '/graph/op' || request.method !== 'POST') return json({ error: 'not found' }, 404)
  const text = await request.text()
  if (text.length > MAX_BODY) return json({ error: 'request too large' }, 413)
  let body; try { body = JSON.parse(text) } catch (_) { return json({ error: 'send JSON: { op, args }' }, 400) }
  if (!body || typeof body.op !== 'string' || !GRAPH_OPS.has(body.op)) return json({ error: 'unknown operation' }, 400)
  const args = Array.isArray(body.args) ? body.args : []
  const store = new GraphStore(env.DB, user.userId)
  try {
    const result = await store[body.op](...args)
    return json({ ok: true, result: result === undefined ? null : result })
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300)
    // a refusal by the store's own rules (no such project, illegal transition, too large…) is the caller's problem, not a server fault
    return json({ ok: false, error: msg }, /no such|illegal|cannot|larger|too large|full|bad status/i.test(msg) ? 400 : 500)
  }
}

// Removes every row that belongs to a user (called when an account is deleted).
export function graphDeleteStatements(db, userId) {
  const byUser = ['g_events', 'g_memory', 'g_decisions', 'g_artifacts', 'g_ledger', 'g_schedules', 'g_tasks']
  const stmts = [
    db.prepare('DELETE FROM g_attempts WHERE objective_id IN (SELECT id FROM g_objectives WHERE user_id = ?)').bind(userId),
    db.prepare('DELETE FROM g_task_deps WHERE objective_id IN (SELECT id FROM g_objectives WHERE user_id = ?)').bind(userId),
    db.prepare('DELETE FROM g_task_uses WHERE objective_id IN (SELECT id FROM g_objectives WHERE user_id = ?)').bind(userId),
  ]
  for (const t of byUser) stmts.push(db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(userId))
  stmts.push(db.prepare('DELETE FROM g_objectives WHERE user_id = ?').bind(userId), db.prepare('DELETE FROM g_projects WHERE user_id = ?').bind(userId))
  return stmts
}
export const GRAPH_SCHEMA_SQL = SCHEMA.join(';\n') + ';\n'
