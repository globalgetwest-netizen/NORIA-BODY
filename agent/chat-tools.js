// NORIA CHAT TOOL RUNTIME — Stage 4 of the owner's architecture direction (2026-10-01).
//
// A full, tested plan/execute/observe/verify/replan architecture already exists (planner.js, graph.js,
// executor.js, control.js, tools.js) but was completely disconnected from chat: /brain/ask never imported
// Controller/GraphRunner/Executor, and every chat capability (weather, fx, crypto, math...) was served by its own
// hardcoded function, bypassing the tool registry's schema, permission, risk, idempotency and audit machinery
// entirely — the "growing collection of hardcoded realityWeatherBlock, realityFxBlock, etc. decisions" the owner
// explicitly asked to stop building on top of.
//
// This is the smallest possible real bridge, not a demonstration: a genuine Runtime (the same interface
// GraphToolRuntime/CompositeRuntime already implement for the graph system — id, dryRun, readOnly, supports(tool),
// run(step, tool, input), touched, report()) that serves calc.math from chat by calling THIS FILE'S OWN
// agent/calc.js — the same implementation the registry already declares, already tests (calc_t.mjs), and already
// offers to any future agentic tool-caller. Deliberately starts with calc.math and NOT weather/fx/crypto: those
// carry a richer cross-source verdict model (VERIFIED/PARTIALLY_VERIFIED/CONFLICTING/STALE from agent/reality.js's
// resolveFacts) that does not map cleanly onto the Executor's simpler VERIFIERS.exact/schema/sources/temporal yet
// — reconciling those two trust models is real, separate, larger work (see families.js), not something to paper
// over to make this bridge look more finished than it is. calc.math has no such reconciliation needed: it is
// risk:"read", auth:"none", deterministic, and its own tests already prove correctness independently of any
// question of sourcing or freshness.
//
// A request that goes through this runtime genuinely passes every gate the Executor enforces (registry check,
// availability, input schema, permission, risk/approval, idempotency, execute, observe/sanitize, verify, recover)
// — this is not a relabelled direct function call. See chat_tool_bridge_t.mjs for the proof: it inspects the real
// audit log the Executor produces, not just the final answer.

export const CHAT_TOOL_NAMES = new Set(["calc.math"]);

export class ChatToolRuntime {
  constructor(deps) {
    this.id = "chat";
    this.dryRun = false;
    this.readOnly = true; // this runtime never serves a write-risk tool; enforced again by the shared gate regardless
    this.touched = [];
    this.calc = (deps && deps.safeCalc) || null;
  }
  supports(tool) { return CHAT_TOOL_NAMES.has(tool.name); }
  report() { return { requests: 0, unexpected: [], storage_changed: false, internal_store_only: true }; }
  async run(step, tool, input) {
    if (tool.name === "calc.math") {
      if (!this.calc) return { ok: false, error: "no calculator implementation was provided", retryable: false };
      let r; try { r = this.calc(input && input.expression); } catch (e) { return { ok: false, error: String((e && e.message) || e), retryable: false }; }
      if (!r) return { ok: false, error: "not a plain calculation the clock, calculator or reference library can answer", retryable: false };
      if (r.error) return { ok: false, error: r.error, retryable: false }; // e.g. division by zero: refused, never guessed
      return { ok: true, output: { value: r.value, answer: r.text } };
    }
    return { ok: false, error: "not a chat-served tool", retryable: false };
  }
}
