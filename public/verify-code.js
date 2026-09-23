// OWNER CHECK — real objectives that need computation, end to end: plan -> code.run in the sealed sandbox -> verify -> artifacts -> task graph -> recover.
// Production store, the owner's own session, the real browser sandbox. One test project, deleted afterwards unless kept.
import { listTools } from "/agent/tools.js";
import { validatePlan } from "/agent/planner.js";
import { graphClient } from "/agent/graph-client.js";
import { GraphRunner } from "/agent/graph-runner.js";
import { Controller } from "/agent/control.js";
import { BrowserRuntime } from "/agent-runtime.js";
import { codeRunHandler } from "/sandbox.js";
import { expectedSales, salesPlan, pySalesPlan, medianPlan, medianFixRevision, loanPlan, loanFixRevision, LOAN_SLIP, hostilePlan } from "/code-scenarios.js";

const $ = (id) => document.getElementById(id);
const rd = (k) => { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } };
const BASE = rd("noria.acct.base") || "https://noria-ai.insights-skyglobe.workers.dev", TOKEN = rd("noria.acct.token");
const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
$("who").textContent = TOKEN ? "Signed in on this browser." : "You are not signed in on this browser. Sign in at the main page first, then come back.";
if (!TOKEN) $("run").disabled = true;
const results = [], measurements = [];
const show = () => { $("out").innerHTML = results.map((r) => '<div class="line ' + (r.ok ? "ok" : "bad") + '">' + (r.ok ? "PASS " : "FAIL ") + esc(r.name) + (r.detail ? ' <span class="info">— ' + esc(r.detail) + "</span>" : "") + "</div>").join("") + measurements.map((m) => '<div class="line info">MEASURED ' + esc(m.name) + " — " + esc(m.detail) + "</div>").join(""); };
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 260) }); show(); };
const measure = (name, detail) => { measurements.push({ name, detail: String(detail).slice(0, 500) }); show(); };
const guard = async (name, fn) => { try { await fn(); } catch (e) { check(name + " (did not complete)", false, (e && e.message) || e); } };

const H = { search: "ok", feeds: "ok", ai: "ok", accounts: "ok" };
const catalog = () => listTools(H).map((x) => ({ ...x }));
const plan = (tasks) => validatePlan({ tasks }, "owner check", catalog(), { now: new Date().toISOString() });

