// NORIA GRAPH TOOLS — the tools that work on the project's own store: artifacts and project notes.
//
// They change nothing outside Noria (the person's own project data, which they can view, correct and delete), so they are read-only in the
// sense the gate cares about: no email, no message, no purchase, no outside account. They run through the same executor gates as every other
// tool. The runner supplies a runtime that serves them (GraphToolRuntime) next to the runtime that serves the rest (CompositeRuntime).

export const GRAPH_TOOL_NAMES = new Set(["artifact.write", "artifact.read", "project.note"]);

// dry: true simulates (used with a dry-run runtime), so nothing is written.
export class GraphToolRuntime {
  constructor(store, { projectId, objectiveId }, dry = false) { this.id = "graph"; this.store = store; this.projectId = projectId; this.objectiveId = objectiveId; this.dryRun = !!dry; this.readOnly = true; this.touched = []; }
  supports(tool) { return GRAPH_TOOL_NAMES.has(tool.name); }
  report() { return { requests: 0, unexpected: [], storage_changed: false, internal_store_only: true }; }
  async run(step, tool, input) {
    const taskKey = step && step.id;
    try {
      if (tool.name === "artifact.write") {
        if (this.dryRun) return { ok: true, output: { simulated: true, artifact: { name: input.name, version: 0, sha256: "simulated" } } };
        const a = await this.store.addArtifact(this.projectId, { objectiveId: this.objectiveId, taskKey, name: input.name, kind: input.kind || "text", content: input.content });
        return { ok: true, output: { artifact: { name: a.name, version: a.version, sha256: a.sha256 } } };
      }
      if (tool.name === "artifact.read") {
        const a = await this.store.getArtifact(this.projectId, input.name, input.version || undefined);
        if (!a) return { ok: false, error: "no artifact named " + input.name + (input.version ? " version " + input.version : ""), retryable: false };
        return { ok: true, output: { content: a.content, version: a.version } };
      }
      if (tool.name === "project.note") {
        if (this.dryRun) return { ok: true, output: { simulated: true, saved: true } };
        await this.store.memSet(this.projectId, String(input.key), input.value, "task:" + taskKey);
        return { ok: true, output: { saved: true } };
      }
    } catch (e) { return { ok: false, error: String((e && e.message) || e), retryable: false }; }
    return { ok: false, error: "not a graph tool", retryable: false };
  }
}

// Serves each tool from the first runtime that supports it. The composite is a simulation only if every part is; it reads only if every part does.
export class CompositeRuntime {
  constructor(runtimes) { this.runtimes = runtimes; this.id = runtimes.map((r) => r.id).join("+"); this.dryRun = runtimes.every((r) => r.dryRun === true); this.readOnly = runtimes.every((r) => r.readOnly === true || r.dryRun === true); }
  supports(tool) { return this.runtimes.some((r) => r.supports(tool)); }
  async run(step, tool, input, ctx) { const r = this.runtimes.find((x) => x.supports(tool)); return r.run(step, tool, input, ctx); }
  get touched() { return this.runtimes.flatMap((r) => (Array.isArray(r.touched) ? r.touched : [])); }
  report() { const reps = this.runtimes.map((r) => (typeof r.report === "function" ? r.report() : null)).filter(Boolean); return reps.length ? reps[reps.length - 1] : null; }
  get calls() { return this.runtimes.flatMap((r) => r.calls || []); }
}
