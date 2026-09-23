// NORIA TOOL REGISTRY.
//
// Every capability the agent may use is a tool with a full declaration. Connectors (email, calendar, maps, cloud storage, browser,
// outside APIs) are added as more entries in this same list; the planner and executor never learn about them individually.
//
//   name, description
//   input / output      small JSON-schema-style shapes: { field: { type, required?, description? } }
//   auth                "none" | "pro" (Noria Pro code) | "account" (signed in) | "oauth" (the user's own outside account)
//   permissions         what it touches: "read", "write", "network", "device", "account"
//   state               base state: live | connected | degraded | requires_auth | not_built | unsupported
//   need                the runtime dependency whose health decides availability (search | feeds | ai | accounts | null)
//   risk                "read" (no side effects) | "write" (changes something outside Noria; always behind an approval gate)
//   timeoutMs, retry    { max, backoffMs }
//   verify              how a result is checked: "sources" | "exact" | "schema" | "temporal" | "user"
//   runtime             where it runs: ["server"], ["browser"] or both
//
// States follow the capability registry. UNCERTAIN and CONFLICT describe an answer, not a tool.

export const REGISTRY_VERSION = "2026-09-21.4";

const T = (o) => Object.assign({ id: o.name, version: "1.0.0", dependencies: [], provider: "noria", tests: [], alternatives: [], live_read: false, auth: "none", permissions: ["read"], state: "live", need: null, risk: "read", timeoutMs: 10000, retry: { max: 0, backoffMs: 0 }, verify: "schema", runtime: ["server"] }, o);