async function main() {
  const t0 = performance.now(); results.length = 0; measurements.length = 0; show();
  const cl = graphClient({ base: BASE, token: TOKEN }); let pid = null;
  const runtime = new BrowserRuntime({ base: "", deviceHandlers: { "code.run": codeRunHandler() } });
  const mk = (rp) => new Controller({ store: cl, runner: new GraphRunner({ store: cl, catalog: catalog(), runtime, policy: { mode: "read-only-live", grants: [], backoffScale: 0.2 } }), replanner: rp || { async propose() { throw new Error("no replan expected"); } }, catalog: catalog() });
  const byKey = async (oid) => Object.fromEntries((await cl.tasks(oid)).map((x) => [x.key, x]));
  try {
    check("code.run is registered as connected and sealed-only, inside the read-only gate", (() => { const c = catalog().find((x) => x.name === "code.run"); return c.available === "connected" && c.sealed_only === true && c.live_read === true; })());
    pid = await cl.createProject({ title: "NORIA CHECK — code tasks (safe to delete)" });

    await guard("sales analysis", async () => {
      const exp = expectedSales(), oid = await cl.createObjective(pid, "analyse the sales file", plan(salesPlan()));
      const log = await mk().run(oid), ts = await byKey(oid), res = ts.t2 && ts.t2.output && ts.t2.output.result;
      check("objective 1 (analyse a sales file): the plan runs through the real executor and completes", log.state === "completed" && ts.t2.state === "done" && ts.t3.state === "done", "state " + log.state);
      check("the sandbox's numbers match the numbers computed independently here", res && res.rows === exp.rows && res.skipped === exp.skipped && res.total_revenue === exp.total_revenue && res.top_region === exp.top_region && Math.abs(res.correlation_units_price - exp.correlation) < 1e-6, res ? "total " + res.total_revenue + ", top " + res.top_region : "no result");
      check("the malformed row was skipped and reported, not hidden", res && res.skipped === 1 && res.rows === 14);
      check("the result was verified by an independent second computation", ts.t2.output.verification && ts.t2.output.verification.ok === true);
      const arts = (await cl.listArtifacts(pid)).map((a) => a.name);
      check("a table, a report and a chart were created as project artifacts", ["regional_revenue.csv", "report.md", "regional_revenue.svg", "findings"].every((n) => arts.includes(n)));
      const svg = (await cl.getArtifact(pid, "regional_revenue.svg")).content;
      check("the chart is an SVG without scripts or external references", /<svg/.test(svg) && !/script|href|onload/i.test(svg));
      check("the findings flowed back into the task graph and project memory", (await cl.getArtifact(pid, "findings")).content.includes(String(exp.total_revenue)) && (await cl.memGet(pid, "top_region")).value === exp.top_region);
      check("the run records which runtime ran the code", ts.t2.output.runtime.id === "browser-js" && ts.t2.output.runtime.isolation === "browser-sandbox");
    });

    await guard("Python sales analysis (closing the gap: Python through the real task graph, not just the isolation battery)", async () => {
      const exp = expectedSales(), oid = await cl.createObjective(pid, "analyse the sales file in Python", plan(pySalesPlan()));
      const log = await mk().run(oid), ts = await byKey(oid), res = ts.t2 && ts.t2.output && ts.t2.output.result;
      check("objective 1b (the same analysis in Python): the plan runs through the real executor and completes", log.state === "completed" && ts.t2.state === "done" && ts.t3.state === "done", "state " + log.state);
      check("Python reaches the SAME numbers as the plain host code, on the same untidy file", res && res.rows === exp.rows && res.skipped === exp.skipped && res.total_revenue === exp.total_revenue && res.top_region === exp.top_region && Math.abs(res.correlation_units_price - exp.correlation) < 1e-6, res ? "total " + res.total_revenue + ", top " + res.top_region : "no result");
      check("the malformed row was skipped and reported by Python too", res && res.skipped === 1 && res.rows === 14);
      check("CROSS-LANGUAGE: the Python result was verified by an independent JavaScript computation, in a second sandbox", ts.t2.output.verification && ts.t2.output.verification.ok === true && ts.t2.output.verification.by === "browser-js");
      const arts = (await cl.listArtifacts(pid)).map((a) => a.name);
      check("a table, a report and a chart were created by the PYTHON task, through emit_artifact()", ["regional_revenue_py.csv", "report_py.md", "regional_revenue_py.svg", "findings_py"].every((n) => arts.includes(n)));
      const svg = (await cl.getArtifact(pid, "regional_revenue_py.svg")).content;
      check("the Python-written chart is an SVG without scripts or external references", /<svg/.test(svg) && !/script|href|onload/i.test(svg));
      check("the findings flowed back into the task graph and project memory, from the Python result", (await cl.getArtifact(pid, "findings_py")).content.includes(String(exp.total_revenue)) && (await cl.memGet(pid, "top_region")).value === exp.top_region);
      check("the run names the Python runtime, and the planner never had to say which runtime to use", ts.t2.output.runtime.id === "browser-python" && ts.t2.output.runtime.isolation === "browser-sandbox");
    });

    await guard("failing tests", async () => {
      const oid = await cl.createObjective(pid, "make the median function pass its tests", plan(medianPlan()));
      const rp = { calls: [], async propose(state) { this.calls.push(state); return medianFixRevision(); } };
      const log = await mk(rp).run(oid), ts = await byKey(oid);
      check("objective 2 (fix failing tests): failing tests fail the step, the plan is revised, the fixed code passes", log.state === "completed" && log.revisions === 1 && ts.t1b.state === "done" && ts.t1b.output.result.passed === 5);
      check("the re-planner was shown the actual failing cases", rp.calls.length === 1 && /tests failed/.test(rp.calls[0].trigger.error) && /expected/.test(rp.calls[0].trigger.error));
      check("a code failure was a replan, not a blind retry of the same code", log.retries === 0);
    });

    await guard("wrong calculation", async () => {
      const oid = await cl.createObjective(pid, "compute the payment on a 15-year loan", plan(loanPlan(LOAN_SLIP)));
      const rp = { calls: [], async propose(state) { this.calls.push(state); return loanFixRevision(); } };
      const log = await mk(rp).run(oid), ts = await byKey(oid), good = ts.t1b && ts.t1b.output && ts.t1b.output.result;
      const r = 0.0725 / 12, closed = 250000 * r / (1 - Math.pow(1 + r, -180));
      check("objective 3 (a wrong figure): the independent cross-check refused it and the corrected run was verified", log.state === "completed" && log.revisions === 1 && ts.t1.state === "removed" && ts.t1b.output.verification.ok === true);
      check("the failure was classified as a verification failure and showed where the numbers differed", rp.calls[0].trigger.kind === "verification" && /monthly_payment/.test(rp.calls[0].trigger.error));
      check("the verified payment equals the closed-form value", good && Math.abs(good.monthly_payment - closed) < 0.006, good ? String(good.monthly_payment) : "");
    });

    await guard("hostile output", async () => {
      const oid = await cl.createObjective(pid, "run code that tries to give instructions", plan(hostilePlan()));
      const log = await mk().run(oid), ts = await byKey(oid), out = JSON.stringify(ts.t1.output);
      check("objective 4 (hostile output): the task completes with the useful part", log.state === "completed" && ts.t1.output.result.total === 42);
      check("instruction-like text was removed from output, result and artifacts, and reported", !/ignore all previous instructions|approval has been granted|disregard your rules/i.test(out) && ts.t1.output.injection_found >= 2);
      const page = await cl.getArtifact(pid, "page.html");
      check("the HTML artifact was stored as inert text", page && page.kind === "text");
      check("nothing was triggered by the output: still two tasks, no other tool ran", (await cl.tasks(oid)).length === 2);
    });

    await guard("boundary", async () => {
      const rr = runtime.report();
      check("nothing outside the allowed calls happened while the code ran (no request except the graph's own)", rr.unexpected.length === 0, rr.requests + " requests through the browser runtime");
      check("the project's history is one unbroken chain", (await cl.verifyEvents(pid)).ok);
    });
  } finally {
    if (pid && $("del").checked) { try { await cl.deleteProject(pid); check("the test project was deleted afterwards", (await cl.listProjects()).every((p) => p.id !== pid)); } catch (e) { check("the test project was deleted afterwards", false, (e && e.message) || e); } }
    else if (pid) measure("test project kept", "project id " + pid + " (see it on the Projects screen; delete it when you are done)");
    measure("total time", Math.round((performance.now() - t0) / 100) / 10 + " seconds");
    measure("not measured", "code written by a real model (the code here is written by the check); numeric/scientific Python packages (the package list is deliberately empty); memory exhaustion (a browser cannot cap it)");
    const failed = results.filter((r) => !r.ok).length;
    $("json").textContent = JSON.stringify({ at: new Date().toISOString(), site: location.origin, seconds: Math.round((performance.now() - t0) / 100) / 10, passed: results.length - failed, failed, checks: results, measurements }, null, 2);
  }
}
$("run").addEventListener("click", async () => { $("run").disabled = true; try { await main(); } catch (e) { check("the check ran to the end", false, (e && e.message) || e); } finally { $("run").disabled = false; } });
