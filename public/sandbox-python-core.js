// NORIA CODE SANDBOX — Python (Pyodide, WebAssembly): the pure parts (no DOM).
//
// The same sealed boundary as JavaScript: an opaque-origin iframe, a no-network page policy, a worker, a fresh iframe per run, killed on timeout.
// Python can reach nothing the sandbox does not have: the network-capable APIs are removed from the worker, the page policy blocks them anyway, and
// Python's own filesystem is an in-memory one that starts empty (no host file exists in it). The runtime files are hosted by Noria itself, checked against
// hashes before use, and handed to the sandbox as bytes: nothing is ever fetched from inside it. The package list is EMPTY, so no library can even be named.
// What is available is Python's standard library (csv, json, statistics, math, decimal, fractions, datetime, re, collections, itertools, sqlite3 in memory…).
// Memory cannot be capped inside a browser page, exactly as for JavaScript: the timeout is the only bound (a stated limitation of this runtime).

import { LIMITS, CSP, workerMain } from "./sandbox-core.js";

export const CSP_PY = CSP.replace("script-src 'unsafe-inline' 'unsafe-eval' blob:", "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:");
// The default limit covers starting Python (compiling the WebAssembly runtime takes seconds) AND the run.
export const PY_LIMITS = { timeoutMs: 25000, maxTimeoutMs: 30000 };
export const PY_ASSETS = { base: "/vendor/pyodide/", manifest: "MANIFEST.json", text: { pyodide: "pyodide.mjs", asm: "pyodide.asm.mjs", lock: "pyodide-lock.min.json" }, binary: { wasm: "pyodide.asm.wasm", stdlib: "python_stdlib.zip" } };

// The program that runs inside the Worker. A real function so it is shipped as source text; it takes the runtime bytes from the host.
export function pythonWorkerMain(NONCE, LIM, serializeSource) {
  "use strict";
  const post = self.postMessage.bind(self);
  const ser = new Function("return " + serializeSource)();
  const BLOCK = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "importScripts", "indexedDB", "caches", "Worker", "SharedWorker", "BroadcastChannel", "postMessage", "close", "Request", "Response", "Headers", "FileReader", "FileReaderSync", "openDatabase", "localStorage", "sessionStorage", "cookieStore", "webkitRequestFileSystem", "webkitRequestFileSystemSync", "webkitResolveLocalFileSystemURL", "showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"];
  const seal = () => { let o = self; for (let depth = 0; o && depth < 6; depth++, o = Object.getPrototypeOf(o)) for (const k of BLOCK) { try { if (Object.prototype.hasOwnProperty.call(o, k)) Object.defineProperty(o, k, { value: undefined, writable: false, configurable: false }); } catch (_) {} } };
  self.onmessage = async (e) => {
    const m = e.data || {}, out = []; let outChars = 0, flood = false;
    const log = (line) => { line = String(line); if (outChars + line.length + 1 > LIM.maxOutputChars) { flood = true; return; } out.push(line); outChars += line.length + 1; };
    const artifacts = []; let artChars = 0;
    const artifact = (name, kind, content) => {
      if (artifacts.length >= LIM.maxArtifacts) throw new Error("too many artifacts (at most " + LIM.maxArtifacts + ")");
      const text = typeof content === "string" ? content : ser(content, LIM.maxArtifactChars).json;
      if (text.length > LIM.maxArtifactChars || artChars + text.length > LIM.maxArtifactTotalChars) throw new Error("artifact too large");
      artChars += text.length; artifacts.push({ name: String(name).slice(0, 80), kind: String(kind || "text").slice(0, 20), content: text });
    };
    const now = () => ((self.performance && self.performance.now) ? self.performance.now() : Date.now());
    const t0 = now(); let msg, bootMs = 0;
    try {
      const A = m.assets;
      // The loader wants two binary files through fetch. It gets a private in-memory fetch that knows only those two: no network exists in here.
      const files = { "pyodide.asm.wasm": { bytes: A.wasm, type: "application/wasm" }, "python_stdlib.zip": { bytes: A.stdlib, type: "application/zip" } };
      self.fetch = async (u) => { const name = String(u).split("?")[0].split("/").pop(), f = files[name]; if (!f) throw new TypeError("there is no network in the sandbox"); return new Response(f.bytes, { status: 200, headers: { "content-type": f.type } }); };
      const load = (text) => import(URL.createObjectURL(new Blob([text], { type: "text/javascript" })));
      const both = await Promise.all([load(A.pyodide), load(A.asm)]);
      const py = await both[0].loadPyodide({ indexURL: "https://pyodide.invalid/", lockFileContents: A.lock, createPyodideModule: both[1].default, fullStdLib: false, stdout: (s) => log(s), stderr: (s) => log("[stderr] " + s) });
      seal(); // the network-capable globals are gone before any of the person's code runs
      bootMs = Math.round(now() - t0);
      py.globals.set("input", py.toPy(m.input === undefined ? null : m.input));
      py.globals.set("emit_artifact", (name, kind, content) => artifact(name, kind, typeof content === "string" ? content : String(content)));
      let value = await py.runPythonAsync(m.code, { globals: py.globals });
      if (value !== undefined && value !== null && typeof value === "object" && typeof value.toJs === "function") { const js = value.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false }); try { value.destroy(); } catch (_) {} value = js; }
      const r = ser(value, LIM.maxResultChars);
      msg = { ok: true, result: r.json, result_defined: r.defined, result_truncated: r.truncated };
    } catch (err) {
      const text = err && err.message ? String(err.message) : String(err), lines = text.trim().split("\n").filter(Boolean);
      msg = { ok: false, error: { name: (err && err.type) || (err && err.name) || "PythonError", message: (lines[lines.length - 1] || text).slice(0, 2000), stack: lines.slice(-8).join("\n").slice(0, 1500) } };
    }
    post({ nonce: NONCE, id: m.id, ...msg, artifacts, stdout: out.join("\n"), stdout_truncated: flood, duration_ms: Math.round(now() - t0), boot_ms: bootMs });
  };
}