export const TOOLS = [
  // ── information (read-only) ──
  T({ name: "web.search", description: "Search the open web, Wikipedia and news feeds for current information; returns dated, ranked, de-duplicated sources with provenance.",
    input: { query: { type: "string", required: true }, fresh: { type: "boolean" } }, output: { sources: { type: "array", description: "title, snippet, url, date, provider" } },
    permissions: ["read", "network"], state: "connected", need: "search", timeoutMs: 20000, retry: { max: 1, backoffMs: 300 }, verify: "temporal", live_read: true }),
  T({ name: "research.deep", description: "Plan several search angles, read the sources and write a cited brief with unsupported sentences removed (Noria Pro, a few a day).",
    input: { topic: { type: "string", required: true } }, output: { brief: { type: "string" }, sources: { type: "array" } },
    auth: "pro", permissions: ["read", "network"], state: "connected", need: "search", timeoutMs: 110000, verify: "sources" }),
  T({ name: "clock.now", description: "Exact date, time, weekday and days until or since a date, for any place; calculated, never guessed.",
    input: { question: { type: "string", required: true } }, output: { answer: { type: "string" } }, verify: "exact", live_read: true }),
  T({ name: "calc.math", description: "Exact arithmetic and percentages, computed by a calculator rather than estimated by a model.",
    input: { expression: { type: "string", required: true } }, output: { value: { type: "number" }, answer: { type: "string" } }, verify: "exact", live_read: true }),
  T({ name: "weather.get", description: "Current temperature for a place, verified across an official meteorological service and a weather model; states when they disagree or are out of date instead of guessing.", input: { place: { type: "string", required: true } }, output: { report: { type: "string" }, value: { type: "number" }, unit: { type: "string" }, status: { type: "string" }, as_of: { type: "string" }, evidence: { type: "object" } },
    permissions: ["read", "network"], state: "connected", need: "feeds", timeoutMs: 15000, retry: { max: 1, backoffMs: 300 }, verify: "schema", live_read: true }),
  T({ name: "fx.rate", description: "Daily reference exchange rate between two currencies, cross-checked across independent feeds (an ECB reference and rate aggregators); refuses to state a rate the sources disagree on or that is out of date.", input: { from: { type: "string", required: true }, to: { type: "string", required: true } },
    output: { report: { type: "string" }, value: { type: "number" }, unit: { type: "string" }, status: { type: "string" }, as_of: { type: "string" }, evidence: { type: "object" } }, permissions: ["read", "network"], state: "connected", need: "feeds", timeoutMs: 15000, retry: { max: 1, backoffMs: 300 }, verify: "schema", live_read: true }),
  T({ name: "crypto.price", description: "Current cryptocurrency spot price in US dollars, compared across several exchanges; refuses to state a price the exchanges disagree on.", input: { asset: { type: "string", required: true } }, output: { report: { type: "string" }, value: { type: "number" }, unit: { type: "string" }, status: { type: "string" }, as_of: { type: "string" }, evidence: { type: "object" } },
    permissions: ["read", "network"], state: "connected", need: "feeds", timeoutMs: 15000, retry: { max: 1, backoffMs: 300 }, verify: "schema", live_read: true }),
  T({ name: "reference.list", description: "Fixed reference lists quoted from a verified library (for example the 99 Names, countries of Africa).",
    input: { list: { type: "string", required: true } }, output: { answer: { type: "string" } }, verify: "exact", live_read: true }),
  // ── the person's own files and data (run on their device) ──
  T({ name: "doc.read", description: "Read an attached PDF, Word, text, CSV or Excel file and pull out the passages relevant to a question.",
    input: { file: { type: "file", required: true }, question: { type: "string" } }, output: { passages: { type: "array" } },
    permissions: ["read", "device"], runtime: ["browser"], verify: "sources", live_read: true }),
  T({ name: "data.query", description: "Exact analysis of an attached spreadsheet: counts, totals, averages, medians, distinct values, top-N, filters, group-by, correlation.",
    input: { file: { type: "file", required: true }, question: { type: "string", required: true } }, output: { answer: { type: "string" }, table: { type: "object" } },
    permissions: ["read", "device"], runtime: ["browser"], verify: "exact", live_read: true }),
  T({ name: "memory.device", description: "Facts the person chose to share, kept on this device; can be read, corrected and deleted by them.",
    input: { key: { type: "string" } }, output: { value: { type: "string" } }, permissions: ["read", "device"], runtime: ["browser"], verify: "user" }),
  // ── senses and creation ──
  T({ name: "vision.describe", description: "Understand a photo or image (Noria Pro). Does not identify real people from faces.", input: { image: { type: "file", required: true }, prompt: { type: "string" } },
    output: { description: { type: "string" } }, auth: "pro", permissions: ["read", "network"], state: "connected", need: "ai", timeoutMs: 30000, verify: "user" }),
  T({ name: "image.generate", description: "Create a picture from a description; limited by a daily allowance; never realistic pictures of real people.", input: { prompt: { type: "string", required: true } },
    output: { image: { type: "file" } }, auth: "pro", permissions: ["network"], state: "connected", need: "ai", timeoutMs: 60000, verify: "user" }),
  T({ name: "speech.speak", description: "Speak text aloud in Noria's voice (Noria Pro).", input: { text: { type: "string", required: true } }, output: { audio: { type: "file" } },
    auth: "pro", permissions: ["network"], state: "connected", need: "ai", timeoutMs: 20000, verify: "user" }),
  T({ name: "doc.export", description: "Turn a finished document into Word, Excel, PowerPoint, PDF or Markdown.", input: { markdown: { type: "string", required: true }, format: { type: "string", required: true } },
    output: { file: { type: "file" } }, permissions: ["device"], state: "connected", runtime: ["browser"], verify: "user" }),
  T({ name: "chart.draw", description: "Draw a chart or table from data.", input: { data: { type: "object", required: true }, kind: { type: "string" } }, output: { chart: { type: "object" } },
    state: "connected", runtime: ["browser"], verify: "schema" }),
  // ── the project's own store: artifacts and notes (nothing outside Noria changes; the person can view, correct and delete them) ──
  T({ name: "artifact.write", description: "Save a document, dataset or result as a versioned artifact in the project (older versions are kept).", input: { name: { type: "string", required: true }, kind: { type: "string" }, content: { type: "string", required: true, multiline: true, maxChars: 20000 } },
    output: { artifact: { type: "object" } }, permissions: ["read", "internal"], runtime: ["graph"], verify: "schema", live_read: true }),
  T({ name: "artifact.read", description: "Read an artifact saved earlier in the project (the latest version, or a named one).", input: { name: { type: "string", required: true }, version: { type: "number" } },
    output: { content: { type: "string" }, version: { type: "number" } }, permissions: ["read", "internal"], runtime: ["graph"], verify: "schema", live_read: true }),
  T({ name: "project.note", description: "Remember a fact for the rest of the project (project memory); the person can correct or delete it.", input: { key: { type: "string", required: true }, value: { type: "string", required: true } },
    output: { saved: { type: "boolean" } }, permissions: ["read", "internal"], runtime: ["graph"], verify: "schema", live_read: true }),
  // ── knowledge (built in stages) ──
  T({ name: "knowledge.search", description: "Hybrid (vector plus keyword) retrieval over the person's documents and knowledge bases, with reranking and citation checks.",
    input: { query: { type: "string", required: true }, collection: { type: "string" }, k: { type: "number" } }, output: { passages: { type: "array" }, mode: { type: "string" } },
    state: "not_built", need: "ai", permissions: ["read", "internal"], runtime: ["browser"], timeoutMs: 20000, retry: { max: 1, backoffMs: 300 }, verify: "sources", live_read: true }),
  // ── not built yet: declared so the planner can say exactly what is missing ──
  // code.run: ONE capability behind which isolated runtimes stand (agent/code-exec.js). Running code INSIDE the sealed boundary is authorised by the owner without
  // per-run approval. Everything outside it (network, files, credentials, packages, OS, real-world effects) is a separate authority the tool never grants.
  T({ name: "code.run", description: "Run code (JavaScript today; Python next) in a sealed, isolated sandbox: no network, no files, no access to the page or session, hard time limit. Returns output, a result, verified artifacts (tables, reports, charts as text/CSV/JSON/SVG) and which runtime ran it. Use a cross-check (an independent second computation) to verify calculations.",
    input: { code: { type: "string", required: true, multiline: true, maxChars: 20000 }, language: { type: "string" }, input: { type: "object", maxChars: 20000 }, timeout_ms: { type: "number" }, crosscheck: { type: "object", maxChars: 10000 }, needs: { type: "array" } },
    output: { stdout: { type: "string" }, result: { type: "any" }, duration_ms: { type: "number" }, language: { type: "string" }, truncated: { type: "boolean" }, runtime: { type: "object" }, untrusted: { type: "boolean" } }, state: "connected", permissions: ["compute", "internal"], runtime: ["browser"], risk: "read", sealed_only: true, timeoutMs: 40000, verify: "schema", live_read: true }),
  T({ name: "sql.query", description: "Run a read-only SQL query against a connected database.", input: { query: { type: "string", required: true } }, output: { rows: { type: "array" } },
    state: "not_built", auth: "oauth", permissions: ["read", "network"], verify: "exact" }),
  T({ name: "browser.navigate", description: "Open a web page and read or interact with it.", input: { url: { type: "string", required: true } }, output: { content: { type: "string" } },
    state: "not_built", permissions: ["read", "network"], verify: "sources" }),
  T({ name: "maps.route", description: "Distance, travel time and directions between places.", input: { from: { type: "string", required: true }, to: { type: "string", required: true } },
    output: { route: { type: "object" } }, state: "not_built", auth: "oauth", permissions: ["read", "network"], verify: "schema" }),
  T({ name: "email.send", description: "Send an email from the person's own account.", input: { to: { type: "string", required: true }, subject: { type: "string", required: true }, body: { type: "string", required: true } },
    output: { sent: { type: "boolean" } }, state: "not_built", auth: "oauth", permissions: ["write", "account", "network"], risk: "write", verify: "user" }),
  T({ name: "calendar.create", description: "Create a calendar event in the person's own calendar.", input: { title: { type: "string", required: true }, start: { type: "string", required: true } },
    output: { created: { type: "boolean" } }, state: "not_built", auth: "oauth", permissions: ["write", "account", "network"], risk: "write", verify: "user" }),
  T({ name: "files.save", description: "Save a file to the person's own cloud storage.", input: { name: { type: "string", required: true }, content: { type: "string", required: true } },
    output: { saved: { type: "boolean" } }, state: "not_built", auth: "oauth", permissions: ["write", "account", "network"], risk: "write", verify: "user" }),
  T({ name: "api.call", description: "Call an outside API that the person has connected and authorised.", input: { connection: { type: "string", required: true }, request: { type: "object", required: true } },
    output: { response: { type: "object" } }, state: "not_built", auth: "oauth", permissions: ["write", "network"], risk: "write", verify: "schema" }),
];


