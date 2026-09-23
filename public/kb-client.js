// The person's knowledge base from the browser: talks to /kb/… on the accounts worker with the person's own session.
// knowledgeSearchHandler() is what the browser runtime runs for the tool "knowledge.search" (read-only: it searches, it never changes anything).
export function kbClient({ base, token, fetchImpl = null }) {
  const f = fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  const call = async (path, body) => {
    const r = await f(base.replace(/\/$/, "") + path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token }, body: body === undefined ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (_) {}
    if (r.ok && j && j.ok) return j;
    throw Object.assign(new Error((j && j.error) || "knowledge request failed (" + r.status + ")"), { status: r.status, retryable: r.status >= 500 });
  };
  return { ingest: (doc) => call("/kb/ingest", doc), search: (q) => call("/kb/search", q), list: () => call("/kb/list"), remove: (docId) => call("/kb/delete", { doc_id: docId }) };
}
export function knowledgeSearchHandler(client) {
  return async (input) => {
    const r = await client.search({ query: input.query, collection: input.collection, k: input.k });
    return { passages: r.passages, mode: r.mode, embedder: r.embedder || null, chunks_searched: r.chunks_searched, note: r.note };
  };
}
