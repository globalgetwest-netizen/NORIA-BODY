// NORIA READ-ONLY GATE — the one place that decides what may run in a live (non-simulated) setting.
//
// It lives in the tool layer, not in any runtime. The executor calls it, and so does the server's tool route, so the same rules apply
// whether a step is started from the browser, a Worker or a background job. A runtime is never trusted to enforce permissions.
//
// Phase authorised by the owner (2026-09-21): READ-ONLY live execution. Nothing that changes anything outside Noria is permitted, and
// approval cannot override that: email, messages, calendar changes, purchases, deletion, account changes, publishing, database writes,
// arbitrary code execution and irreversible actions are all blocked here, whatever anyone approves.

import { testState } from "./tools.js";

export const LIVE_READONLY_AUTHORISED = true;  // read-only tools only
export const LIVE_ACTING_AUTHORISED = false;   // tools that act: not authorised

// tool: a registry record with .available (as returned by listTools). Returns { ok, code, reason }.
export function readOnlyLiveGate(tool) {
  const no = (code, reason) => ({ ok: false, code, reason });
  if (!tool) return no("unregistered", "the tool is not in the registry");
  if (tool.risk !== "read") return no("acting_tool", tool.name + " changes something outside Noria; acting tools are not authorised");
  if ((tool.permissions || []).includes("write")) return no("write_permission", tool.name + " declares write permission");
  if (tool.auth === "oauth") return no("needs_connection", tool.name + " needs an outside account connection, which is not authorised");
  if (!tool.live_read) return no("not_allowlisted", tool.name + " is not on the read-only live list");
  const ts = testState(tool);
  if (ts !== "automated" && ts !== "accepted") return no("untested", tool.name + " has no automated or accepted test (" + ts + ")");
  if (["not_built", "unsupported", "requires_auth"].includes(tool.available)) return no("unavailable", tool.name + " is " + tool.available);
  return { ok: true, code: "ok", reason: "" };
}
