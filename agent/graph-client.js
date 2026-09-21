// NORIA GRAPH CLIENT — the persistent store over HTTP, with the same methods the runner uses locally.
// Every method is one call to POST /graph/op on the accounts worker, authenticated with the person's session token.
// A refusal by the store's rules (no such project, illegal transition…) throws with the server's reason; a network problem throws too, so
// the runner stops and the work stays exactly where it was (nothing is half-recorded: each operation is its own atomic step).
export function graphClient({ base, token, fetchImpl = null }) {
  const f = fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  const call = async (op, args) => {
    const r = await f(base.replace(/\/$/, "") + "/graph/op", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ op, args }) });
    let j = null; try { j = await r.json(); } catch (_) {}
    if (r.ok && j && j.ok) return j.result;
    throw Object.assign(new Error((j && (j.error || j.result)) || "graph request failed (" + r.status + ")"), { status: r.status });
  };
  return new Proxy({}, { get: (_, op) => (op === "then" ? undefined : (...args) => call(String(op), args)) });
}
