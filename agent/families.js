// NORIA CAPABILITY FAMILIES — Target, Implemented, Verified.
//
// Noria and Noria Pro are meant to be general-purpose: able to take almost any legitimate objective, plan it, use tools, produce work,
// verify it, recover, and continue over time. The tests are instruments that measure the machine; they are NOT the definition of it.
// So every capability carries three separate facts:
//
//   target       what Noria is meant to be able to do (always true here: this list is the ambition, not a claim)
//   implemented  what has actually been built:     none | architecture | foundation | partial | yes
//   verified     what has been tested for real:    none | component | read_only | real_runtime
//
//   architecture  designed only            foundation  the mechanism exists but the capability is not usable yet
//   partial       usable with clear limits  yes          built and usable as described
//   component     a part is tested in isolation (offline or by script)
//   read_only     exercised in the real runtime, reading only, with a side-effect audit
//   real_runtime  exercised end to end in the real environment
//
// `via` names what it rests on: registry tools ("tool:web.search"), server routes ("route:/brain/research") or app modules ("app:dataeng.js").
// `evidence` names what verifies it: test files in noria-eval/, "live: ..." (a recorded real run) or "manual: ..." (by hand, not repeatable).
// `gap` says plainly what is missing. Rules that keep this honest are enforced by families_t.mjs against the tool registry.

export const IMPLEMENTED = ["none", "architecture", "foundation", "partial", "yes"];
export const VERIFIED = ["none", "component", "read_only", "real_runtime"];

const C = (id, name, implemented, verified, via, evidence, gap) => ({ id, name, target: true, implemented, verified, via: via || [], evidence: evidence || [], gap: gap || "" });

