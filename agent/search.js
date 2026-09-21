// NORIA SEARCH LAYER — provider-agnostic.
//
// Noria must never depend on one search provider. A provider is a small object; the runner calls every enabled provider at the
// same time and gives each its own timeout, retry policy and quota awareness. A provider that is out of quota or failing is skipped
// for a while (so it costs no time), its state is remembered in a shared store, and the others carry on. Adding a provider is one
// entry in the provider list; nothing else changes.
//
//   provider = {
//     id:        "tavily",                       unique name
//     kind:      "web" | "wiki" | "news" | "official" | "specialized",
//     enabled:   (env) => boolean,               false when its credential is not configured (credentials live in secrets only)
//     run:       async (q, env, opts) => Array,  items { title, snippet, url, date }; return null (or throw) on failure
//     timeoutMs: 6000,
//     retry:     { max: 1, backoffMs: 250 },     extra attempts after a failure (not after an empty answer)
//     quotaPauseMs: 1800000,                     how long to skip it after a quota-type error (401/402/403/429)
//   }
//
// Health store: { get(key) -> object|null, put(key, object, ttlSeconds) }. In the worker it is Cloudflare's Cache API.

// 401/403 bad or revoked key, 402 payment, 429 rate limit, 432/433 Tavily "plan limit exceeded" / "pay-as-you-go limit exceeded"
const QUOTA_STATUS = new Set([401, 402, 403, 429, 432, 433]);
const now = () => Date.now();

export function validateProvider(p) {
  const problems = [];
  if (!p || typeof p.id !== "string" || !p.id) problems.push("id");
  if (!["web", "wiki", "news", "official", "specialized"].includes(p && p.kind)) problems.push("kind");
  if (typeof (p && p.enabled) !== "function") problems.push("enabled");
  if (typeof (p && p.run) !== "function") problems.push("run");
  return problems;
}

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { timeout: true })), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}

// Runs one provider under its policy. Never throws: always returns a status record.
async function runOne(p, q, env, opts, store) {
  const t0 = now();
  const healthKey = "health/search/" + p.id;
  const prior = store ? await store.get(healthKey).catch(() => null) : null;
  if (prior && prior.quotaUntil && prior.quotaUntil > t0) return { id: p.id, kind: p.kind, status: "paused", items: [], ms: 0, error: "quota", quotaUntil: prior.quotaUntil };
  const tries = 1 + Math.max(0, (p.retry && p.retry.max) || 0);
  let items = null, lastErr = null;
  for (let a = 0; a < tries; a++) {
    try {
      const r = await withTimeout(Promise.resolve(p.run(q, env, opts)), p.timeoutMs || 6000);
      if (r === null || r === undefined) { lastErr = { message: "failed" }; }
      else { items = Array.isArray(r) ? r : []; lastErr = null; break; }
    } catch (e) {
      lastErr = { message: String((e && e.message) || e).slice(0, 120), status: e && e.status, timeout: !!(e && e.timeout) };
      if (lastErr.status && QUOTA_STATUS.has(Number(lastErr.status))) break; // retrying an exhausted quota only wastes time
    }
    if (a < tries - 1) await new Promise((r) => setTimeout(r, (p.retry && p.retry.backoffMs) || 200));
  }
  const ms = now() - t0;
  const ok = items !== null;
  const quota = !!(lastErr && lastErr.status && QUOTA_STATUS.has(Number(lastErr.status)));
  const record = { ok, n: ok ? items.length : 0, t: now(), ms, error: ok ? "" : lastErr.message, status: lastErr && lastErr.status ? Number(lastErr.status) : 0, quotaUntil: quota ? now() + (p.quotaPauseMs || 1800000) : 0 };
  if (store) { try { await store.put(healthKey, record, 3600); } catch (_) {} }
  return { id: p.id, kind: p.kind, status: ok ? (items.length ? "ok" : "empty") : quota ? "quota" : lastErr.timeout ? "timeout" : "failed", items: items || [], ms, error: record.error };
}

// Calls every enabled provider at once. opts.kinds (optional) limits the kinds, opts.skip is a list of provider ids to leave out.
export async function runProviders(providers, q, env, opts = {}, store = null) {
  const active = providers.filter((p) => {
    if (validateProvider(p).length) return false;
    if (opts.skip && opts.skip.includes(p.id)) return false;
    if (opts.kinds && !opts.kinds.includes(p.kind)) return false;
    try { return !!p.enabled(env); } catch (_) { return false; }
  });
  const skipped = providers.filter((p) => !active.includes(p)).map((p) => ({ id: p.id, kind: p.kind, status: "disabled", items: [], ms: 0 }));
  const ran = await Promise.all(active.map((p) => runOne(p, q, env, opts, store)));
  return { providers: ran.concat(skipped), items: mergeProviderResults(ran, opts.order) };
}