// The iframe document for a run of a given kind ("js" or "py"): creates the worker from a blob, relays the run and the result, and nothing else.
export function bootstrapHtmlFor(kind) {
  const boot = function (LIM, JS_TEXT, PY_TEXT) {
    const parentWin = window.parent; let worker = null;
    window.addEventListener("message", (e) => {
      if (e.source !== parentWin) return;
      const m = e.data; if (!m || m.t !== "run" || typeof m.code !== "string") return;
      try {
        const WORKER_TEXT = m.kind === "py" ? PY_TEXT : JS_TEXT;
        const src = "(" + WORKER_TEXT + ")(" + JSON.stringify(m.nonce) + "," + JSON.stringify(LIM) + "," + JSON.stringify(m.serializeSource) + ")";
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
        worker.onmessage = (ev) => { const d = ev.data; if (d && d.nonce === m.nonce && d.id === m.id) { parentWin.postMessage({ t: "result", ...d }, "*"); } };
        worker.onerror = (ev) => { parentWin.postMessage({ t: "result", id: m.id, nonce: m.nonce, ok: false, error: { name: "WorkerError", message: String(ev && ev.message || "the worker failed to start"), stack: "" }, stdout: "", duration_ms: 0 }, "*"); };
        const transfer = m.assets ? [m.assets.wasm, m.assets.stdlib].filter((b) => b instanceof ArrayBuffer) : [];
        worker.postMessage({ id: m.id, code: m.code, input: m.input, assets: m.assets }, transfer);
      } catch (err) { parentWin.postMessage({ t: "result", id: m.id, nonce: m.nonce, ok: false, error: { name: "SandboxError", message: String(err && err.message || err), stack: "" }, stdout: "", duration_ms: 0 }, "*"); }
    });
    parentWin.postMessage({ t: "ready" }, "*");
  };
  const policy = kind === "py" ? CSP_PY : CSP;
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy + '"></head><body><script>(' + boot.toString() + ')(' + JSON.stringify(LIMITS) + ',' + JSON.stringify(workerMain.toString()) + ',' + JSON.stringify(pythonWorkerMain.toString()) + ');<\/script></body></html>';
}
