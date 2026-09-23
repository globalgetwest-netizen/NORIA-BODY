// NORIA CODE SANDBOX — the pure parts (no DOM): limits, the page policy, the worker program, and safe result serialisation.
//
// Where the isolation comes from: the BROWSER, not from anything written here.
//   1. Each run gets a brand-new <iframe sandbox="allow-scripts"> (no allow-same-origin): its origin is opaque, so it cannot read the parent page,
//      cookies, localStorage, IndexedDB or the person's Noria session. No popups, no forms, no top-level navigation, no modals.
//   2. The iframe document carries a Content-Security-Policy of default-src 'none' with connect-src 'none': fetch, XMLHttpRequest, WebSocket, EventSource,
//      images, styles, frames, forms and beacons are blocked by the browser.
//   3. The code runs in a Worker inside that iframe, so an endless loop blocks only the worker. The parent kills the whole iframe on timeout.
//   4. Defence in depth: the worker program removes the network-capable globals before the code runs. This is NOT relied upon: (2) is.
//   5. A fresh iframe per run: nothing survives from one run to the next (no globals, no prototype pollution).
// What the browser does NOT let a page do: cap memory. A run that allocates without limit can exhaust the tab; the timeout is the only bound.
// That is a real limitation of an in-browser sandbox and is stated as such; a server-side sandbox is the answer for heavier work.

export const LIMITS = { timeoutMs: 5000, maxTimeoutMs: 30000, maxOutputChars: 20000, maxResultChars: 20000, maxCodeChars: 100000, maxInputChars: 200000, maxArtifacts: 8, maxArtifactChars: 200000, maxArtifactTotalChars: 400000 };

// The page policy of the sandbox document.
export const CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; style-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

// A result is turned into plain JSON here, safely: cycles, BigInt, functions, Map/Set, errors, undefined, and size.
export function serialize(value, maxChars = LIMITS.maxResultChars) {
  const seen = new WeakSet();
  const replacer = (k, v) => {
    if (typeof v === "bigint") return v.toString() + "n";
    if (typeof v === "function") return "[function " + (v.name || "anonymous") + "]";
    if (typeof v === "symbol") return v.toString();
    if (v instanceof Error) return { error: String(v.name), message: String(v.message) };
    if (v instanceof Map) return { map: [...v.entries()] };
    if (v instanceof Set) return { set: [...v.values()] };
    if (typeof v === "number" && !isFinite(v)) return String(v);
    if (v && typeof v === "object") { if (seen.has(v)) return "[circular]"; seen.add(v); }
    return v;
  };
  let text;
  try { text = value === undefined ? "undefined" : JSON.stringify(value, replacer); } catch (e) { text = JSON.stringify("[unserialisable: " + String((e && e.message) || e).slice(0, 80) + "]"); }
  if (text === undefined) text = "undefined";
  const truncated = text.length > maxChars;
  return { json: truncated ? text.slice(0, maxChars) : text, truncated, defined: value !== undefined };
}

