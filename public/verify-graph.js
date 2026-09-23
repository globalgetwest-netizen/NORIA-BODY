// OWNER CHECK — the persistent task graph and control loop, in production, with the owner's own session.
// Read-only steps only. One test project, deleted afterwards unless kept. Nothing secret is displayed or included in the result.
import { listTools } from "/agent/tools.js";
import { validatePlan } from "/agent/planner.js";
import { graphClient } from "/agent/graph-client.js";
import { GraphRunner } from "/agent/graph-runner.js";
import { Controller, httpReplanner } from "/agent/control.js";
import { BrowserRuntime } from "/agent-runtime.js";

const $ = (id) => document.getElementById(id);
const rd = (k) => { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } };
const BASE = rd("noria.acct.base") || "https://noria-ai.insights-skyglobe.workers.dev";
const TOKEN = rd("noria.acct.token"), PRO = rd("noria.pro");
const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
$("who").textContent = TOKEN ? "Signed in on this browser. " + (PRO ? "A Pro code is saved (the real-model measurement will run)." : "No Pro code saved (the real-model measurement will be skipped).") : "You are not signed in on this browser. Sign in at the main page first, then come back.";
if (!TOKEN) $("run").disabled = true;

const results = [], measurements = [];
const show = () => { $("out").innerHTML = results.map((r) => '<div class="line ' + (r.ok ? "ok" : "bad") + '">' + (r.ok ? "PASS " : "FAIL ") + esc(r.name) + (r.detail ? ' <span class="info">— ' + esc(r.detail) + "</span>" : "") + "</div>").join("") + measurements.map((m) => '<div class="line info">MEASURED ' + esc(m.name) + " — " + esc(m.detail) + "</div>").join(""); };
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 240) }); show(); };
const measure = (name, detail) => { measurements.push({ name, detail: String(detail).slice(0, 400) }); show(); };
const guard = async (name, fn) => { try { await fn(); } catch (e) { check(name + " (did not complete)", false, (e && e.message) || e); } };

const H = { search: "ok", feeds: "ok", ai: "ok", accounts: "ok" };
const catalog = () => listTools(H).map((x) => ({ ...x }));
const plan = (tasks) => validatePlan({ tasks }, "owner check", catalog(), { now: new Date().toISOString() });
const calc = (id, expression, extra = {}) => ({ id, description: "calculate " + expression, tools: ["calc.math"], inputs: { "calc.math": { expression } }, ...extra });

