// NORIA CODE EXECUTION — one capability, `code.run`, behind which different ISOLATED runtimes can stand.
//
//   OBJECTIVE -> PLAN -> code.run -> execute in an isolated runtime -> capture output -> VERIFY (cross-check) -> artifacts -> back into the task graph
//
// The planner and the task graph never see WHICH runtime ran the code. They ask for `code.run` with a language, code and input; this module's policy
// chooses among the runtimes that exist and are permitted (today: the browser JavaScript sandbox; later: browser Python, isolated server Python / JavaScript,
// other specialised runtimes). The browser sandbox is the FIRST verified runtime. It is not the definition of Noria's code-execution capability.
//
// AUTHORITY. Running code INSIDE the sealed boundary needs no per-run approval (a standing authorisation, recorded in the policy). Everything OUTSIDE the
// boundary is a separate authority level, is never granted by it, and is refused here with the reason and the level. A runtime that does not provide a
// capability cannot be given it by a request, a grant or a clever piece of code: the boundary is enforced by the runtime, not requested politely.
//
// The sandbox is an UNTRUSTED execution environment. Everything that comes out of it (output, result, artifacts) is DATA: it is size-capped, checked for
// instruction-like text, artifacts are validated again by the host, and nothing in the system ever interprets output as a command.

import { sanitizeOutput } from "./executor.js";
import { sha256 } from "./graph.js";

// ── authority levels ─────────────────────────────────────────────────────────────────────────────────────────────────
export const AUTHORITY = {
  sealed_compute: { level: 0, approval: "none per run (standing authorisation inside the sealed boundary)", what: "computation on data given in the request; output, result and artifacts returned to the caller" },
  network: { level: 1, approval: "required", what: "any network request, including reading a web page or calling an API" },
  local_files: { level: 2, approval: "required", what: "reading the person's own files or folders" },
  credentials: { level: 3, approval: "required", what: "cookies, tokens, passwords, Noria's session, browser storage" },
  external_api: { level: 4, approval: "required, per API", what: "calling an outside service with the person's authority" },
  send_data: { level: 5, approval: "required", what: "sending any data out of the sandbox" },
  package_install: { level: 6, approval: "required", what: "installing packages or code from the internet" },
  fs_write: { level: 7, approval: "required", what: "writing to the person's real filesystem" },
  os_command: { level: 8, approval: "required", what: "operating-system commands" },
  control_apps: { level: 9, approval: "required", what: "controlling other applications or browser actions outside the sandbox" },
  side_effects: { level: 10, approval: "required, per action", what: "any real-world side effect" },
};
export const OUTSIDE_BOUNDARY = Object.keys(AUTHORITY).filter((k) => k !== "sealed_compute");

export const DEFAULT_TIMEOUT_MS = { javascript: 5000, python: 25000 }; // Python's default includes starting the runtime
export const LIMITS = { timeoutMs: 5000, maxTimeoutMs: 30000, maxCodeChars: 100000, maxInputChars: 200000, maxOutputChars: 20000, maxResultChars: 20000, maxArtifacts: 8, maxArtifactChars: 200000, maxArtifactTotalChars: 400000 };
export const LANGUAGES = ["javascript", "python"];
// artifacts are stored as data and are never executed: only these kinds, and only text
export const ARTIFACT_KINDS = ["text", "markdown", "csv", "json", "svg"];

export class CodeExecError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; this.retryable = false; Object.assign(this, extra); }
}

// ── runtimes ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A runtime: { id, languages, isolation, provides:[capabilities beyond sealed compute], memory_enforced, available() -> {ok, reason}, run(req) -> raw result }
// Isolation strength, weakest to strongest: a policy may demand a minimum.
export const ISOLATION = ["browser-sandbox", "server-isolated"];