// One list from all providers: each item is tagged with where it came from (provenance), duplicates (same URL or same title) are
// dropped, and providers earlier in `order` (a list of kinds) win a duplicate.
export function mergeProviderResults(ran, order) {
  const kinds = order || ["official", "web", "wiki", "news", "specialized"];
  const rank = (k) => { const i = kinds.indexOf(k); return i < 0 ? kinds.length : i; };
  const seen = new Set(), out = [];
  for (const r of ran.slice().sort((a, b) => rank(a.kind) - rank(b.kind))) {
    for (const x of r.items || []) {
      const key = String((x && (x.url || x.title)) || "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[/#?].*$/, "") + "|" + String((x && x.title) || "").toLowerCase().slice(0, 60);
      if (!x || !x.title || seen.has(key)) continue;
      seen.add(key);
      out.push(Object.assign({}, x, { src: r.kind, via: r.id }));
    }
  }
  return out;
}

// ── HEALTH ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A provider is only OK when there is a FRESH successful observation. What the records say:
//   ok       succeeded within the freshness window
//   quota    out of allowance right now (paused)                    -> degraded
//   failing  failed within the freshness window                     -> degraded
//   unknown  never observed, or the last observation is older than the window: nothing is assumed
//   not_configured   no credential set
// An unknown provider may still be TRIED (the attempt is the observation), but it is never reported as healthy.
export const FRESH_MS = 15 * 60 * 1000;

export function providerState(enabled, h, nowMs = now(), freshMs = FRESH_MS) {
  if (!enabled) return "not_configured";
  if (!h) return "unknown";
  if (h.quotaUntil && h.quotaUntil > nowMs) return "quota";
  if (nowMs - h.t > freshMs) return "unknown";
  return h.ok ? "ok" : "failing";
}

export async function searchHealth(providers, env, store, opts = {}) {
  const nowMs = opts.now || now(), freshMs = opts.freshMs || FRESH_MS, rows = [];
  for (const p of providers) {
    let enabled = false; try { enabled = !!p.enabled(env); } catch (_) {}
    const h = store ? await store.get("health/search/" + p.id).catch(() => null) : null;
    rows.push({ id: p.id, kind: p.kind, enabled, state: providerState(enabled, h, nowMs, freshMs), lastOk: h ? !!h.ok : null, lastResults: h ? h.n : null, lastCheck: h ? new Date(h.t).toISOString() : null, ageSeconds: h ? Math.round((nowMs - h.t) / 1000) : null, error: h && !h.ok ? h.error : "", httpStatus: h && !h.ok && h.status ? h.status : 0 });
  }
  // The open web: ok if any web/official provider has a fresh success; degraded if every configured one is observed failing or out of quota;
  // otherwise unknown (including "none configured": it cannot be called healthy).
  const web = rows.filter((r) => (r.kind === "web" || r.kind === "official") && r.enabled);
  const webState = web.some((r) => r.state === "ok") ? "ok" : web.length && web.every((r) => r.state === "quota" || r.state === "failing") ? "degraded" : "unknown";
  const any = rows.filter((r) => r.enabled);
  const anyState = any.some((r) => r.state === "ok") ? "ok" : any.length && any.every((r) => r.state === "quota" || r.state === "failing") ? "degraded" : "unknown";
  return { providers: rows, webState, anyState, webOk: webState === "ok", anyOk: anyState === "ok" };
}

// Observes providers whose state is unknown by making one small real call, at most once per lockSeconds each (so a status page cannot
// spend the allowance). Providers that are paused for quota are not probed. Returns the ids probed.
export async function probeUnknown(providers, env, store, opts = {}) {
  if (!store) return [];
  const lock = opts.lockSeconds || 600, q = opts.query || "noria health check", probed = [], nowMs = opts.now || now();
  await Promise.all(providers.map(async (p) => {
    let enabled = false; try { enabled = !!p.enabled(env); } catch (_) {}
    if (!enabled) return;
    const h = await store.get("health/search/" + p.id).catch(() => null);
    if (providerState(true, h, nowMs, opts.freshMs || FRESH_MS) !== "unknown") return;
    const locked = await store.get("probe/" + p.id).catch(() => null);
    if (locked && nowMs - locked.t < lock * 1000) return;
    await store.put("probe/" + p.id, { t: nowMs }, lock);
    await runOne(p, q, env, {}, store); probed.push(p.id);
  }));
  return probed;
}
