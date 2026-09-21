// NORIA BROWSER RUNTIME — read-only.
//
// Implements the runtime contract (see agent/runtime.js). It is NOT a security boundary and is never trusted as one: the permission,
// approval and read-only rules live in the executor and the tool layer (agent/gate.js), and the server route /brain/tool applies the
// same gate again. This file only carries a step out and REPORTS what it did.
//
//   - server tools are called through POST /brain/tool (the server re-checks everything)
//   - device tools (reading an attached file, querying an attached spreadsheet) run through handlers the page registers
//   - a SideEffectMonitor records every network request and every change to browser storage during execution. Anything outside the
//     allowed read-only calls is listed in `touched`, and the executor reports it as a side effect.

const SERVER_TOOLS = new Set(["web.search", "clock.now", "calc.math", "weather.get", "fx.rate", "crypto.price", "reference.list"]);

export class SideEffectMonitor {
  constructor({ fetchImpl, storage = null, origin = "", allowedPaths = ["/brain/tool"] } = {}) {
    this.fetchImpl = fetchImpl; this.storage = storage; this.origin = origin; this.allowed = new Set(allowedPaths);
    this.requests = []; this.unexpected = []; this.before = this.snapshot();
  }
  snapshot() {
    const out = {};
    try { if (this.storage) for (let i = 0; i < this.storage.length; i++) { const k = this.storage.key(i); out[k] = String(this.storage.getItem(k)).length + ":" + String(this.storage.getItem(k)).slice(0, 40); } } catch (_) {}
    return out;
  }
  classify(url, method) {
    let u; try { u = new URL(url, this.origin || "http://local.invalid"); } catch (_) { return "unparseable address"; }
    const sameOrigin = !this.origin || u.origin === new URL(this.origin).origin;
    if (!sameOrigin) return "request to another origin (" + u.host + ")";
    if (!this.allowed.has(u.pathname)) return "request to a path that is not an allowed read-only call (" + u.pathname + ")";
    if (String(method || "GET").toUpperCase() !== "POST") return "unexpected method " + method;
    return "";
  }
  wrap() {
    return async (url, init = {}) => {
      const method = (init && init.method) || "GET", why = this.classify(String(url && url.url || url), method), t0 = Date.now();
      const rec = { method, url: String(url && url.url || url), at: t0 };
      this.requests.push(rec); if (why) this.unexpected.push({ kind: "network", detail: why, url: rec.url });
      try { const r = await this.fetchImpl(url, init); rec.status = r.status; rec.ms = Date.now() - t0; return r; } catch (e) { rec.error = String(e && e.message || e); throw e; }
    };
  }
  storageChanges() {
    const after = this.snapshot(), out = [];
    for (const k of Object.keys(after)) if (!(k in this.before)) out.push({ kind: "storage", detail: "key added: " + k }); else if (this.before[k] !== after[k]) out.push({ kind: "storage", detail: "key changed: " + k });
    for (const k of Object.keys(this.before)) if (!(k in after)) out.push({ kind: "storage", detail: "key removed: " + k });
    return out;
  }
  report() {
    const st = this.storageChanges();
    return { requests: this.requests.length, request_list: this.requests.map((r) => ({ method: r.method, url: r.url, status: r.status })), unexpected: this.unexpected.concat(st), storage_changed: st.length > 0, writes_attempted: 0 };
  }
}

export class BrowserRuntime {
  constructor({ base = "", fetchImpl = null, deviceHandlers = {}, storage = null, tz = "", origin = "" } = {}) {
    this.id = "browser"; this.dryRun = false; this.readOnly = true; // declared, but the executor and the server gate enforce it independently
    this.deviceHandlers = deviceHandlers; this.base = base; this.tz = tz;
    const raw = fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    this.monitor = new SideEffectMonitor({ fetchImpl: raw, storage, origin: origin || (typeof location !== "undefined" ? location.origin : "") });
    this.fetch = this.monitor.wrap();
  }
  get touched() { return this.monitor.report().unexpected; }
  report() { return this.monitor.report(); }
  supports(tool) { return SERVER_TOOLS.has(tool.name) || typeof this.deviceHandlers[tool.name] === "function"; }
  async run(step, tool, input, ctx = {}) {
    if (typeof this.deviceHandlers[tool.name] === "function") {
      try { return { ok: true, output: await this.deviceHandlers[tool.name](input, ctx) }; }
      catch (e) { return { ok: false, error: String((e && e.message) || e), retryable: false }; }
    }
    let r;
    try { r = await this.fetch(this.base + "/brain/tool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: tool.name, input, tz: this.tz }), signal: ctx.signal }); }
    catch (e) { if (ctx.signal && ctx.signal.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true }); return { ok: false, error: "network error: " + String((e && e.message) || e), retryable: true }; }
    let j = null; try { j = await r.json(); } catch (_) {}
    if (r.ok && j && j.ok) return { ok: true, output: j.output };
    const code = (j && j.code) || "http_" + r.status, msg = (j && j.reason) || "HTTP " + r.status;
    // a refusal by the server's gate, or a bad request, does not get better by repeating; a server error or rate limit might
    return { ok: false, error: code + ": " + msg, retryable: r.status >= 500 || r.status === 429 };
  }
}