// Static description of every runtime Noria knows about, for /brain/code-runtimes: what exists, what is only planned, and what each can and cannot do.
export const RUNTIME_CATALOG = [
  { id: "browser-js", languages: ["javascript"], isolation: "browser-sandbox", state: "built", provides: [], memory_enforced: false, note: "Opaque-origin iframe + no-network policy + worker, killed on timeout. Isolation-tested in a real browser." },
  { id: "browser-python", languages: ["python"], isolation: "browser-sandbox", state: "designed", provides: [], memory_enforced: false, note: "Python compiled to WebAssembly inside the same sealed boundary. Needs the Python/WebAssembly runtime added to the site (a download that needs the owner's approval)." },
  { id: "server-python", languages: ["python"], isolation: "server-isolated", state: "not_built", provides: [], memory_enforced: true, note: "Infrastructure required: an isolated server execution service with enforced memory, CPU and time limits." },
  { id: "server-js", languages: ["javascript"], isolation: "server-isolated", state: "not_built", provides: [], memory_enforced: true, note: "Infrastructure required: as above." },
];

const nz = (n, d) => (typeof n === "number" && isFinite(n) && n > 0 ? n : d);

// ── request validation: the boundary ─────────────────────────────────────────────────────────────────────────────────
export function normalizeRequest(req, limits = LIMITS) {
  if (!req || typeof req !== "object") throw new CodeExecError("bad_request", "a code request is an object with code and a language");
  const language = String(req.language || "javascript").toLowerCase();
  if (!LANGUAGES.includes(language)) throw new CodeExecError("unsupported_language", "language \"" + language + "\" is not one Noria runs (" + LANGUAGES.join(", ") + ")");
  if (typeof req.code !== "string" || !req.code.trim()) throw new CodeExecError("no_code", "there is no code to run");
  if (req.code.length > limits.maxCodeChars) throw new CodeExecError("too_large", "the code is longer than " + limits.maxCodeChars + " characters");
  let input = null;
  if (req.input !== undefined && req.input !== null) { let s; try { s = JSON.stringify(req.input); } catch (_) { throw new CodeExecError("bad_input", "the input must be plain JSON"); } if (s.length > limits.maxInputChars) throw new CodeExecError("too_large", "the input is larger than " + limits.maxInputChars + " characters"); input = JSON.parse(s); }
  const needs = Array.isArray(req.needs) ? req.needs.map(String) : [];
  const timeoutMs = Math.min(nz(Number(req.timeout_ms), DEFAULT_TIMEOUT_MS[language] || limits.timeoutMs), limits.maxTimeoutMs);
  return { language, code: req.code, input, needs, timeoutMs, crosscheck: req.crosscheck && typeof req.crosscheck === "object" ? req.crosscheck : null, prefer: req.prefer || null };
}

// What the request needs beyond the sealed boundary, judged against what the policy has granted. Nothing here grants anything by itself.
export function boundaryCheck(needs, policy = {}) {
  const grants = new Set(Array.isArray(policy.grants) ? policy.grants : []);
  const outside = [];
  for (const n of needs) {
    if (n === "sealed_compute") continue;
    if (!AUTHORITY[n]) { outside.push({ need: n, level: null, reason: "an unknown capability: refused" }); continue; }
    outside.push({ need: n, level: AUTHORITY[n].level, approval: AUTHORITY[n].approval, granted: grants.has(n), reason: grants.has(n) ? "granted by the policy, but only a runtime that provides it can supply it" : "outside the sealed boundary: it needs " + AUTHORITY[n].approval + " approval and has not been granted" });
  }
  return { inside: outside.length === 0, outside };
}

