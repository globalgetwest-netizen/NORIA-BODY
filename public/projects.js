// NORIA PROJECTS — an observation screen for the persistent task graph. It only READS: no run, approve, change or delete control exists here.
// Everything shown comes from the person's own account through the same store the runner uses (POST /graph/op, session-authenticated).
import { graphClient } from "/agent/graph-client.js";

const $ = (id) => document.getElementById(id);
const rd = (k) => { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } };
const BASE = rd("noria.acct.base") || "https://noria-ai.insights-skyglobe.workers.dev", TOKEN = rd("noria.acct.token");
const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const when = (ms) => { if (!ms) return ""; try { return new Date(ms).toLocaleString(); } catch (_) { return ""; } };
const short = (v, n = 400) => { if (v == null) return ""; let s; try { s = typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch (_) { s = String(v); } s = s == null ? "" : s; return s.length > n ? s.slice(0, n) + "…" : s; };
const STATE_TEXT = { pending: "waiting for earlier steps", ready: "ready to run", running: "running", done: "done", failed: "failed", blocked: "blocked (tool unavailable)", denied: "not allowed", awaiting_approval: "waiting for your approval", needs_permission: "needs a permission", uncertain: "outcome unknown: needs you", superseded: "replaced by a newer version", removed: "removed by a revision", skipped: "skipped (an earlier step did not finish)", cancelled: "cancelled" };
const OBJ_TEXT = { draft: "draft", planned: "planned", running: "running", paused: "paused", completed: "completed", partial: "partly done", failed: "failed", cancelled: "cancelled" };
const NEEDS_PERSON = new Set(["awaiting_approval", "needs_permission", "denied", "uncertain"]);
const HISTORICAL = new Set(["superseded", "removed"]);
const pill = (s, text) => '<span class="pill s-' + esc(s) + '">' + esc(text || STATE_TEXT[s] || OBJ_TEXT[s] || s) + "</span>";

let cl = null, sel = { project: null, objective: null }, timer = null, loading = false;

function levels(tasks) {
  const live = tasks.filter((t) => !HISTORICAL.has(t.state)), by = Object.fromEntries(live.map((t) => [t.key, t])), lv = {};
  const depth = (k, seen = new Set()) => { if (lv[k] != null) return lv[k]; if (seen.has(k)) return 0; seen.add(k); const ds = (by[k].depends_on || []).filter((d) => by[d]); return (lv[k] = ds.length ? 1 + Math.max(...ds.map((d) => depth(d, seen))) : 0); };
  live.forEach((t) => depth(t.key));
  const cols = []; live.forEach((t) => (cols[lv[t.key]] = cols[lv[t.key]] || []).push(t));
  return cols.filter(Boolean);
}
const taskCard = (t, tasksByKey) => {
  const ver = t.last_verification ? '<div class="ver ' + (t.last_verification.ok ? "" : "") + '">' + (t.last_verification.ok ? "✓ checked: " + esc(t.last_verification.method || "") : "✗ check failed: " + esc(t.last_verification.detail || t.last_verification.method || "")) + "</div>" : "";
  const deps = (t.depends_on || []).length ? '<div class="deps">after ' + t.depends_on.map(esc).join(", ") + "</div>" : "";
  const tools = (t.tools || []).length ? '<div class="deps">uses ' + t.tools.map(esc).join(", ") + "</div>" : "";
  return '<div class="task' + (t.stale ? " stale" : "") + '"><div><span class="k">' + esc(t.key) + "</span> " + pill(t.state) + (t.stale ? ' <span class="pill s-uncertain">out of date</span>' : "") + "</div><div>" + esc(t.description) + "</div>" + deps + tools +
    '<div class="tiny">attempts ' + (t.attempts || 0) + (t.retries ? ", retries " + t.retries : "") + (t.version > 1 ? ", version " + t.version : "") + "</div>" + ver + (t.error ? '<div class="err">' + esc(short(t.error, 260)) + "</div>" : "") +
    (t.output != null ? "<details><summary>result</summary><pre>" + esc(short(t.output, 1500)) + "</pre></details>" : "") + "</div>";
};

async function loadProject(pid) {
  const d = await cl.projectSnapshot(pid); // everything for the screen in ONE request
  if (!d) throw new Error("no such project");
  return d;
}

function renderObjectiveCard(o) {
  const c = {}; for (const t of o.tasks) c[t.state] = (c[t.state] || 0) + 1;
  const live = o.tasks.filter((t) => !HISTORICAL.has(t.state)), done = live.filter((t) => t.state === "done").length;
  const need = live.filter((t) => NEEDS_PERSON.has(t.state)).length, failed = live.filter((t) => t.state === "failed").length, replaced = (c.superseded || 0) + (c.removed || 0);
  return '<div class="obj' + (sel.objective === o.id ? " on" : "") + '" data-obj="' + esc(o.id) + '"><div class="top"><b style="flex:1">' + esc(o.text) + "</b>" + pill(o.status, OBJ_TEXT[o.status]) + '</div><div class="stats"><span>' + done + " of " + live.length + " steps done</span>" +
    (need ? "<span>" + need + " waiting for you</span>" : "") + (failed ? "<span>" + failed + " failed</span>" : "") + (o.revision_count ? "<span>revised " + o.revision_count + "×</span>" : "") + (replaced ? "<span>" + replaced + " replaced or removed</span>" : "") + "<span>plan v" + (o.graph_version || 1) + "</span><span>updated " + esc(when(o.updated_at)) + "</span></div></div>";
}

async function renderObjective(d, o) {
  const tasksByKey = Object.fromEntries(o.tasks.map((t) => [t.key, t])), cols = levels(o.tasks);
  const hist = o.tasks.filter((t) => HISTORICAL.has(t.state)), need = o.tasks.filter((t) => NEEDS_PERSON.has(t.state) || t.state === "failed" || (t.stale && t.approval_required));
  const cpArt = d.arts.filter((a) => a.name === "checkpoint:" + o.id).sort((a, b) => b.version - a.version)[0];
  let cp = null; const cpx = d.checkpoints && d.checkpoints[o.id]; if (cpArt && cpx) { try { cp = JSON.parse(cpx.content); } catch (_) {} }
  const evs = d.evs.filter((e) => e.objective_id === o.id);
  const count = (re) => evs.filter((e) => re.test(e.kind)).length;
  let h = '<div class="card"><h2>' + esc(o.text) + " " + pill(o.status, OBJ_TEXT[o.status]) + "</h2>";
  h += '<div class="stats"><span>plan version ' + (o.graph_version || 1) + "</span><span>revisions " + (o.revision_count || 0) + " of " + esc((o.policy && o.policy.max_revisions) != null ? o.policy.max_revisions : 3) + " allowed</span><span>resumptions " + count(/^objective_resumed$/) + "</span><span>pauses " + count(/^objective_paused$/) + "</span><span>replaced by newer versions " + hist.filter((t) => t.state === "superseded").length + "</span></div>";
  if (o.status === "paused") h += '<div class="need" style="margin-top:8px"><b>Paused.</b> ' + esc(cp && cp.note ? cp.note : "") + (cp ? " " + (cp.done || []).length + " steps done, " + (cp.open || []).length + " still open." : "") + " It can be resumed from the tool that started it; this screen cannot resume it.</div>";
  h += "<h3>Needs you</h3>";
  h += need.length ? need.map((t) => '<div class="need"><b>' + esc(t.key) + "</b> — " + esc(STATE_TEXT[t.state] || t.state) + (t.stale && t.approval_required ? " (its inputs changed after it acted; it will not be repeated without you)" : "") + ". " + esc(short(t.error || (t.notes && t.notes[0]) || t.description, 240)) + "</div>").join("") : '<p class="empty">Nothing is waiting for you.</p>';
  h += "<p class=\"tiny\">Approving or denying a step is not possible from this screen. Steps that act outside Noria are not authorised at all yet: they are shown here as waiting or not allowed and are never run.</p>";
  h += "<h3>Task graph</h3>" + (cols.length ? '<div class="graph">' + cols.map((col, i) => '<div class="col"><div class="lv">' + (i === 0 ? "start" : "then (step " + (i + 1) + ")") + "</div>" + col.map((t) => taskCard(t, tasksByKey)).join("") + "</div>").join("") + "</div>" : '<p class="empty">No steps.</p>');
  if (hist.length) h += "<details><summary>" + hist.length + " earlier steps replaced or removed (kept as history)</summary>" + hist.map((t) => '<div class="task"><span class="k">' + esc(t.key) + "</span> " + pill(t.state) + (t.superseded_by ? ' <span class="tiny">→ ' + esc(t.superseded_by) + "</span>" : "") + "<div>" + esc(t.description) + "</div>" + (t.error ? '<div class="err">' + esc(short(t.error, 200)) + "</div>" : "") + (t.output != null ? "<details><summary>its old result</summary><pre>" + esc(short(t.output, 800)) + "</pre></details>" : "") + "</div>").join("") + "</details>";
  h += "<h3>Execution</h3>";
  const rows = [];
  for (const t of o.tasks.filter((x) => x.attempts > 0)) for (const a of (o.attempts && o.attempts[t.key]) || []) rows.push({ t: t.key, ...a });
  h += rows.length ? "<table><tr><th>step</th><th>attempt</th><th>started</th><th>outcome</th><th>detail</th></tr>" + rows.slice(-60).map((a) => "<tr><td>" + esc(a.t) + "</td><td>" + esc(a.attempt) + "</td><td>" + esc(when(a.started_at)) + "</td><td>" + esc(a.outcome || "in progress") + "</td><td>" + esc(short(a.detail, 120)) + "</td></tr>").join("") + "</table>" : '<p class="empty">Nothing has run yet.</p>';
  return h + "</div>";
}

const KIND_TEXT = { graph_revised: "The plan was revised", tasks_superseded: "Finished work was replaced with newer versions", replan_decided: "A revision was proposed and accepted", replan_refused: "A proposed revision was refused", replan_needs_person: "Noria asked a person to decide", replan_gave_up: "Noria gave up on a step, with a reason", objective_paused: "Paused", objective_resumed: "Resumed", observation: "New information arrived", task_retry_decided: "A step was retried (same plan)", stale_needs_person: "Out-of-date step left for a person", background_skipped: "A background pass was declined (not authorised)", background_ran: "A background pass ran", approval_granted: "An approval was granted", memory_set: "Memory was written", memory_deleted: "A memory entry was deleted", artifact_added: "An artifact was saved", objective_created: "An objective was created", project_created: "The project was created" };
function renderTimeline(d, oid) {
  const items = [];
  for (const x of d.decs) if (!oid || !x.objective_id || x.objective_id === oid) items.push({ ts: x.created_at, text: x.decision + (x.rationale ? " — " + x.rationale : ""), by: x.made_by });
  for (const e of d.evs) if ((!oid || !e.objective_id || e.objective_id === oid) && KIND_TEXT[e.kind] && !/^(memory_set|artifact_added)$/.test(e.kind)) { let data = {}; try { data = JSON.parse(e.data || "{}"); } catch (_) {} items.push({ ts: e.ts, text: KIND_TEXT[e.kind] + (e.task_key ? " (" + e.task_key + ")" : "") + (data.reason ? ": " + data.reason : data.why ? ": " + data.why : ""), by: "" }); }
  items.sort((a, b) => b.ts - a.ts);
  return '<div class="card"><h2>Decisions, revisions and resumptions</h2>' + (items.length ? items.slice(0, 60).map((i) => '<div class="tl"><div class="when">' + esc(when(i.ts)) + (i.by ? " · " + esc(i.by) : "") + "</div>" + esc(short(i.text, 300)) + "</div>").join("") : '<p class="empty">Nothing recorded yet.</p>') + "</div>";
}
function renderSide(d) {
  const arts = {}; for (const a of d.arts) if (!a.name.startsWith("checkpoint:")) (arts[a.name] = arts[a.name] || []).push(a);
  const lessons = d.mem.filter((m) => m.key.startsWith("lesson:")), facts = d.mem.filter((m) => !m.key.startsWith("lesson:"));
  let h = '<div class="card"><h2>Artifacts</h2>';
  h += Object.keys(arts).length ? Object.entries(arts).map(([n, vs]) => "<div><b>" + esc(n) + "</b> " + vs.map((a) => '<button type="button" data-art="' + esc(a.name) + '" data-ver="' + a.version + '">v' + a.version + "</button>").join(" ") + '<span class="tiny"> ' + esc(vs[vs.length - 1].kind) + ", " + esc(vs[vs.length - 1].size) + ' bytes</span></div>').join("") + '<pre id="artview" hidden></pre>' : '<p class="empty">No artifacts yet.</p>';
  h += "</div>";
  h += '<div class="card"><h2>Memory</h2>' + (facts.length ? "<table><tr><th>key</th><th>value</th><th>source</th></tr>" + facts.map((m) => "<tr><td>" + esc(m.key) + "</td><td>" + esc(short(m.value, 200)) + "</td><td>" + esc(m.source) + "</td></tr>").join("") + "</table>" : '<p class="empty">Nothing remembered in this project.</p>');
  h += (lessons.length ? "<details><summary>" + lessons.length + " lessons from failures (kept to improve the next plan)</summary>" + lessons.map((m) => "<div class=\"tl\">" + esc(m.value && m.value.task) + ": " + esc(short(m.value && m.value.error, 160)) + "</div>").join("") + "</details>" : "") + '<p class="tiny">Correcting or deleting memory is not possible from this screen yet.</p></div>';
  h += '<div class="card"><h2>History</h2><p class="muted">' + (d.chain && d.chain.ok ? "✓ Unbroken chain of " + esc(d.chain.events) + " recorded events (any change or removal of past events would show here)." : "✗ The history chain does not verify: " + esc(d.chain && d.chain.problem)) + "</p></div>";
  return h;
}

async function showProject(pid) {
  sel.project = pid; const el = $("detail");
  if (!loading) el.innerHTML = '<div class="card"><p class="empty">Loading…</p></div>';
  const d = await loadProject(pid);
  if (sel.project !== pid) return;
  if (!sel.objective || !d.objs.some((o) => o.id === sel.objective)) sel.objective = (d.objs.find((o) => !["completed", "cancelled"].includes(o.status)) || d.objs[d.objs.length - 1] || {}).id || null;
  const o = d.objs.find((x) => x.id === sel.objective);
  let h = '<div class="card"><h2>' + esc(d.proj.title) + ' <span class="tiny">created ' + esc(when(d.proj.created_at)) + "</span></h2>";
  h += d.objs.length ? d.objs.map(renderObjectiveCard).join("") : '<p class="empty">This project has no objectives yet.</p>';
  h += "</div>";
  if (o) h += await renderObjective(d, o);
  h += renderTimeline(d, o && o.id) + renderSide(d);
  el.innerHTML = h;
  el.onclick = async (e) => {
    const ob = e.target.closest("[data-obj]"); if (ob) { sel.objective = ob.getAttribute("data-obj"); loading = true; try { await showProject(pid); } finally { loading = false; } return; }
    const ab = e.target.closest("[data-art]"); if (ab) { const v = $("artview"); try { const a = await cl.getArtifact(pid, ab.getAttribute("data-art"), Number(ab.getAttribute("data-ver"))); v.textContent = a ? a.content : "(not found)"; const old = document.getElementById("artimg"); if (old) old.remove(); if (a && a.kind === "svg") { const im = document.createElement("img"); im.id = "artimg"; im.alt = "chart preview"; im.style.cssText = "max-width:100%;background:#fff;border:1px solid var(--line);border-radius:8px;margin-top:8px"; im.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(a.content); v.before(im); } } catch (err) { v.textContent = "Could not load: " + err.message; } v.hidden = false; }
  };
}

async function refresh() {
  if (loading) return; loading = true;
  try {
    const list = await cl.listProjects();
    $("plist").innerHTML = list.length ? list.map((p) => '<button type="button" class="item' + (sel.project === p.id ? " on" : "") + '" data-p="' + esc(p.id) + '"><b>' + esc(p.title) + '</b><div class="tiny">' + esc(p.status) + " · updated " + esc(when(p.updated_at)) + "</div></button>").join("") : '<p class="empty">No projects yet. Projects appear here once something creates them; the owner check page can leave a test project in place if you untick "delete afterwards".</p>';
    if (!sel.project && list[0]) sel.project = list[0].id;
    if (sel.project && list.some((p) => p.id === sel.project)) await showProject(sel.project); else if (!list.length) $("detail").innerHTML = "";
    $("stamp").textContent = "Updated " + new Date().toLocaleTimeString();
  } catch (e) {
    $("detail").innerHTML = '<div class="card"><p class="empty">Could not load: ' + esc(e.message) + (e.status === 401 ? " — your session has ended; sign in again from the main page." : "") + "</p></div>";
  } finally { loading = false; }
}

function start() {
  if (!TOKEN) { $("gate").hidden = false; $("gate").innerHTML = "<h2>Sign in first</h2><p class=\"muted\">Projects live in your Noria account. Open <a href=\"/\">the main page</a>, then More (⋯) → Account, sign in, and come back here.</p>"; return; }
  $("main").hidden = false; cl = graphClient({ base: BASE, token: TOKEN });
  $("plist").onclick = (e) => { const b = e.target.closest("[data-p]"); if (b) { sel.project = b.getAttribute("data-p"); sel.objective = null; refresh(); } };
  $("refresh").onclick = () => refresh();
  refresh();
  timer = setInterval(() => { if (document.visibilityState === "visible" && !loading) refresh(); }, 15000);
}
start();