export const FAMILIES = [
  { id: "intelligence", name: "Intelligence and reasoning", capabilities: [
    C("reasoning", "Complex reasoning and multi-step problem solving", "partial", "component", ["route:/brain/ask"], ["bench.mjs", "audit.mjs"], "No general chain-of-thought verifier; logic questions get a form check."),
    C("decompose", "Planning and task decomposition", "foundation", "component", ["route:/brain/plan"], ["planner_t.mjs", "live: models planned five unseen objectives, validated against the registry"], "Read-only planner; plans are not persisted or revised over time."),
    C("uncertainty", "Uncertainty and hallucination management", "partial", "component", ["route:/brain/ask"], ["bench.mjs", "office_evidence_t.mjs", "temporal_t.mjs"], "No calibrated confidence; relies on refusals and fact checks."),
    C("contradiction", "Contradiction detection across sources", "architecture", "none", [], [], "Not built."),
    C("decision", "Decision support and hypothesis generation", "partial", "none", ["route:/brain/ask"], [], "Model answers only; not evaluated."),
  ] },
  { id: "research", name: "Research", capabilities: [
    C("web-research", "Live web research and current information", "yes", "real_runtime", ["tool:web.search"], ["feeds_t.mjs", "worker_int_t.mjs", "search_layer_t.mjs"], "The open-web provider is out of allowance (HTTP 432): coverage is degraded to Wikipedia and news feeds."),
    C("deep-research", "Deep research reports with citations (Noria Pro)", "yes", "real_runtime", ["tool:research.deep"], ["manual: research_live.py, one real Pro brief"], "A few briefs a day; depends on the open web; not automated."),
    C("temporal", "Temporal reasoning (latest, next, last year)", "yes", "component", ["route:/brain/ask"], ["temporal_t.mjs", "office_evidence_t.mjs"], ""),
    C("citation", "Source citation and verification", "partial", "component", ["route:/brain/ask", "app:rag.js"], ["rag_t.mjs", "verify_t.mjs"], "Citation checks exist in the RAG module, which is not connected."),
    C("academic", "Academic literature research", "none", "none", [], [], "No academic sources connected."),
    C("longitudinal", "Monitoring a topic over time", "none", "none", [], [], "Needs background execution."),
  ] },
  { id: "agentic", name: "Agentic execution", capabilities: [
    C("agent-plan", "Autonomous task planning", "foundation", "component", ["route:/brain/plan"], ["planner_t.mjs"], "Plans one objective at a time."),
    C("agent-exec-seq", "Sequential and parallel execution of a plan", "foundation", "read_only", ["tool:web.search", "tool:calc.math"], ["executor_t.mjs", "executor_live_t.mjs", "live: real browser runs, side-effect audit clean"], "Read-only tools only; not connected to the app screen."),
    C("agent-recovery", "Retries, alternatives, recovery, cancellation", "foundation", "component", ["app:agent/executor.js"], ["executor_t.mjs"], "Only three alternatives are declared."),
    C("agent-approval", "Human approval gates", "foundation", "component", ["app:agent/executor.js", "app:agent/gate.js"], ["executor_t.mjs", "executor_live_t.mjs"], "No acting tool exists to gate yet."),
    C("agent-audit", "Tamper-evident audit trail", "foundation", "component", ["app:agent/audit.js"], ["executor_t.mjs"], "Held in memory; not persisted."),
    C("browser-op", "Operating a browser or websites", "none", "none", ["tool:browser.navigate"], [], "Not built."),
    C("automation", "Workflow automation", "none", "none", [], [], "Not built."),
    C("background", "Background, scheduled and long-running tasks", "none", "none", [], [], "Not built; no persistent task state."),
  ] },
  { id: "documents", name: "Documents", capabilities: [
    C("doc-read", "Reading PDF, Word, text, CSV and Excel files", "yes", "component", ["tool:doc.read", "tool:data.query"], ["docread_t.mjs", "data/test-data.mjs"], "Long-document retrieval is keyword-based; the RAG pipeline is not connected."),
    C("doc-ocr", "Scanned documents and photo text (OCR)", "partial", "none", ["app:workspace.js"], [], "On-device photo text only; scanned PDFs not supported."),
    C("doc-generate", "Generating and exporting Word, Excel, PowerPoint and PDF", "yes", "none", ["tool:doc.export"], ["manual: browser"], "Libraries load from a CDN; no automated test."),
    C("doc-multi", "Analysing many documents together", "none", "none", ["tool:knowledge.search"], [], "Needs a knowledge store."),
    C("doc-forms", "Contracts, invoices and forms as structured data", "partial", "none", ["route:/brain/ask"], [], "Model reading only."),
  ] },
  { id: "coding", name: "Coding and software engineering", capabilities: [
    C("code-write", "Writing code", "yes", "component", ["route:/brain/ask"], ["bench.mjs"], "Written, not run."),
    C("code-debug", "Debugging and refactoring", "partial", "none", ["route:/brain/ask"], [], "Cannot run or test the code."),
    C("code-run", "Running and testing code in a sandbox", "none", "none", ["tool:code.run"], [], "Not built."),
    C("code-repo", "Repositories and deployment workflows", "none", "none", [], [], "Not built."),
    C("code-security", "Security analysis", "none", "none", [], [], "Not built."),
  ] },
  { id: "data", name: "Data intelligence", capabilities: [
    C("data-tables", "Exact spreadsheet and CSV analysis", "yes", "component", ["tool:data.query"], ["data/test-data.mjs (1,200 rows against pandas)"], "Runs on the device; very large files untested."),
    C("data-stats", "Statistics and modelling", "partial", "none", ["tool:data.query"], [], "Counts, means, medians, correlation only."),
    C("data-viz", "Charts and tables", "yes", "none", ["tool:chart.draw"], ["manual: browser"], "Chart library loads from a CDN; no automated test."),
    C("data-sql", "SQL and databases", "none", "none", ["tool:sql.query"], [], "Not built."),
    C("data-forecast", "Forecasting, anomaly detection, dashboards", "none", "none", [], [], "Not built."),
  ] },
  { id: "creation", name: "Creation", capabilities: [
    C("create-text", "Writing, translation and educational material", "yes", "component", ["route:/brain/ask"], ["bench.mjs"], "Quality is not measured beyond the benchmark's language checks."),
    C("create-image", "Image creation", "partial", "none", ["tool:image.generate"], [], "Depends on a small daily allowance; often unavailable."),
    C("create-slides", "Presentations", "yes", "none", ["tool:doc.export"], ["manual: browser"], "See exports."),
    C("create-web", "Websites and applications", "partial", "none", ["route:/brain/ask"], [], "Produces code as text; cannot build, run or deploy it."),
    C("create-av", "Audio and video workflows", "none", "none", [], [], "Not built."),
  ] },
  { id: "multimodal", name: "Multimodal", capabilities: [
    C("vision", "Understanding photos and images (Noria Pro)", "partial", "none", ["tool:vision.describe"], [], "Depends on the same daily allowance; untested by script."),
    C("speech", "Speech in and out (Noria Pro)", "partial", "none", ["tool:speech.speak"], [], "Depends on the daily allowance; untested by script."),
    C("video", "Video understanding", "none", "none", [], [], "Not built."),
    C("visual-reasoning", "Charts, diagrams and screenshots", "none", "none", [], [], "Not built."),
  ] },
  { id: "business", name: "Business", capabilities: [
    C("biz-research", "Market and competitor research", "partial", "none", ["tool:web.search", "tool:research.deep"], [], "Rests on web research, which is degraded."),
    C("biz-docs", "Plans, proposals and structured business documents", "yes", "none", ["route:/brain/ask"], [], "Guided document flows; not measured."),
    C("biz-finance", "Financial analysis and modelling", "partial", "none", ["tool:data.query"], [], "Basic figures only."),
    C("biz-ops", "Operations, sales, procurement and customer workflows", "none", "none", [], [], "Needs connectors and automation."),
  ] },
  { id: "productivity", name: "Personal productivity", capabilities: [
    C("prod-memory", "Remembering what you share (on your device)", "yes", "component", ["tool:memory.device"], ["memory_t.mjs"], "Facts only; no projects or tasks."),
    C("prod-travel", "Travel and visa preparation guidance", "partial", "none", ["route:/brain/ask"], [], "Guidance from general knowledge and web research."),
    C("prod-calendar-email", "Email, calendar and reminders", "none", "none", ["tool:email.send", "tool:calendar.create"], [], "Not built; needs your own account connections and approval gates."),
    C("prod-projects", "Notes, tasks and projects", "none", "none", [], [], "Not built."),
  ] },
  { id: "long-term", name: "Long-term intelligence", capabilities: [
    C("lt-project", "Projects with objectives, tasks and progress", "foundation", "component", ["route:/graph/op", "app:agent/graph-store.js"], ["graph_t.mjs", "graph_api_t.mjs"], "Store, state machine and runner are built and tested on a local D1 and SQLite; no screen, not connected to the planner route, and never run in production with a real account."),
    C("lt-graph", "Persistent task graphs with a state machine", "foundation", "component", ["app:agent/graph.js", "app:agent/graph-store.js"], ["graph_t.mjs"], "Tested offline and over HTTP on a local D1; production has the tables and the routes but no real use yet."),
    C("lt-dataflow", "Data flowing from one step to the next", "foundation", "component", ["app:agent/graph.js"], ["graph_t.mjs", "calc_t.mjs"], "Plans can reference earlier outputs, memory and artifacts; the planner is told how, but a real planner run using it has not been checked."),
    C("lt-resume", "Resuming after an interruption without repeating work", "foundation", "component", ["app:agent/graph-runner.js", "app:agent/graph-store.js"], ["graph_t.mjs", "graph_api_t.mjs"], "Lease recovery and a persistent idempotency ledger are tested with simulated crashes; not yet exercised by a real interrupted run."),
    C("lt-artifacts", "Versioned artifacts produced by steps", "foundation", "component", ["app:agent/graph-store.js"], ["graph_t.mjs"], "Only text and JSON up to 200 KB; no tool produces one yet."),
    C("lt-memory", "Project memory and decisions (viewable, correctable, deletable)", "foundation", "component", ["app:agent/graph-store.js"], ["graph_t.mjs", "graph_api_t.mjs"], "Keyword retrieval only; nothing writes to it automatically yet."),
    C("lt-history", "A persistent, tamper-evident history linked to tasks and attempts", "foundation", "component", ["app:agent/graph-store.js"], ["graph_t.mjs"], "Detects changes and removals; not signed, so it cannot prove who made the database."),
    C("lt-continue", "Continuing an objective as new information arrives", "architecture", "none", [], [], "Schedules can be stored and read; nothing revises a graph from new information or runs in the background."),
    C("lt-knowledge", "Knowledge bases with hybrid retrieval", "foundation", "component", ["tool:knowledge.search", "app:rag.js"], ["rag_t.mjs"], "Written and tested offline; not connected to an embedding service or the production document path."),
  ] },
  { id: "reliability", name: "Reliability and control", capabilities: [
    C("rel-verify", "Verifying answers against sources before showing them", "yes", "real_runtime", ["route:/brain/ask"], ["bench.mjs", "audit.mjs", "live-check.mjs"], "Weaker while web search is degraded."),
    C("rel-health", "Honest health and capability reporting", "yes", "real_runtime", ["route:/brain/capabilities", "route:/brain/tools"], ["search_layer_t.mjs", "worker_int_t.mjs", "tools_state_t.mjs"], ""),
    C("rel-safety", "Permissions and a read-only gate that no runtime can bypass", "yes", "real_runtime", ["tool:web.search"], ["executor_live_t.mjs", "feeds_t.mjs"], "Only read-only execution is authorised."),
    C("rel-eval", "Evaluation on unseen tasks", "architecture", "none", [], [], "Designed (held-out generated tasks); the current benchmark is a regression check, not a measure of generality."),
  ] },
];