// ── the policy chooses the runtime: the planner and the task graph never do ──────────────────────────────────────────
export function chooseRuntime(req, runtimes, policy = {}) {
  const rejected = [], grants = new Set(policy.grants || []), minIso = ISOLATION.indexOf(policy.minIsolation || "browser-sandbox");
  const ok = [];
  for (const r of runtimes) {
    if (!r.languages.includes(req.language)) { rejected.push({ id: r.id, why: "does not run " + req.language }); continue; }
    if (ISOLATION.indexOf(r.isolation) < minIso) { rejected.push({ id: r.id, why: "isolation " + r.isolation + " is weaker than the policy minimum" }); continue; }
    const av = r.available ? r.available() : { ok: true };
    if (!av.ok) { rejected.push({ id: r.id, why: "not available: " + av.reason }); continue; }
    const missing = req.needs.filter((n) => n !== "sealed_compute" && !(r.provides || []).includes(n));
    if (missing.length) { rejected.push({ id: r.id, why: "does not provide " + missing.join(", ") }); continue; }
    if (req.needs.some((n) => n !== "sealed_compute" && !grants.has(n))) { rejected.push({ id: r.id, why: "the request needs authority that has not been granted" }); continue; }
    ok.push(r);
  }
  // heavier work prefers the runtime that ENFORCES memory; otherwise the strongest isolation available; ties by the policy's own order
  const heavy = req.prefer === "heavy" || (policy.heavyInputChars && JSON.stringify(req.input || "").length > policy.heavyInputChars);
  ok.sort((a, b) => (heavy ? Number(!!b.memory_enforced) - Number(!!a.memory_enforced) : 0) || ISOLATION.indexOf(b.isolation) - ISOLATION.indexOf(a.isolation) || (policy.order || []).indexOf(a.id) - (policy.order || []).indexOf(b.id));
  return { runtime: ok[0] || null, rejected, considered: runtimes.map((r) => r.id) };
}

// ── verifying a result: an independent second computation must agree ─────────────────────────────────────────────────
export function compareResults(a, b, tol = {}) {
  const rel = tol.rel == null ? 1e-9 : tol.rel, abs = tol.abs == null ? 1e-9 : tol.abs;
  const walk = (x, y, path) => {
    if (typeof x === "number" && typeof y === "number") { const d = Math.abs(x - y); return d <= abs || d <= rel * Math.max(Math.abs(x), Math.abs(y)) ? null : { path, a: x, b: y, difference: d }; }
    if (Array.isArray(x) && Array.isArray(y)) { if (x.length !== y.length) return { path, a: "length " + x.length, b: "length " + y.length }; for (let i = 0; i < x.length; i++) { const r = walk(x[i], y[i], path + "[" + i + "]"); if (r) return r; } return null; }
    if (x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y)) { const ks = [...new Set([...Object.keys(x), ...Object.keys(y)])]; for (const k of ks) { if (!(k in x) || !(k in y)) return { path: path + "." + k, a: k in x ? "present" : "missing", b: k in y ? "present" : "missing" }; const r = walk(x[k], y[k], path + "." + k); if (r) return r; } return null; }
    return x === y ? null : { path, a: x, b: y };
  };
  const d = walk(a, b, "$");
  return d ? { equal: false, first_difference: d } : { equal: true };
}
const pick = (v, path) => { if (!path) return v; let cur = v; for (const k of String(path).split(".").filter(Boolean)) { if (cur == null) return undefined; cur = cur[k]; } return cur; };