// ── canonical record details: provider, what it depends on, the tests that cover it, and what may replace it when it fails ──
// tests: file names in noria-eval/ (automated) or "manual: ..." (checked by hand, not repeatable). A tool may be LIVE only if it lists a test.
const META = {
  "web.search":       { provider: "search provider registry (tavily, brave, wikipedia, news feeds)", dependencies: ["search"], tests: ["search_layer_t.mjs", "worker_int_t.mjs", "temporal_t.mjs", "bench.mjs (current)"] },
  "research.deep":    { provider: "search provider registry + model", dependencies: ["search", "models"], tests: ["manual: research_live.py"] },
  "clock.now":        { provider: "worker (calculated)", tests: ["clockdirect_t.mjs", "bench.mjs (current)"] },
  "calc.math":        { provider: "worker (exact calculator and a safe expression parser, no eval)", tests: ["calc_t.mjs", "bench.mjs (math)", "live-check-2.mjs"] },
  "weather.get":      { provider: "MET Norway (official) + Open-Meteo, verified by agent/reality.js", dependencies: ["feeds"], tests: ["feeds_t.mjs (live)", "reality_t.mjs", "reality_feeds_t.mjs"] },
  "fx.rate":          { provider: "ECB reference + open.er-api + currency-api, verified by agent/reality.js", dependencies: ["feeds"], tests: ["feeds_t.mjs (live)", "bench.mjs (current: exchange rate)", "reality_t.mjs", "reality_feeds_t.mjs"] },
  "crypto.price":     { provider: "Coinbase, Kraken, Binance, CoinGecko compared by agent/reality.js", dependencies: ["feeds"], tests: ["feeds_t.mjs (live)", "reality_t.mjs", "reality_feeds_t.mjs"] },
  "reference.list":   { provider: "worker (verified library)", tests: ["live-check.mjs", "live-check-2.mjs"] },
  "doc.read":         { provider: "browser (pdf.js parsers, docExcerpts retrieval)", tests: ["docread_t.mjs", "manual: 60-page contract, 3 of 3 questions"] },
  "data.query":       { provider: "browser (dataeng.js)", tests: ["data/test-data.mjs (1,200 rows against pandas)"] },
  "memory.device":    { provider: "browser (localStorage)", tests: ["memory_t.mjs"] },
  "vision.describe":  { provider: "noria-ai worker (Cloudflare Workers AI)", dependencies: ["ai"] },
  "image.generate":   { provider: "noria-ai worker (Cloudflare Workers AI)", dependencies: ["ai"] },
  "speech.speak":     { provider: "noria-ai worker", dependencies: ["ai"] },
  "doc.export":       { provider: "browser (docx, ExcelJS, PptxGenJS, pdfmake, loaded from a CDN)", tests: ["manual: browser"] },
  "chart.draw":       { provider: "browser (Chart.js, loaded from a CDN)", tests: ["manual: browser"] },
  "code.run":         { provider: "isolated runtimes behind one policy (agent/code-exec.js); first runtime: browser JavaScript sandbox (public/sandbox.js)", dependencies: [], tests: ["sandbox_core_t.mjs", "code_exec_t.mjs", "code_e2e_t.mjs", "manual: escape battery in Chrome 152, 34 of 34 (verify-sandbox page)"] },
  "knowledge.search": { provider: "noria-ai worker /kb (D1 + Workers AI embeddings) through the browser runtime", dependencies: ["ai", "accounts"], tests: ["kb_t.mjs", "kb_tool_t.mjs"] },
  "artifact.write":   { provider: "project store (D1) through the graph runtime", tests: ["graph_t.mjs", "control_t.mjs"] },
  "artifact.read":    { provider: "project store (D1) through the graph runtime", tests: ["graph_t.mjs", "control_t.mjs"] },
  "project.note":     { provider: "project store (D1) through the graph runtime", tests: ["graph_t.mjs", "control_t.mjs"] },
};
for (const t of TOOLS) Object.assign(t, META[t.name] || {});
// TEST STATE is separate from TOOL STATE. A tool can be CONNECTED and UNTESTED; it can never be LIVE unless it has an automated test or an
// explicitly accepted production test ("accepted: ..." entries are added only by the owner's decision).
//   automated  a repeatable script in noria-eval/     accepted  the owner accepted a named production test
//   manual     checked by hand, not repeatable         untested  nothing
export function testState(tool) {
  const t = tool.tests || [];
  if (t.some((x) => !/^(manual|accepted):/i.test(x))) return "automated";
  if (t.some((x) => /^accepted:/i.test(x))) return "accepted";
  if (t.some((x) => /^manual:/i.test(x))) return "manual";
  return "untested";
}
const STATES = ["live", "connected", "degraded", "unknown", "requires_auth", "not_built", "unsupported"];
const AUTHS = ["none", "pro", "account", "oauth"];