async function main() {
  const t0 = Date.now();
  results.length = 0; measurements.length = 0; show();
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return ""; } })();
  const runtime = new BrowserRuntime({ base: "", tz });
  const mkClient = () => graphClient({ base: BASE, token: TOKEN });
  const mkRunner = (store, extra = {}) => new GraphRunner({ store, catalog: catalog(), runtime, policy: { mode: "read-only-live", grants: [], backoffScale: 0.2 }, ...extra });
  const scripted = (fn) => ({ async propose(state) { return fn(state); } });
  const mkCtl = (store, replanner, extra) => new Controller({ store, runner: mkRunner(store, extra), replanner, catalog: catalog() });
  let cl = mkClient(), pid = null;
  try {
    // 1 — the session works and the tables are there
    await guard("the session and the production tables work", async () => { const list = await cl.listProjects(); check("the session works and the graph tables answer in production", Array.isArray(list)); });
    if (!results.length || !results[0].ok) return;
    pid = await cl.createProject({ title: "NORIA CHECK — safe to delete" });
    check("a project can be created and read back", (await cl.getProject(pid)).title.startsWith("NORIA CHECK"));

    // 2 — a real plan, through the real read-only route, producing and passing an artifact
    await guard("plan → execute → artifact", async () => {
      const oid = await cl.createObjective(pid, "compute and record", plan([calc("t1", "6 * 7"), { id: "t2", description: "write the report", tools: ["artifact.write"], depends_on: ["t1"], inputs: { "artifact.write": { name: "report", kind: "text", content: "The answer is {{t1.output.value}}." } } }, { id: "t3", description: "read it back", tools: ["artifact.read"], depends_on: ["t2"], inputs: { "artifact.read": { name: "report" } } }]));
      const log = await mkCtl(cl, scripted(() => { throw new Error("no replan expected"); })).run(oid);
      const ts = await cl.tasks(oid), art = await cl.getArtifact(pid, "report");
      check("a plan runs through the real /brain/tool route and completes", log.state === "completed" && ts.every((t) => t.state === "done"), "state " + log.state);
      check("the real calculator answered 42", ts.find((t) => t.key === "t1").output && ts.find((t) => t.key === "t1").output.value === 42);
      check("a step produced an artifact and a later step read it", art && /42/.test(art.content) && ts.find((t) => t.key === "t3").output && /42/.test(ts.find((t) => t.key === "t3").output.content));
    });

    // 3 — failure → revision, finished work kept
    await guard("failure → revision", async () => {
      const oid = await cl.createObjective(pid, "recover from a bad step", plan([calc("a", "1 + 1"), calc("b", "this is not a calculation"), { id: "c", description: "use both", tools: ["calc.math"], depends_on: ["a", "b"], inputs: { "calc.math": { expression: "{{a.output.value}} + 1" } } }]));
      const rp = scripted(() => ({ reason: "the expression was not a calculation; use a plain one", remove: ["b"], add: [{ key: "b2", description: "calculate 2 + 2", tools: ["calc.math"], inputs: { "calc.math": { expression: "2 + 2" } } }], repoint: { c: ["a", "b2"] } }));
      const log = await mkCtl(cl, rp).run(oid), ts = Object.fromEntries((await cl.tasks(oid)).map((t) => [t.key, t]));
      check("a real failure is detected, the graph is revised, and the objective completes", log.revisions === 1 && log.state === "completed", "revisions " + log.revisions + ", retries " + log.retries + ", state " + log.state);
      check("finished work was kept and not repeated; the failed task is kept as history", ts.a.state === "done" && ts.a.attempts === 1 && ts.b.state === "removed" && !!ts.b.error);
    });

    // 4 — new information replaces stale work; old versions kept
    await guard("new information → replacement", async () => {
      await cl.memSet(pid, "rate", "10");
      const oid = await cl.createObjective(pid, "price with a rate", plan([calc("p", "100 * {{memory.rate}}"), { id: "q", description: "save the quote", tools: ["artifact.write"], depends_on: ["p"], inputs: { "artifact.write": { name: "quote", kind: "text", content: "total {{p.output.value}}" } } }]));
      const ctl = mkCtl(cl, scripted(() => { throw new Error("no replan expected"); }));
      await ctl.run(oid);
      const v1 = await cl.getArtifact(pid, "quote");
      const found = await cl.observe(oid, { key: "rate", value: "12", source: "owner check", note: "the rate changed" });
      const log = await mkCtl(mkClient(), scripted(() => { throw new Error("no replan expected"); })).run(oid);
      const v2 = await cl.getArtifact(pid, "quote"), old = await cl.getArtifact(pid, "quote", 1);
      check("the change is noticed: work that used the old value is found", found.some((f) => f.key === "p"));
      check("the stale work is replaced and the objective completes again", log.superseded >= 2 && log.state === "completed", "superseded " + log.superseded);
      check("the new artifact version reflects the new value; the old version is kept", v1.content === "total 1000" && v2.content === "total 1200" && old && old.content === "total 1000");
    });

    // 5 — pause, a fresh client (a restart), resume
    await guard("pause → restart → resume", async () => {
      const oid = await cl.createObjective(pid, "a long job", plan([calc("s1", "1 + 1"), calc("s2", "2 + 2", { depends_on: ["s1"] }), calc("s3", "3 + 3", { depends_on: ["s2"] }), calc("s4", "4 + 4", { depends_on: ["s3"] })]), { session_max_tasks: 2 });
      const r1 = await mkRunner(cl).run(oid);
      const o1 = await cl.getObjective(oid), done1 = (await cl.tasks(oid)).filter((t) => t.state === "done").length;
      check("the session budget pauses the objective with a checkpoint", r1.paused === true && o1.status === "paused" && done1 === 2, "done " + done1 + ", status " + o1.status);
      const fresh = mkClient(), res = await fresh.resumeObjective(oid);
      check("a new client (as after a restart) can resume it and sees the checkpoint", res && res.checkpoint && res.checkpoint.done.length === 2);
      const r2 = await mkRunner(fresh, { sessionMaxTasks: 10 }).run(oid), ts = await fresh.tasks(oid);
      check("it continues from where it stopped and finishes without repeating work", r2.state === "completed" && ts.every((t) => t.state === "done" && t.attempts === 1));
    });

    // 6 — history and side effects
    await guard("history and side effects", async () => {
      const v = await cl.verifyEvents(pid);
      check("the project's history is one unbroken, tamper-evident chain", v && v.ok, v && v.events ? v.events + " events" : "");
      const rep = runtime.report();
      check("nothing outside the allowed read-only calls was touched", rep.unexpected.length === 0 && !rep.storage_changed, rep.requests + " requests, " + rep.unexpected.length + " unexpected");
    });

    // 7 — the real model's revision (a measurement)
    if (PRO) await guard("real model", async () => {
      const oid = await cl.createObjective(pid, "revise with the real model", plan([calc("m1", "what is two plus two please"), { id: "m2", description: "add one", tools: ["calc.math"], depends_on: ["m1"], inputs: { "calc.math": { expression: "{{m1.output.value}} + 1" } } }]));
      const log = await mkCtl(cl, httpReplanner("", PRO)).run(oid), ts = await cl.tasks(oid);
      measure("real-model revision", "revisions applied " + log.revisions + ", refused " + log.refused.length + (log.refused[0] ? " (" + log.refused[0].why.slice(0, 120) + ")" : "") + ", asked " + log.asked.length + ", final state " + log.state + ", tasks " + ts.map((t) => t.key + ":" + t.state).join(" "));
    });
    else measure("real-model revision", "skipped: no Pro code saved in this browser");
  } finally {
    if (pid && $("del").checked) { try { await cl.deleteProject(pid); check("the test project was deleted afterwards", (await cl.listProjects()).every((p) => p.id !== pid)); } catch (e) { check("the test project was deleted afterwards", false, (e && e.message) || e); } }
    else if (pid) measure("test project kept", "project id " + pid + " (delete it when you are done)");
    measure("total time", Math.round((Date.now() - t0) / 100) / 10 + " seconds");
    const failed = results.filter((r) => !r.ok).length;
    $("json").textContent = JSON.stringify({ at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 100) / 10, site: location.origin, passed: results.length - failed, failed, checks: results, measurements }, null, 2);
  }
}
$("run").addEventListener("click", async () => { $("run").disabled = true; try { await main(); } catch (e) { check("the check ran to the end", false, (e && e.message) || e); } finally { $("run").disabled = false; } });