// ── artifacts: the host validates what the sandbox emitted (the sandbox is untrusted) ────────────────────────────────
function cleanSvg(t) { return t.replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, "").replace(/<\s*(?:foreignObject|iframe|object|embed)[\s\S]*?<\s*\/\s*(?:foreignObject|iframe|object|embed)\s*>/gi, "").replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "").replace(/javascript:/gi, "").replace(/(?:href|xlink:href)\s*=\s*("|')\s*(?:https?:|data:|\/\/)[^"']*\1/gi, ""); }
export function validateArtifacts(list, limits = LIMITS) {
  const out = [], notes = []; let total = 0;
  for (const a of (Array.isArray(list) ? list : []).slice(0, limits.maxArtifacts)) {
    if (!a || typeof a !== "object") continue;
    const name = String(a.name || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.\-]{0,78}$/.test(name)) { notes.push("an artifact was dropped: its name is not allowed (" + JSON.stringify(name.slice(0, 40)) + ")"); continue; }
    let kind = String(a.kind || "text").toLowerCase();
    if (!ARTIFACT_KINDS.includes(kind)) { notes.push("artifact " + name + ": kind \"" + kind + "\" is not stored as such; kept as plain text and never executed"); kind = "text"; }
    let content = typeof a.content === "string" ? a.content : "";
    if (content.length > limits.maxArtifactChars || total + content.length > limits.maxArtifactTotalChars) { notes.push("artifact " + name + " was dropped: too large"); continue; }
    if (kind === "svg") { const c = cleanSvg(content); if (c !== content) notes.push("artifact " + name + ": scripts, event handlers and external references were removed from the SVG"); content = c; }
    if (kind === "json") { try { JSON.parse(content); } catch (_) { notes.push("artifact " + name + ": not valid JSON; kept as text"); kind = "text"; } }
    total += content.length; out.push({ name, kind, content });
  }
  return { artifacts: out, notes };
}

// ── executing ────────────────────────────────────────────────────────────────────────────────────────────────────────
// runtimes: [runtime]; policy: { grants, minIsolation, order, heavyInputChars, now }
export async function executeCode(request, { runtimes, policy = {} } = {}) {
  const req = normalizeRequest(request, policy.limits || LIMITS);
  const bound = boundaryCheck(req.needs, policy);
  if (!bound.inside) throw new CodeExecError("outside_boundary", "code.run runs inside the sealed sandbox only. " + bound.outside.map((o) => o.need + (o.level != null ? " (level " + o.level + ")" : "") + ": " + o.reason).join("; "), { boundary: bound });
  const pick0 = chooseRuntime(req, runtimes, policy);
  if (!pick0.runtime) throw new CodeExecError("no_runtime", "no runtime is available for " + req.language + ": " + pick0.rejected.map((r) => r.id + " (" + r.why + ")").join("; "), { rejected: pick0.rejected });
  const rt = pick0.runtime;
  const raw = await rt.run({ language: req.language, code: req.code, input: req.input, timeoutMs: req.timeoutMs });
  return await finalise(raw, req, rt, policy, { runtimes });
}

async function finalise(raw, req, rt, policy, ctx) {
  if (!raw || raw.ok !== true) {
    const e = raw && raw.error || {}, msg = (e.name ? e.name + ": " : "") + (e.message || "the code did not run") + (raw && raw.stdout ? "\nOutput before the failure:\n" + String(raw.stdout).slice(0, 1000) : "");
    throw new CodeExecError(raw && raw.killed ? "timeout" : "code_error", msg, { runtime: { id: rt.id, isolation: rt.isolation }, killed: !!(raw && raw.killed) });
  }
  let result = null; if (raw.result_defined !== false) { try { result = typeof raw.result === "string" ? JSON.parse(raw.result) : raw.result; } catch (_) { result = raw.result; } }
  // STRUCTURAL RULE: what comes out of the sandbox is untrusted DATA. There are exactly two channels and neither carries authority:
  //   data     stdout and `result`: opaque values. Nothing in Noria looks inside them to decide anything, and a `result` that merely CONTAINS a field named
  //            artifacts, tool, plan, approved, grants or needs is only data (it is never lifted, executed or acted on).
  //   emitted  files the code declared through artifact()/emit_artifact(): host-validated (name, kind, size), stored as inert data, never run.
  // Detection of instruction-like text (below) is an ADDITIONAL defence and is never the boundary: even text no filter recognises cannot create
  // a permission, a plan step, a tool call, an approval or a runtime capability, because no code path reads authority out of sandbox output.
  const emitted = Array.isArray(raw.artifacts) ? raw.artifacts.slice() : [];
  const va = validateArtifacts(emitted, policy.limits || LIMITS);
  // everything that came out is data: instruction-like text is neutralised and reported
  const found = [];
  const stdout = sanitizeOutput(String(raw.stdout || "").slice(0, (policy.limits || LIMITS).maxOutputChars), found);
  result = sanitizeOutput(result, found);
  const artifacts = va.artifacts.map((a) => (a.kind === "svg" ? a : { ...a, content: sanitizeOutput(a.content, found) }));
  const out = { stdout, result, duration_ms: raw.duration_ms || 0, language: req.language, truncated: !!(raw.stdout_truncated || raw.result_truncated), artifacts, notes: va.notes,
    runtime: { id: rt.id, isolation: rt.isolation, memory_enforced: !!rt.memory_enforced }, untrusted: true, injection_found: found.length };
  // verification: an independent computation must agree (a different method, and if useful a different runtime)
  if (req.crosscheck && req.crosscheck.code) {
    const cc = req.crosscheck, lang = String(cc.language || req.language).toLowerCase();
    const req2 = normalizeRequest({ code: cc.code, language: lang, input: req.input, timeout_ms: req.timeoutMs }, policy.limits || LIMITS);
    const p2 = chooseRuntime(req2, ctx.runtimes, policy);
    if (!p2.runtime) out.verification = { method: "cross-check", ok: false, reason: "no runtime is available for the cross-check language (" + lang + ")" };
    else {
      let r2; try { r2 = await p2.runtime.run({ language: lang, code: req2.code, input: req2.input, timeoutMs: req2.timeoutMs }); } catch (e) { r2 = { ok: false, error: { name: "Error", message: String(e && e.message || e) } }; }
      if (!r2.ok) out.verification = { method: "cross-check", ok: false, reason: "the second computation failed: " + ((r2.error && r2.error.message) || "unknown") };
      else { let v2 = null; try { v2 = typeof r2.result === "string" ? JSON.parse(r2.result) : r2.result; } catch (_) { v2 = r2.result; } const cmp = compareResults(pick(result, cc.path), pick(v2, cc.path), cc.tolerance || {}); out.verification = { method: "cross-check", ok: cmp.equal, compared: cc.path || "the whole result", by: p2.runtime.id, ...(cmp.equal ? {} : { first_difference: cmp.first_difference }) }; }
    }
    if (!out.verification.ok && cc.mode !== "report") throw new CodeExecError("verification_failed", "the result did not survive an independent cross-check: " + (out.verification.reason || JSON.stringify(out.verification.first_difference)), { runtime: out.runtime, verification: out.verification, result_unverified: result });
  }
  // provenance: what ran, where, and what came out, so the run can be audited and reproduced
  out.provenance = { code_sha256: (await sha256(req.code)).slice(0, 32), output_sha256: (await sha256(JSON.stringify({ r: result, s: stdout, a: artifacts.map((a) => a.name + ":" + a.content.length) }))).slice(0, 32), runtime: rt.id, isolation: rt.isolation, limits: { timeout_ms: req.timeoutMs } };
  return out;
}

// The handler the browser runtime registers for the tool `code.run`. A failed, refused, timed-out or unverified run is a FAILED step, never a quiet success.
export function codeRunHandler({ runtimes, policy = {} }) {
  return async (input) => {
    try { return await executeCode(input, { runtimes, policy }); }
    catch (e) { const err = new Error((e.code ? e.code + ": " : "") + e.message); err.retryable = false; err.code = e.code; err.detail = { runtime: e.runtime, verification: e.verification, boundary: e.boundary }; throw err; }
  };
}

export function describeCodeRuntimes(availableIds = []) {
  return { boundary: { inside: AUTHORITY.sealed_compute, outside: Object.fromEntries(OUTSIDE_BOUNDARY.map((k) => [k, AUTHORITY[k]])), rule: "Running code inside the sealed boundary needs no per-run approval. Everything outside it is a separate authority, refused here, and never granted by the standing authorisation." },
    runtimes: RUNTIME_CATALOG.map((r) => ({ ...r, available: availableIds.includes(r.id) })), limits: LIMITS, artifact_kinds: ARTIFACT_KINDS,
    principle: "The planner asks for code.run; the execution policy chooses the runtime. The browser sandbox is the first verified runtime, not the definition of Noria's code execution." };
}