// A tool declaration must have every field; this is run by the tests and by the server at start-up.
export function validateTool(t) {
  const p = [];
  for (const k of ["id", "name", "description", "input", "output", "auth", "permissions", "state", "risk", "timeoutMs", "retry", "verify", "runtime", "version", "provider", "dependencies", "tests", "alternatives"]) if (t[k] === undefined || t[k] === null || t[k] === "") p.push("missing " + k);
  if (t.state === "live" && !["automated", "accepted"].includes(testState(t))) p.push("a LIVE tool needs an automated or an explicitly accepted test (it has: " + testState(t) + ")");
  if (t.live_read && (t.risk !== "read" || (t.permissions || []).includes("write"))) p.push("only a read-only tool may be marked live_read");
  if (t.id !== t.name) p.push("id must equal name");
  if (!/^[a-z]+\.[a-z_]+$/.test(t.name || "")) p.push("name must look like group.action");
  if (!STATES.includes(t.state)) p.push("bad state " + t.state);
  if (!AUTHS.includes(t.auth)) p.push("bad auth " + t.auth);
  if (!["read", "write"].includes(t.risk)) p.push("bad risk");
  if (t.risk === "write" && !(t.permissions || []).includes("write")) p.push("a write-risk tool must declare the write permission");
  if ((t.permissions || []).includes("write") && t.risk !== "write") p.push("a tool with the write permission must be risk write");
  if (!Array.isArray(t.runtime) || !t.runtime.length || t.runtime.some((r) => !["server", "browser", "graph"].includes(r))) p.push("bad runtime");
  if (typeof t.timeoutMs !== "number" || t.timeoutMs <= 0) p.push("bad timeout");
  return p;
}

