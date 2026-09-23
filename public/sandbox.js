// NORIA CODE SANDBOX — the browser runtimes (JavaScript and Python). runCode(code, options) returns a structured result; it never throws for a problem in the person's code.
// See sandbox-core.js and sandbox-python-core.js for how the isolation works and what it cannot do.
import { LIMITS, serialize, bootstrapHtml } from "/sandbox-core.js";
import { bootstrapHtmlFor, PY_LIMITS, PY_ASSETS } from "/sandbox-python-core.js";
import { codeRunHandler as codeRunHandlerFor } from "/agent/code-exec.js";

const nonce = () => { const b = new Uint8Array(12); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); };
let seq = 0;

// ── the Python runtime files: fetched from OUR OWN site by the trusted page, checked against their recorded hashes, cached in memory ──
let pyAssets = null, pyState = { ok: true, reason: "" };
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function loadPythonAssets() {
  if (pyAssets) return pyAssets;
  try {
    const man = await (await fetch(PY_ASSETS.base + PY_ASSETS.manifest, { cache: "no-cache" })).json();
    const get = async (name, binary) => {
      const r = await fetch(PY_ASSETS.base + name, { cache: "force-cache" }); if (!r.ok) throw new Error(name + " is not on the site (" + r.status + ")");
      const buf = await r.arrayBuffer(), want = man.files && man.files[name] && man.files[name].sha256;
      if (!want || hex(await crypto.subtle.digest("SHA-256", buf)) !== want) throw new Error(name + " does not match its recorded hash: it is not used");
      return binary ? buf : new TextDecoder().decode(buf);
    };
    const t = PY_ASSETS.text, b = PY_ASSETS.binary;
    const [pyodide, asm, lock, wasm, stdlib] = await Promise.all([get(t.pyodide), get(t.asm), get(t.lock), get(b.wasm, true), get(b.stdlib, true)]);
    pyAssets = { pyodide, asm, lock, wasm, stdlib }; pyState = { ok: true, reason: "" };
    return pyAssets;
  } catch (e) { pyState = { ok: false, reason: String((e && e.message) || e) }; throw e; }
}

// One run = one brand-new sandboxed iframe (nothing carries over between runs). The parent kills the iframe at the timeout.
export function runCode(code, { input = null, timeoutMs, language = "javascript" } = {}) {
  return new Promise(async (resolve) => {
    const started = performance.now();
    const done = (r) => resolve({ language, duration_ms: r.duration_ms != null ? r.duration_ms : Math.round(performance.now() - started), wall_ms: Math.round(performance.now() - started), ...r });
    const fail = (name, message, extra = {}) => done({ ok: false, error: { name, message, stack: "" }, stdout: "", killed: false, ...extra });
    if (language !== "javascript" && language !== "python") return fail("UnsupportedLanguage", "language " + language + " is not one this sandbox runs");
    if (typeof code !== "string" || !code.trim()) return fail("EmptyCode", "there is no code to run");
    if (code.length > LIMITS.maxCodeChars) return fail("TooLarge", "the code is longer than " + LIMITS.maxCodeChars + " characters");
    let inputCopy = null;
    if (input != null) { try { const s = JSON.stringify(input); if (s.length > LIMITS.maxInputChars) return fail("TooLarge", "the input is too large"); inputCopy = JSON.parse(s); } catch (_) { return fail("BadInput", "the input must be plain JSON"); } }
    const py = language === "python", def = py ? PY_LIMITS.timeoutMs : LIMITS.timeoutMs, max = py ? PY_LIMITS.maxTimeoutMs : LIMITS.maxTimeoutMs;
    const limit = Math.max(200, Math.min(Number(timeoutMs) || def, max));
    let assets = null;
    if (py) { try { const a = await loadPythonAssets(); assets = { pyodide: a.pyodide, asm: a.asm, lock: a.lock, wasm: a.wasm.slice(0), stdlib: a.stdlib.slice(0) }; } catch (e) { return fail("PythonRuntimeMissing", "the Python runtime is not available on this site: " + String((e && e.message) || e)); } }
    const id = ++seq, n = nonce();
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts"); // NO allow-same-origin, allow-popups, allow-forms, allow-modals, allow-top-navigation
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("aria-hidden", "true"); frame.tabIndex = -1;
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-9999px;top:0";
    frame.srcdoc = py ? bootstrapHtmlFor("py") : bootstrapHtml();
    let finished = false, timer = null;
    const finish = (r) => { if (finished) return; finished = true; clearTimeout(timer); window.removeEventListener("message", onMsg); try { frame.remove(); } catch (_) {} done(r); };
    const onMsg = (e) => {
      if (e.source !== frame.contentWindow) return; // only this run's iframe
      const m = e.data; if (!m || typeof m !== "object") return;
      if (m.t === "ready") { try { frame.contentWindow.postMessage({ t: "run", id, nonce: n, kind: py ? "py" : "js", code, input: inputCopy, serializeSource: serialize.toString(), assets }, "*", assets ? [assets.wasm, assets.stdlib] : []); } catch (err) { finish({ ok: false, error: { name: "SandboxError", message: String(err && err.message || err), stack: "" }, stdout: "", killed: false }); } return; }
      if (m.t === "result" && m.id === id && m.nonce === n) { const { t, nonce: _n, id: _i, ...rest } = m; finish({ killed: false, ...rest }); }
    };
    window.addEventListener("message", onMsg);
    timer = setTimeout(() => finish({ ok: false, error: { name: "Timeout", message: "the code did not finish within " + limit + " ms" + (py ? " (this includes starting Python)" : "") + " and was stopped", stack: "" }, stdout: "", killed: true, duration_ms: limit }), limit);
    document.body.appendChild(frame);
  });
}

// The sandboxes as runtimes behind `code.run`. Which runtime runs a request is decided by the execution policy (agent/code-exec.js), not by the caller.
const hasBrowser = () => (typeof document !== "undefined" && typeof Worker !== "undefined");
export function browserJsRuntime() {
  return { id: "browser-js", languages: ["javascript"], isolation: "browser-sandbox", provides: [], memory_enforced: false,
    available: () => (hasBrowser() ? { ok: true } : { ok: false, reason: "this environment has no browser sandbox" }),
    run: (r) => runCode(r.code, { input: r.input, timeoutMs: r.timeoutMs, language: "javascript" }) };
}
export function browserPythonRuntime() {
  return { id: "browser-python", languages: ["python"], isolation: "browser-sandbox", provides: [], memory_enforced: false,
    available: () => (!hasBrowser() ? { ok: false, reason: "this environment has no browser sandbox" } : pyState.ok ? { ok: true } : { ok: false, reason: pyState.reason }),
    run: (r) => runCode(r.code, { input: r.input, timeoutMs: r.timeoutMs, language: "python" }) };
}
export const browserRuntimes = () => [browserJsRuntime(), browserPythonRuntime()];

// The handler the browser runtime runs for the tool "code.run". A run that fails, is refused, times out or fails its cross-check is a FAILED step, never a quiet success.
export function codeRunHandler(options = {}) {
  return codeRunHandlerFor({ runtimes: options.runtimes || browserRuntimes(), policy: options.policy || {} });
}