// The program that runs inside the Worker. It is a real function so it can be tested in Node with a fake `self`; it is shipped as source text.
export function workerMain(NONCE, LIM, serializeSource) {
  "use strict";
  const post = self.postMessage.bind(self);
  const ser = new Function("return " + serializeSource)();
  // remove every way to reach the network or other contexts (the page policy already blocks them; this is a second, independent layer)
  const BLOCK = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "importScripts", "indexedDB", "caches", "Worker", "SharedWorker", "BroadcastChannel", "postMessage", "close", "Request", "Response", "Headers", "FileReader", "FileReaderSync", "openDatabase", "localStorage", "sessionStorage", "cookieStore", "webkitRequestFileSystem", "webkitRequestFileSystemSync", "webkitResolveLocalFileSystemURL", "showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"];
  let o = self;
  for (let depth = 0; o && depth < 6; depth++, o = Object.getPrototypeOf(o)) for (const k of BLOCK) { try { if (Object.prototype.hasOwnProperty.call(o, k)) Object.defineProperty(o, k, { value: undefined, writable: false, configurable: false }); } catch (_) {} }
  try { Object.defineProperty(self.navigator || {}, "sendBeacon", { value: undefined }); } catch (_) {}
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  self.onmessage = async (e) => {
    const m = e.data || {}, out = []; let outChars = 0, floodTruncated = false;
    const fmt = (a) => a.map((x) => { if (typeof x === "string") return x; const r = ser(x, 2000); return r.json; }).join(" ");
    const log = (...a) => { const line = fmt(a); if (outChars + line.length + 1 > LIM.maxOutputChars) { floodTruncated = true; return; } out.push(line); outChars += line.length + 1; };
    // files the code produces: emitted through artifact(name, kind, content); size-capped here and validated again by the host (the sandbox is untrusted)
    const artifacts = []; let artChars = 0;
    const artifact = (name, kind, content) => {
      if (artifacts.length >= LIM.maxArtifacts) throw new Error("too many artifacts (at most " + LIM.maxArtifacts + ")");
      const text = typeof content === "string" ? content : ser(content, LIM.maxArtifactChars).json;
      if (text.length > LIM.maxArtifactChars || artChars + text.length > LIM.maxArtifactTotalChars) throw new Error("artifact too large");
      artChars += text.length; artifacts.push({ name: String(name).slice(0, 80), kind: String(kind || "text").slice(0, 20), content: text });
    };
    const con = { log, info: log, debug: log, warn: (...a) => log("[warn]", ...a), error: (...a) => log("[error]", ...a), table: log, dir: log, trace: () => {} };
    const t0 = (self.performance && self.performance.now) ? self.performance.now() : Date.now();
    let msg;
    try {
      const fn = new AsyncFunction("console", "input", "artifact", m.code);
      const value = await fn(con, m.input, artifact);
      const r = ser(value, LIM.maxResultChars);
      msg = { ok: true, result: r.json, result_defined: r.defined, result_truncated: r.truncated };
    } catch (err) {
      const isErr = err && typeof err === "object" && "message" in err;
      msg = { ok: false, error: { name: isErr ? String(err.name) : "Thrown", message: (isErr ? String(err.message) : ser(err, 500).json).slice(0, 2000), stack: isErr && err.stack ? String(err.stack).split("\n").slice(0, 6).join("\n").slice(0, 1500) : "" } };
    }
    const t1 = (self.performance && self.performance.now) ? self.performance.now() : Date.now();
    post({ nonce: NONCE, id: m.id, ...msg, artifacts, stdout: out.join("\n"), stdout_truncated: floodTruncated, duration_ms: Math.round(t1 - t0) });
  };
}

// The iframe document: creates the worker from a blob, relays the run and the result, and nothing else.
export function bootstrapHtml() {
  const boot = function (LIM, WORKER_TEXT) {
    const parentWin = window.parent; let worker = null;
    window.addEventListener("message", (e) => {
      if (e.source !== parentWin) return;
      const m = e.data; if (!m || m.t !== "run" || typeof m.code !== "string") return;
      try {
        const src = "(" + WORKER_TEXT + ")(" + JSON.stringify(m.nonce) + "," + JSON.stringify(LIM) + "," + JSON.stringify(m.serializeSource) + ")";
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
        worker.onmessage = (ev) => { const d = ev.data; if (d && d.nonce === m.nonce && d.id === m.id) { parentWin.postMessage({ t: "result", ...d }, "*"); } };
        worker.onerror = (ev) => { parentWin.postMessage({ t: "result", id: m.id, nonce: m.nonce, ok: false, error: { name: "WorkerError", message: String(ev && ev.message || "the worker failed to start"), stack: "" }, stdout: "", duration_ms: 0 }, "*"); };
        worker.postMessage({ id: m.id, code: m.code, input: m.input });
      } catch (err) { parentWin.postMessage({ t: "result", id: m.id, nonce: m.nonce, ok: false, error: { name: "SandboxError", message: String(err && err.message || err), stack: "" }, stdout: "", duration_ms: 0 }, "*"); }
    });
    parentWin.postMessage({ t: "ready" }, "*");
  };
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + CSP + '"></head><body><script>(' + boot.toString() + ')(' + JSON.stringify(LIMITS) + ',' + JSON.stringify(workerMain.toString()) + ');<\/script></body></html>';
}
