// NORIA EXECUTION RUNTIMES.
//
// The executor never calls a tool itself. It hands each step to a runtime through one contract, so the same planner, registry,
// executor and verifiers work with any runtime:
//
//   runtime = {
//     id:      "browser" | "server" | "simulated" | ...
//     dryRun:  true when the runtime can touch nothing real (the executor in dry-run mode refuses any runtime where this is false)
//     supports(tool) -> boolean                  can this runtime run this tool (tool.runtime lists "browser" and/or "server")
//     async run(step, tool, input, ctx) -> { ok, output, error?, retryable?, observation? }
//         ctx = { signal (AbortSignal), timeoutMs, attempt }
//   }
//
// SimulatedRuntime (below) is the dry-run runtime: it produces plausible, clearly-marked simulated outputs from each tool's declared
// output shape and can be scripted to fail, stall, return bad data or return hostile text, which is how the executor is tested.
// HandlerRuntime is the shape of a real runtime (a table of tool handlers). It is NOT used yet: real execution is not authorised.

const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal && signal.aborted) return rej(Object.assign(new Error("cancelled"), { cancelled: true }));
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener("abort", () => { clearTimeout(t); rej(Object.assign(new Error("cancelled"), { cancelled: true })); }, { once: true });
});

function simulate(tool) {
  const out = { simulated: true };
  for (const [k, spec] of Object.entries(tool.output || {})) {
    switch (spec.type) {
      case "string": out[k] = "[simulated " + tool.name + " " + k + "]"; break;
      case "number": out[k] = 0; break;
      case "boolean": out[k] = false; break;
      case "array": out[k] = k === "sources" || k === "passages" ? [{ title: "simulated source", url: "https://simulated.invalid/" + tool.name, date: new Date().toISOString().slice(0, 10), snippet: "simulated" }] : []; break;
      case "file": out[k] = { name: "simulated-file", simulated: true }; break;
      default: out[k] = {};
    }
  }
  if (tool.verify === "exact") out.exact = true;
  return out;
}

export class SimulatedRuntime {
  // behaviors: { "tool.name": (callNumber, input, ctx) => { ok?, output?, error?, retryable?, delayMs? } }  (callNumber counts from 1 per tool)
  constructor(behaviors = {}, opts = {}) {
    this.id = "simulated"; this.dryRun = true; this.behaviors = behaviors; this.calls = []; this.touched = []; // touched is always empty: nothing real is ever reached
    this.count = {}; this.running = 0; this.maxRunning = 0; this.supportedRuntimes = opts.runtimes || ["server", "browser"];
  }
  supports(tool) { return (tool.runtime || []).some((r) => this.supportedRuntimes.includes(r)); }
  async run(step, tool, input, ctx = {}) {
    const n = (this.count[tool.name] = (this.count[tool.name] || 0) + 1);
    this.calls.push({ task: step && step.id, tool: tool.name, input, attempt: ctx.attempt || 1, at: Date.now() });
    this.running++; this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      const b = this.behaviors[tool.name] ? this.behaviors[tool.name](n, input, ctx) : {};
      if (b.delayMs) await sleep(b.delayMs, ctx.signal);
      else if (ctx.signal && ctx.signal.aborted) throw Object.assign(new Error("cancelled"), { cancelled: true });
      if (b.error) return { ok: false, error: b.error, retryable: b.retryable !== false };
      return { ok: true, output: b.output !== undefined ? b.output : simulate(tool) };
    } catch (e) {
      if (e && e.cancelled) throw e;
      return { ok: false, error: String((e && e.message) || e), retryable: true };
    } finally { this.running--; }
  }
}

// The shape of a real runtime: handlers[toolName](input, ctx) does the work. Not enabled: the executor refuses it in dry-run mode.
export class HandlerRuntime {
  constructor(id, handlers, runtimes) { this.id = id; this.dryRun = false; this.handlers = handlers; this.runtimes = runtimes || [id]; }
  supports(tool) { return typeof this.handlers[tool.name] === "function" && (tool.runtime || []).some((r) => this.runtimes.includes(r)); }
  async run(step, tool, input, ctx) { const r = await this.handlers[tool.name](input, ctx); return { ok: true, output: r }; }
}