// The rules that keep the three facts honest. tools: the registry as { name: { state } } (from listTools).
export function validateFamilies(families, toolStates, fileExists) {
  const problems = [], ids = new Set();
  const rank = (arr, v) => arr.indexOf(v);
  for (const f of families) for (const c of f.capabilities) {
    const at = f.id + "/" + c.id;
    if (ids.has(c.id)) problems.push(at + ": duplicate id"); ids.add(c.id);
    if (c.target !== true) problems.push(at + ": target must be true (the list is the ambition)");
    if (!IMPLEMENTED.includes(c.implemented)) problems.push(at + ": bad implemented level");
    if (!VERIFIED.includes(c.verified)) problems.push(at + ": bad verified level");
    if (c.verified !== "none" && ["none", "architecture"].includes(c.implemented)) problems.push(at + ": cannot be verified when only " + c.implemented);
    if (c.verified !== "none" && !c.evidence.length) problems.push(at + ": verified without evidence");
    if (c.verified === "none" && c.evidence.some((e) => !/^manual:/i.test(e))) problems.push(at + ": lists evidence but says not verified");
    if (["read_only", "real_runtime"].includes(c.verified) && !c.evidence.some((e) => /^live:|^manual:|feeds_t|executor_live_t|worker_int_t|live-check|audit\.mjs|bench\.mjs/.test(e))) problems.push(at + ": " + c.verified + " needs a real-runtime run as evidence");
    if (c.implemented !== "none" && c.implemented !== "architecture" && !c.via.length) problems.push(at + ": implemented but does not say what it rests on (via)");
    if (["partial", "yes"].includes(c.implemented) && !c.gap && c.implemented === "partial") problems.push(at + ": partial must say what is missing (gap)");
    // never above what the tool registry allows
    const tools = c.via.filter((v) => v.startsWith("tool:")).map((v) => v.slice(5));
    for (const n of tools) if (!(n in toolStates)) problems.push(at + ": unknown tool " + n);
    const known = tools.filter((n) => n in toolStates);
    if (known.length && known.every((n) => toolStates[n] === "not_built") && !["none", "architecture"].includes(c.implemented) && !c.via.some((v) => v.startsWith("route:") || v.startsWith("app:"))) problems.push(at + ": every tool it rests on is not built, so it cannot be " + c.implemented);
    for (const e of c.evidence) if (!/^(manual|live):/i.test(e)) { const file = e.replace(/\s*\(.*$/, "").trim(); if (fileExists && !fileExists(file)) problems.push(at + ": evidence file not found: " + file); }
  }
  return problems;
}

// Plain language for every capability, so "Target: true" can never be misread as "Noria has this". The three facts are shown as words.
const IMPL_TEXT = { none: "Not built", architecture: "Designed only", foundation: "Foundation built, not usable yet", partial: "Usable, with limits", yes: "Built and usable" };
const VER_TEXT = { none: "Not tested", component: "Parts tested in isolation", read_only: "Exercised in the real runtime, reading only", real_runtime: "Exercised end to end in the real environment" };
export function explainCapability(c) {
  const has = ["partial", "yes"].includes(c.implemented);
  return {
    target_capability: "Target capability: what Noria is meant to become. This is NOT a claim that Noria has it.",
    implemented: IMPL_TEXT[c.implemented],
    verified: VER_TEXT[c.verified],
    today: has ? "Noria has this today" + (c.gap ? ", with limits: " + c.gap : ".") : "Noria does NOT have this today" + (c.implemented === "none" ? "." : c.implemented === "architecture" ? " (only designed)." : " (a foundation exists but it is not usable yet)."),
  };
}
export function explainFamilies(families) { return families.map((f) => ({ ...f, capabilities: f.capabilities.map((c) => ({ ...c, plain: explainCapability(c) })) })); }
// The summary shown to the owner: how many of the target capabilities are implemented, and how many verified, at each level.
export function summarizeFamilies(families) {
  const all = families.flatMap((f) => f.capabilities), by = (key, levels) => Object.fromEntries(levels.map((l) => [l, all.filter((c) => c[key] === l).length]));
  return { families: families.length, capabilities: all.length, target: all.length, implemented: by("implemented", IMPLEMENTED), verified: by("verified", VERIFIED),
    per_family: families.map((f) => ({ id: f.id, name: f.name, capabilities: f.capabilities.length, implemented_usable: f.capabilities.filter((c) => ["partial", "yes"].includes(c.implemented)).length, verified_any: f.capabilities.filter((c) => c.verified !== "none").length })),
    meaning: "Target is what Noria is meant to become. Implemented is what has been built. Verified is what has been tested for real. The tests measure the machine; they do not define what Noria can do." };
}