// Availability right now: the base state, changed by the health of what it depends on.
// health = { search, feeds, ai, accounts } (booleans; missing means unknown and is treated as healthy)
// health[need] is "ok" (a fresh successful observation), "degraded" (observed failing or out of quota) or "unknown" (no fresh observation).
// Booleans are accepted for older callers (true = ok, false = degraded). A missing value is UNKNOWN: a dependency is never assumed healthy.
export function toolState(tool, health = {}) {
  if (["not_built", "unsupported", "requires_auth"].includes(tool.state)) return tool.state;
  if (!tool.need) return tool.state;
  let h = health[tool.need]; if (h === true) h = "ok"; else if (h === false) h = "degraded"; else if (h !== "ok" && h !== "degraded") h = "unknown";
  return h === "ok" ? tool.state : h;
}

// The tools a plan may use: live, connected or degraded ones. Anything else is reported as missing, never quietly planned.
export const USABLE = new Set(["live", "connected", "degraded"]);
// A read-only tool whose health is unknown may still be TRIED (the attempt is the fresh observation). A tool that acts may not.
export const ATTEMPTABLE = new Set(["live", "connected", "degraded", "unknown"]);
export const canUse = (tool) => (tool.risk === "read" ? ATTEMPTABLE : USABLE).has(tool.available);
export function listTools(health = {}) {
  return TOOLS.map((t) => Object.assign({}, t, { available: toolState(t, health), test_state: testState(t) }));
}
// Two different numbers are reported everywhere, and they mean different things:
//   tools               executable units the agent can call (this registry)
//   capability items    user-facing statements about what Noria can do, grouped by area (CAPS in the worker); several items can rest on one tool
export function registrySummary(health = {}) {
  const tools = listTools(health), by = {};
  for (const t of tools) by[t.available] = (by[t.available] || 0) + 1;
  const cov = { automated: 0, accepted: 0, manual: 0, untested: 0 };
  for (const t of tools) cov[t.test_state]++;
  return { tools: tools.length, by_state: by, test_coverage: cov, live_read_tools: tools.filter((t) => t.live_read).map((t) => t.name), note: "tools are executable units; capability items are user-facing statements and are counted separately (see /brain/capabilities)" };
}
export function findTool(name) { return TOOLS.find((t) => t.name === name) || null; }

// The registry as shown to the planner: only what it needs to choose (never secrets, never implementation).
export function plannerCatalog(health = {}) {
  return listTools(health).map((t) => ({ name: t.name, description: t.description, state: t.available, risk: t.risk, auth: t.auth, runtime: t.runtime, input: Object.keys(t.input), verify: t.verify }));
}
