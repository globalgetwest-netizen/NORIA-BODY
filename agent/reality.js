// NORIA REALITY LAYER — the part that decides whether a piece of real-world information may be stated as fact.
//
//   retrieve -> authenticate (who says so, how authoritative) -> compare (do independent sources agree) -> validate (still fresh?) ->
//   timestamp -> reason -> answer (or refuse)
//
// The language model is the reasoning and communication layer, NOT the source of truth. Nothing in here calls a model or the network:
// it takes facts that were retrieved (each with a "data passport") and returns a verdict with a status the model is not allowed to overrule.
//
//   VERIFIED            independent authoritative sources agree, or one official source of record answered, and it is fresh
//   PARTIALLY_VERIFIED  one credible non-official source, fresh: it may be stated WITH the caveat that nothing confirms it
//   CONFLICTING         authoritative sources disagree and the disagreement cannot be explained (no value is stated)
//   STALE               the only answers are older than their validity window (no value is stated as current)
//   UNAVAILABLE         no source answered
//   UNVERIFIED          only general-web or user-supplied claims exist (never promoted to fact)
//   UNKNOWN             nothing is known, or the question could not be resolved to an entity
//
// "Zero errors" cannot honestly be promised for arbitrary real-world data: official sources are delayed, corrected or wrong. What this layer
// guarantees is narrower and checkable: Noria does not knowingly present unverified or conflicting information as fact, and every value it
// does state can be traced to its sources, their authority and the time they were observed.

// ── 1. authority ─────────────────────────────────────────────────────────────────────────────────────────────────────
export const AUTHORITY = {
  1: { name: "Primary / official", examples: "government agency, central bank, official exchange, airline, airport, embassy, court, official meteorological service" },
  2: { name: "Licensed authoritative data provider", examples: "professional market, weather, aviation, mapping feeds; established data aggregators" },
  3: { name: "Established secondary source", examples: "major news organisations, academic databases, encyclopaedias, professional publications" },
  4: { name: "General web", examples: "blogs, forums, social media, unverified websites" },
  5: { name: "User-generated claim", examples: "what a person said in a message: a claim, never automatically a fact" },
};
export const STATUS = { VERIFIED: "VERIFIED", PARTIALLY_VERIFIED: "PARTIALLY_VERIFIED", CONFLICTING: "CONFLICTING", STALE: "STALE", UNAVAILABLE: "UNAVAILABLE", UNVERIFIED: "UNVERIFIED", UNKNOWN: "UNKNOWN" };
// which statuses allow a value to be stated as fact (with a caveat for PARTIALLY_VERIFIED)
export const ANSWERABLE = new Set(["VERIFIED", "PARTIALLY_VERIFIED"]);
const WEIGHT = { 1: 3, 2: 2, 3: 1, 4: 0.25, 5: 0 };

// The sources Noria knows about. "family" is the provider behind the data: two sources with the same family are NOT independent.
// "system" keeps knowledge (stable), live (changing) and private (the person's own) apart: they are never mixed in one verification.
export const SOURCES = {
  "open-meteo": { name: "Open-Meteo", level: 2, family: "open-meteo", kind: "weather-model", system: "live", domains: ["weather"], refresh: "about every 15 minutes", home: "https://open-meteo.com" },
  "met-no": { name: "MET Norway (Norwegian Meteorological Institute)", level: 1, family: "met-no", kind: "national meteorological service", system: "live", domains: ["weather"], refresh: "hourly", home: "https://api.met.no" },
  "open-er-api": { name: "Open exchange-rate feed (open.er-api.com)", level: 2, family: "er-api", kind: "rate aggregator", system: "live", domains: ["fx"], refresh: "once a day", home: "https://open.er-api.com" },
  "currency-api": { name: "Currency API (community CDN feed)", level: 2, family: "currency-api", kind: "rate aggregator", system: "live", domains: ["fx"], refresh: "once a day", home: "https://github.com/fawazahmed0/exchange-api" },
  "ecb": { name: "European Central Bank reference rates (via Frankfurter)", level: 1, family: "ecb", kind: "central bank", system: "live", domains: ["fx"], refresh: "business days about 16:00 CET", home: "https://www.ecb.europa.eu" },
  "coinbase": { name: "Coinbase", level: 1, family: "coinbase", kind: "exchange", system: "live", domains: ["crypto"], refresh: "live", home: "https://www.coinbase.com" },
  "kraken": { name: "Kraken", level: 1, family: "kraken", kind: "exchange", system: "live", domains: ["crypto"], refresh: "live", home: "https://www.kraken.com" },
  "binance": { name: "Binance", level: 1, family: "binance", kind: "exchange", system: "live", domains: ["crypto"], refresh: "live", home: "https://www.binance.com" },
  "coingecko": { name: "CoinGecko", level: 2, family: "coingecko", kind: "market data aggregator", system: "live", domains: ["crypto"], refresh: "about every minute", home: "https://www.coingecko.com" },
  "nasdaq": { name: "Nasdaq (public quote API)", level: 1, family: "nasdaq", kind: "official exchange", system: "live", domains: ["stock"], refresh: "live", home: "https://www.nasdaq.com" },
  "yahoo": { name: "Yahoo Finance", level: 2, family: "yahoo", kind: "market data aggregator", system: "live", domains: ["stock"], refresh: "live", home: "https://finance.yahoo.com" },
  "worldbank": { name: "World Bank Open Data", level: 1, family: "worldbank", kind: "international statistical agency", system: "live", domains: ["country_fact"], refresh: "annual (most indicators)", home: "https://data.worldbank.org" },
  "clock": { name: "Noria calculator and calendar (computed, not looked up)", level: 1, family: "computed", kind: "computation", system: "knowledge", domains: ["time", "arithmetic"], refresh: "exact", home: "" },
  "wikipedia": { name: "Wikipedia", level: 3, family: "wikipedia", kind: "encyclopaedia", system: "live", domains: ["general"], refresh: "edited continuously", home: "https://www.wikipedia.org" },
  "news-feeds": { name: "Published news feeds", level: 3, family: "news", kind: "news organisations", system: "live", domains: ["news"], refresh: "minutes to hours", home: "" },
  "web": { name: "Open web search result", level: 4, family: "web", kind: "general web", system: "live", domains: ["general"], refresh: "unknown", home: "" },
  "user-claim": { name: "A claim made by the person", level: 5, family: "user", kind: "user-generated", system: "private", domains: ["any"], refresh: "n/a", home: "" },
};

// The level of an arbitrary web address: official domains rank first, established publishers next, everything else is general web.
const OFFICIAL_HOST = /(?:^|\.)(?:gov(?:\.[a-z]{2})?|go\.[a-z]{2}|gouv\.[a-z]{2}|gob\.[a-z]{2}|gc\.ca|europa\.eu|int|mil|un\.org|worldbank\.org|imf\.org|who\.int|bog\.gov\.gh|sec\.gov|fca\.org\.uk)$/i;
const PUBLISHER_HOST = /(?:^|\.)(?:reuters\.com|apnews\.com|bbc\.(?:com|co\.uk)|nature\.com|science\.org|thelancet\.com|nejm\.org|ft\.com|economist\.com|bloomberg\.com|aljazeera\.com|wikipedia\.org|britannica\.com|ghanaweb\.com|myjoyonline\.com|graphic\.com\.gh|citinewsroom\.com|nytimes\.com|theguardian\.com|dw\.com|france24\.com|pubmed\.ncbi\.nlm\.nih\.gov|nih\.gov|cdc\.gov)$/i;
export function classifyUrl(url) {
  let host = ""; try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch (_) { return { level: 4, official: false, host: "" }; }
  if (OFFICIAL_HOST.test(host)) return { level: 1, official: true, host };
  if (/\.edu(?:\.[a-z]{2})?$|\.ac\.[a-z]{2}$/i.test(host) || PUBLISHER_HOST.test(host)) return { level: 3, official: false, host };
  return { level: 4, official: false, host };
}

// ── 2. freshness: how long a kind of information stays true ──────────────────────────────────────────────────────────
const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
export const FRESHNESS = {
  flight_status: { maxAgeMs: 5 * M, label: "seconds to minutes" }, traffic: { maxAgeMs: 5 * M, label: "seconds to minutes" },
  stock_price: { maxAgeMs: 15 * S, label: "seconds" }, crypto: { maxAgeMs: 3 * M, label: "minutes" },
  fx_market: { maxAgeMs: 5 * M, label: "seconds to minutes" },
  // the free rate feeds publish once a day: their honest window is a day and a half, and the answer says it is a daily reference rate, not a trading price
  fx: { maxAgeMs: 36 * H, label: "one day (daily reference rate, not a live trading price)" },
  weather: { maxAgeMs: 75 * M, label: "about an hour (official data is hourly)" }, news: { maxAgeMs: 6 * H, label: "minutes to hours" },
  government_announcement: { maxAgeMs: 3 * D, label: "hours to days" }, company_registration: { maxAgeMs: 90 * D, label: "days to months" },
  appointment_availability: { maxAgeMs: 10 * M, label: "minutes" }, time: { maxAgeMs: 1 * S, label: "exact" }, arithmetic: { maxAgeMs: Infinity, label: "permanent" },
  historical: { maxAgeMs: Infinity, label: "permanent" }, general: { maxAgeMs: 30 * D, label: "days to months" },
  // National statistics (population, GDP, life expectancy, literacy) are reported annually and lag by
  // design — a figure "for 2025" published in mid-2026 is the most current real figure that exists, not
  // stale data. The window is generous (a few years) so normal reporting lag is never mistaken for staleness,
  // but still bounded, so a genuinely superseded, years-old figure is not presented as current either.
  country_fact: { maxAgeMs: 3 * 365 * D, label: "up to a few years (annual national statistics lag by design)" },
  // Survey-based indicators (adult literacy, and similar figures only collected by periodic household
  // surveys, not compiled annually) genuinely lag much further — World Bank's own live figure for Chad's
  // literacy rate, checked 2026-09-24, was still dated 2019. A 3-year window would wrongly withhold the
  // real, best-available figure for most countries most of the time; ten years reflects the real cadence.
  country_fact_survey: { maxAgeMs: 10 * 365 * D, label: "up to about a decade (measured by infrequent household surveys, not compiled annually)" },
};
export function freshnessOf(passport, domain, now = Date.now()) {
  const pol = FRESHNESS[domain] || FRESHNESS.general, at = passport.source_updated_at || passport.published_at || passport.retrieved_at;
  if (at == null || !isFinite(at)) return { state: "unknown", age_ms: null, max_age_ms: pol.maxAgeMs };
  const age = Math.max(0, now - at);
  return { state: age <= pol.maxAgeMs ? "fresh" : "stale", age_ms: age, max_age_ms: pol.maxAgeMs };
}

// ── 3. the data passport ─────────────────────────────────────────────────────────────────────────────────────────────
function fnv(str) { let a = 0x811c9dc5, b = 0x01000193 ^ 0x9e37; for (let i = 0; i < str.length; i++) { a ^= str.charCodeAt(i); a = Math.imul(a, 16777619) >>> 0; b ^= str.charCodeAt(i) + i; b = Math.imul(b, 2246822519) >>> 0; } return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0"); }
// A fact enters Noria only with its passport: what, from whom, how authoritative, when it was true, when it was retrieved, for how long it is valid.
export function makePassport(f, now = Date.now()) {
  const src = SOURCES[f.source] || { name: f.source_name || String(f.source || "unknown"), level: f.level || 4, family: String(f.source || "unknown"), kind: "unknown", system: "live" };
  const level = f.level || src.level, retrieved = f.retrieved_at == null ? now : f.retrieved_at;
  const p = {
    fact_id: "fact_" + fnv([f.entity, f.attribute, JSON.stringify(f.value), f.source, retrieved].join("|")),
    entity: f.entity, attribute: f.attribute, value: f.value === undefined ? null : f.value, unit: f.unit || null,
    source: { id: f.source, name: src.name, level, level_name: AUTHORITY[level].name, family: f.family || src.family, kind: src.kind, home: src.home || "" },
    system: f.system || src.system || "live", basis: f.basis || "default", location: f.location || null,
    published_at: f.published_at == null ? null : f.published_at, source_updated_at: f.source_updated_at == null ? null : f.source_updated_at, retrieved_at: retrieved,
    valid_for_ms: f.valid_for_ms == null ? (FRESHNESS[f.domain] || FRESHNESS.general).maxAgeMs : f.valid_for_ms, data_version: f.data_version || null, domain: f.domain || "general", note: f.note || "",
  };
  const basisAt = p.source_updated_at || p.published_at || p.retrieved_at;
  p.expires_at = isFinite(p.valid_for_ms) ? basisAt + p.valid_for_ms : null;
  p.freshness = freshnessOf(p, p.domain, now);
  return p;
}

// ── 4. comparing values ──────────────────────────────────────────────────────────────────────────────────────────────
// tol: { rel } relative (0.01 = 1 %), { abs } absolute, or neither for exact equality (strings, booleans).
export function close(a, b, tol = {}) {
  if (typeof a === "number" && typeof b === "number") { const d = Math.abs(a - b); if (tol.abs != null && d <= tol.abs) return true; if (tol.rel != null && d <= tol.rel * Math.max(Math.abs(a), Math.abs(b))) return true; return a === b; }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function weightedMedian(items) { // items: [{value, w}]
  const s = [...items].sort((a, b) => a.value - b.value), total = s.reduce((a, x) => a + x.w, 0); let acc = 0;
  for (const x of s) { acc += x.w; if (acc >= total / 2) return x.value; }
  return s[s.length - 1].value;
}

// ── 5. source lock: critical domains may only be answered from approved sources ─────────────────────────────────────
export const LOCKS = {
  immigration: { maxLevel: 1, why: "visa, immigration and appointment rules must come from the official authority, embassy or official appointment provider" },
  legal: { maxLevel: 1, why: "law must come from legislation, courts or regulators" },
  medical: { maxLevel: 2, why: "medical claims must come from authoritative medical or scientific sources", allowHosts: /(?:who\.int|nih\.gov|cdc\.gov|nhs\.uk|nice\.org\.uk|cochrane|nejm\.org|thelancet\.com|bmj\.com|pubmed|ghanahealthservice\.org|ghs\.gov\.gh)/i },
  financial: { maxLevel: 2, why: "prices and rates must come from official or licensed financial sources" },
};
const LOCK_WORDS = {
  immigration: /\b(visa|passport|immigration|embassy|consulate|consular|residence permit|work permit|asylum|border|schengen|appointment (?:slot|system|booking)|type d)\b/i,
  legal: /\b(law|legal|legislation|statute|court|judgement|judgment|regulation|lawsuit|contract law|tax law|is it legal|illegal)\b/i,
  medical: /\b(dosage|dose|symptom|diagnos|treatment|medicine|medication|side effects?|vaccine|disease|infection|cancer|pregnan|clinical|drug interaction)\b/i,
  financial: /\b(exchange rate|interest rate|stock|share price|dividend|inflation rate|central bank|bond yield|mortgage rate)\b/i,
};
export function detectLockDomain(text) { const t = String(text || ""); for (const d of ["immigration", "medical", "legal", "financial"]) if (LOCK_WORDS[d].test(t)) return d; return null; }
export function admissible(domain, source) { // source: a passport.source or {level, home/host}
  const lock = LOCKS[domain]; if (!lock) return { ok: true };
  const host = source.host || (() => { try { return new URL(source.home || source.url || "").hostname; } catch (_) { return ""; } })();
  if (source.level <= lock.maxLevel) return { ok: true };
  if (lock.allowHosts && lock.allowHosts.test(host)) return { ok: true };
  return { ok: false, why: "not admissible for " + domain + " questions: " + lock.why };
}

// ── 6. resolving a set of facts into one verdict ─────────────────────────────────────────────────────────────────────
// passports: makePassport() results for the SAME entity and attribute. opts: { domain, tol, now, lockDomain, minAgree, basis, entity, attribute }
export function resolveFacts(passports, opts = {}) {
  const now = opts.now == null ? Date.now() : opts.now, domain = opts.domain || "general", tol = opts.tol || {}, excluded = [], reasons = [];
  const all = (passports || []).map((p) => ({ ...p, freshness: freshnessOf(p, p.domain || domain, now) }));
  const base = { entity: opts.entity || (all[0] && all[0].entity) || null, attribute: opts.attribute || (all[0] && all[0].attribute) || null, domain, checked_at: now, considered: all.length };
  const out = (status, extra = {}) => finish({ ...base, status, ...extra, excluded, reasons: [...(extra.reasons || []), ...reasons] }, all);
  // nothing answered
  const answered = all.filter((p) => p.value !== null && p.value !== undefined);
  if (!answered.length) return out(all.length ? STATUS.UNAVAILABLE : STATUS.UNKNOWN, { value: null, reasons: [all.length ? "no source returned a value" : "no source was asked or none could be matched to this question"] });
  // the three knowledge systems are never mixed
  const systems = [...new Set(answered.map((p) => p.system))];
  let pool = answered;
  if (systems.length > 1) { const keep = opts.system || "live"; pool = answered.filter((p) => p.system === keep); for (const p of answered) if (p.system !== keep) excluded.push({ fact_id: p.fact_id, source: p.source.id, reason: "belongs to the " + p.system + " system, which is never mixed into a " + keep + " verification" }); }
  // source lock
  if (opts.lockDomain) { const kept = []; for (const p of pool) { const a = admissible(opts.lockDomain, { level: p.source.level, home: p.source.home, host: p.source.host }); if (a.ok) kept.push(p); else excluded.push({ fact_id: p.fact_id, source: p.source.id, reason: a.why }); } pool = kept; if (!pool.length) return out(STATUS.UNVERIFIED, { value: null, reasons: ["no admissible source for a " + opts.lockDomain + " question was found (" + LOCKS[opts.lockDomain].why + ")"] }); }
  // user claims and general web never become facts
  const credible = pool.filter((p) => p.source.level <= 3);
  if (!credible.length) return out(STATUS.UNVERIFIED, { value: null, candidates: pool.map((p) => ({ fact_id: p.fact_id, value: p.value, source: p.source.id, level: p.source.level })), reasons: ["only general-web or user-supplied claims exist: they are shown as claims, never as fact"] });
  // freshness
  const fresh = credible.filter((p) => p.freshness.state === "fresh"), unknownAge = credible.filter((p) => p.freshness.state === "unknown");
  for (const p of credible) if (p.freshness.state === "stale") excluded.push({ fact_id: p.fact_id, source: p.source.id, reason: "older than its validity window (" + Math.round(p.freshness.age_ms / 60000) + " minutes old; valid for " + (isFinite(p.freshness.max_age_ms) ? Math.round(p.freshness.max_age_ms / 60000) + " minutes" : "ever") + ")" });
  const usable = [...fresh, ...unknownAge.filter(() => opts.allowUnknownAge)];
  if (!usable.length) { const last = [...credible].sort((a, b) => (b.retrieved_at) - (a.retrieved_at))[0]; return out(STATUS.STALE, { value: null, last_known: { value: last.value, unit: last.unit, source: last.source.id, as_of: last.source_updated_at || last.published_at || last.retrieved_at }, reasons: ["every answer found is older than it may be to count as current"] }); }
  // one basis at a time: a retail rate and a market rate are different things
  const wantBasis = opts.basis || usable.slice().sort((a, b) => a.source.level - b.source.level || (WEIGHT[b.source.level] - WEIGHT[a.source.level]))[0].basis;
  const sameBasis = [];
  for (const p of usable) { if (p.basis === wantBasis) sameBasis.push(p); else excluded.push({ fact_id: p.fact_id, source: p.source.id, reason: "measures a different basis (" + p.basis + " rather than " + wantBasis + "), so it is not comparable" }); }
  // cluster values that agree within tolerance
  const numeric = sameBasis.every((p) => typeof p.value === "number");
  const clusters = [];
  const sorted = numeric ? [...sameBasis].sort((a, b) => a.value - b.value) : [...sameBasis];
  for (const p of sorted) { const c = clusters.find((k) => close(k.center, p.value, tol)); if (c) { c.members.push(p); c.center = numeric ? median(c.members.map((x) => x.value)) : c.center; } else clusters.push({ center: p.value, members: [p] }); }
  for (const c of clusters) { c.families = new Set(c.members.map((m) => m.source.family)).size; c.bestLevel = Math.min(...c.members.map((m) => m.source.level)); c.weight = c.members.reduce((a, m) => a + WEIGHT[m.source.level], 0); }
  clusters.sort((a, b) => a.bestLevel - b.bestLevel || b.families - a.families || b.weight - a.weight);
  const win = clusters[0], rest = clusters.slice(1);
  const supporters = win.members.map((m) => m.fact_id), dissent = rest.flatMap((c) => c.members);
  const stronger = rest.find((c) => c.bestLevel <= win.bestLevel && (c.families >= win.families));
  if (rest.length && stronger) return out(STATUS.CONFLICTING, { value: null, candidates: clusters.map((c) => ({ value: c.center, sources: c.members.map((m) => m.source.id), best_level: c.bestLevel, independent_sources: c.families })), reasons: ["authoritative sources of equal standing report different values for the same thing, and nothing explains the difference"] });
  const value = numeric ? weightedMedian(win.members.map((m) => ({ value: m.value, w: WEIGHT[m.source.level] }))) : win.center;
  const minAgree = opts.minAgree || 2, official = win.bestLevel === 1;
  let status = win.families >= minAgree ? STATUS.VERIFIED : official && win.members.length >= 1 ? STATUS.VERIFIED : STATUS.PARTIALLY_VERIFIED;
  if (win.families >= minAgree) reasons.push(win.families + " independent sources agree" + (official ? ", including an official source" : ""));
  else if (official) reasons.push("a single official source of record answered (" + win.members[0].source.name + ")");
  else reasons.push("only one credible source answered, and nothing independent confirms it");
  if (dissent.length) { reasons.push(dissent.length + " source(s) reported a different value but have lower authority and were overruled: " + dissent.map((d) => d.source.name + " " + d.value).join("; ")); for (const d of dissent) excluded.push({ fact_id: d.fact_id, source: d.source.id, reason: "disagrees with " + (win.families) + " better-placed source(s)" }); status = win.families >= minAgree || official ? status : STATUS.PARTIALLY_VERIFIED; }
  const freshest = Math.max(...win.members.map((m) => m.source_updated_at || m.published_at || m.retrieved_at));
  return out(status, { value, unit: win.members[0].unit, supporters, agreeing_sources: win.members.map((m) => m.source.id), independent_sources: win.families, best_level: win.bestLevel, as_of: freshest, basis: wantBasis, dissent: dissent.map((d) => ({ fact_id: d.fact_id, source: d.source.id, value: d.value })) });
}

// confidence and the plain statement are derived here, from the verdict, never written by a model
function finish(v, all) {
  const conf = { VERIFIED: 0.9, PARTIALLY_VERIFIED: 0.55 }[v.status] || 0;
  v.confidence = conf ? Math.min(0.99, conf + Math.min(0.08, ((v.independent_sources || 1) - 1) * 0.04)) : 0;
  v.answerable = ANSWERABLE.has(v.status);
  v.freshness = v.as_of ? { as_of: v.as_of, age_ms: Math.max(0, v.checked_at - v.as_of) } : null;
  v.statement = statementFor(v);
  v.evidence = all.map((p) => ({ fact_id: p.fact_id, source: p.source.id, name: p.source.name, level: p.source.level, value: p.value, unit: p.unit, retrieved_at: p.retrieved_at, source_updated_at: p.source_updated_at, freshness: p.freshness.state, role: (v.supporters || []).includes(p.fact_id) ? "supports" : (v.excluded || []).some((e) => e.fact_id === p.fact_id) ? "excluded" : "considered" }));
  return v;
}
const ago = (ms) => ms == null ? "" : ms < 90 * S ? Math.round(ms / S) + " seconds" : ms < 90 * M ? Math.round(ms / M) + " minutes" : ms < 48 * H ? Math.round(ms / H) + " hours" : Math.round(ms / D) + " days";
const fmt = (n) => typeof n === "number" ? Number(n.toPrecision(7)).toString() : String(n);
export function statementFor(v) {
  const what = [v.attribute, v.entity].filter(Boolean).join(" of ") || "that";
  switch (v.status) {
    case "VERIFIED": return "Verified: " + what + " is " + fmt(v.value) + (v.unit ? " " + v.unit : "") + " (" + v.reasons[0] + "; data from " + ago(v.freshness && v.freshness.age_ms) + " ago)." + (v.dissent && v.dissent.length ? " Note: a lower-authority source reported " + v.dissent.map((d) => fmt(d.value)).join(" and ") + "." : "");
    case "PARTIALLY_VERIFIED": return "Partially verified: " + what + " is " + fmt(v.value) + (v.unit ? " " + v.unit : "") + ", but " + v.reasons[0] + ". Treat it as provisional.";
    case "CONFLICTING": return "The available authoritative sources currently disagree about " + what + " (" + (v.candidates || []).map((c) => fmt(c.value) + " from " + c.sources.join(", ")).join(" versus ") + "). I cannot verify a single value, so I will not state one.";
    case "STALE": return "The only information I found about " + what + " is out of date" + (v.last_known ? " (" + fmt(v.last_known.value) + " as of " + new Date(v.last_known.as_of).toISOString().slice(0, 16).replace("T", " ") + " UTC)" : "") + ". I will not present it as current.";
    case "UNAVAILABLE": return "No source answered for " + what + " just now, so I have nothing to state. Please try again shortly.";
    case "UNVERIFIED": return "I could only find unverified claims about " + what + ", and I will not present them as fact." + (v.reasons && v.reasons[0] ? " " + v.reasons[0] + "." : "");
    default: return "I don't have enough verified information to answer that reliably.";
  }
}

// The language model may phrase an answer but may not overrule the verdict. This checks a drafted answer against it: a number the verdict
// does not support (or a value that was withheld) is a violation, and the safe statement replaces the draft.
export function guardAnswer(draft, verdict, tol = { rel: 0.005 }) {
  const nums = (String(draft || "").replace(/(\d),(?=\d{3})/g, "$1").match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => isFinite(n));
  if (!verdict.answerable) {
    const leaked = [...(verdict.candidates || []).map((c) => c.value), verdict.last_known && verdict.last_known.value].filter((x) => typeof x === "number").some((c) => nums.some((n) => close(n, c, tol)));
    return { ok: !leaked, text: leaked ? verdict.statement : draft, reason: leaked ? "the draft states a value the verdict withheld (" + verdict.status + ")" : "" };
  }
  if (typeof verdict.value === "number" && nums.length && !nums.some((n) => close(n, verdict.value, tol) || (verdict.dissent || []).some((d) => close(n, d.value, tol)))) return { ok: false, text: verdict.statement, reason: "the draft's numbers do not match the verified value" };
  return { ok: true, text: draft, reason: "" };
}

// ── 7. the evidence graph ────────────────────────────────────────────────────────────────────────────────────────────
export function evidenceGraph(claim, verdict) {
  return { claim, evidence: verdict.evidence, verification: { status: verdict.status, answerable: verdict.answerable, confidence: verdict.confidence, reasons: verdict.reasons, excluded: verdict.excluded, dissent: verdict.dissent || [] }, answer: { statement: verdict.statement, value: verdict.answerable ? verdict.value : null, unit: verdict.unit || null, as_of: verdict.as_of || null }, checked_at: verdict.checked_at };
}

// ── 8. entities: the same thing by different names, resolved — or reported as ambiguous, never guessed ─────────────────
const norm = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const AIRPORTS = [
  ["JFK", "KJFK", "John F. Kennedy International Airport", ["new york jfk", "kennedy airport", "jfk airport", "idlewild"], "New York"], ["LGA", "KLGA", "LaGuardia Airport", ["laguardia", "la guardia airport"], "New York"], ["EWR", "KEWR", "Newark Liberty International Airport", ["newark airport", "newark"], "New York"],
  ["LHR", "EGLL", "London Heathrow Airport", ["heathrow", "london heathrow"], "London"], ["LGW", "EGKK", "London Gatwick Airport", ["gatwick"], "London"], ["STN", "EGSS", "London Stansted Airport", ["stansted"], "London"],
  ["ACC", "DGAA", "Kotoka International Airport", ["accra airport", "accra kotoka", "kotoka"], "Accra"], ["LOS", "DNMM", "Murtala Muhammed International Airport", ["lagos airport", "lagos murtala muhammed"], "Lagos"], ["NBO", "HKJK", "Jomo Kenyatta International Airport", ["nairobi airport", "jomo kenyatta"], "Nairobi"],
  ["JNB", "FAOR", "O. R. Tambo International Airport", ["johannesburg airport", "or tambo", "oliver tambo"], "Johannesburg"], ["CPT", "FACT", "Cape Town International Airport", ["cape town airport"], "Cape Town"], ["ADD", "HAAB", "Addis Ababa Bole International Airport", ["addis ababa airport", "bole airport"], "Addis Ababa"],
  ["CDG", "LFPG", "Paris Charles de Gaulle Airport", ["charles de gaulle", "paris cdg", "roissy"], "Paris"], ["ORY", "LFPO", "Paris Orly Airport", ["orly"], "Paris"], ["AMS", "EHAM", "Amsterdam Airport Schiphol", ["schiphol", "amsterdam airport"], "Amsterdam"],
  ["FRA", "EDDF", "Frankfurt Airport", ["frankfurt am main airport", "frankfurt airport"], "Frankfurt"], ["IST", "LTFM", "Istanbul Airport", ["istanbul new airport"], "Istanbul"], ["DXB", "OMDB", "Dubai International Airport", ["dubai airport"], "Dubai"],
  ["BUD", "LHBP", "Budapest Ferenc Liszt International Airport", ["budapest airport", "ferihegy"], "Budapest"], ["ATL", "KATL", "Hartsfield-Jackson Atlanta International Airport", ["atlanta airport", "hartsfield jackson"], "Atlanta"], ["LAX", "KLAX", "Los Angeles International Airport", ["los angeles airport"], "Los Angeles"],
  ["ORD", "KORD", "Chicago O'Hare International Airport", ["ohare", "o hare", "chicago ohare"], "Chicago"], ["SIN", "WSSS", "Singapore Changi Airport", ["changi"], "Singapore"], ["HND", "RJTT", "Tokyo Haneda Airport", ["haneda"], "Tokyo"], ["NRT", "RJAA", "Narita International Airport", ["narita"], "Tokyo"],
];
const ORG_SUFFIX = /\b(?:limited|ltd|plc|inc|incorporated|llc|corp|corporation|company|co|gh|group|holdings?)\b/g;
const ORGS = [["mtn-ghana", "MTN Ghana", ["mtn ghana", "mtn gh", "scancom", "scancom plc", "areeba"]], ["telecel-ghana", "Telecel Ghana", ["telecel ghana", "telecel", "vodafone ghana", "vodafone gh"]], ["gcb-bank", "GCB Bank", ["gcb", "gcb bank", "ghana commercial bank"]], ["bank-of-ghana", "Bank of Ghana", ["bank of ghana", "bog", "central bank of ghana"]], ["ecg", "Electricity Company of Ghana", ["ecg", "electricity company of ghana"]]];
// kind: "airport" | "organization" | "currency". Returns { status: resolved | ambiguous | unknown, id, canonical, alternatives }.
export function resolveEntity(kind, text) {
  const t = norm(text); if (!t) return { status: "unknown", kind, input: text, alternatives: [] };
  if (kind === "airport") {
    const hit = (a) => [a[0], a[1], a[2], ...a[3]].map(norm).some((n) => n === t);
    const exact = AIRPORTS.filter(hit);
    if (exact.length === 1) return { status: "resolved", kind, id: exact[0][0], icao: exact[0][1], canonical: exact[0][2], city: exact[0][4], confidence: 1, alternatives: [] };
    const city = AIRPORTS.filter((a) => norm(a[4]) === t);
    if (city.length > 1) return { status: "ambiguous", kind, input: text, reason: "more than one airport serves " + city[0][4] + ": say which one", alternatives: city.map((a) => ({ id: a[0], canonical: a[2] })) };
    if (city.length === 1) return { status: "resolved", kind, id: city[0][0], icao: city[0][1], canonical: city[0][2], city: city[0][4], confidence: 0.9, alternatives: [] };
    return { status: "unknown", kind, input: text, alternatives: [] };
  }
  if (kind === "organization") {
    const core = t.replace(ORG_SUFFIX, " ").replace(/\s+/g, " ").trim();
    const hits = ORGS.filter((o) => [o[1], ...o[2]].map(norm).some((n) => n === t || n.replace(ORG_SUFFIX, " ").replace(/\s+/g, " ").trim() === core));
    if (hits.length === 1) return { status: "resolved", kind, id: hits[0][0], canonical: hits[0][1], confidence: 1, alternatives: [] };
    if (hits.length > 1) return { status: "ambiguous", kind, input: text, alternatives: hits.map((o) => ({ id: o[0], canonical: o[1] })) };
    return { status: "unknown", kind, input: text, key: core, alternatives: [] };
  }
  return { status: "unknown", kind, input: text, alternatives: [] };
}

// ── 9. entity + attribute + value + TIME: current is not historical ──────────────────────────────────────────────────
// records: [{ entity, attribute, value, valid_from, valid_to (null = still true), as_of, source }]. when: null/undefined = now.
export function factAt(records, { entity, attribute, when = null, now = Date.now(), maxAgeMs = 30 * D } = {}) {
  const mine = (records || []).filter((r) => r.entity === entity && r.attribute === attribute);
  const temporal = when == null ? "current" : "historical", at = when == null ? now : when;
  if (!mine.length) return { status: STATUS.UNKNOWN, temporal, reason: "no record of " + attribute + " for " + entity };
  const covering = mine.filter((r) => (r.valid_from == null || r.valid_from <= at) && (r.valid_to == null || r.valid_to > at));
  if (!covering.length) return { status: STATUS.UNKNOWN, temporal, reason: "no record covers " + new Date(at).toISOString().slice(0, 10), known_periods: mine.map((r) => ({ from: r.valid_from, to: r.valid_to })) };
  const values = [...new Set(covering.map((r) => JSON.stringify(r.value)))];
  if (values.length > 1) return { status: STATUS.CONFLICTING, temporal, candidates: covering.map((r) => ({ value: r.value, source: r.source, as_of: r.as_of })), reason: "records for the same period disagree" };
  const r = covering.sort((a, b) => (b.as_of || 0) - (a.as_of || 0))[0];
  if (temporal === "current" && (r.as_of == null || now - r.as_of > maxAgeMs)) return { status: STATUS.STALE, temporal, value: null, last_known: { value: r.value, as_of: r.as_of }, reason: "the record is too old to count as current" };
  return { status: STATUS.VERIFIED, temporal, value: r.value, as_of: r.as_of, valid_from: r.valid_from, valid_to: r.valid_to, source: r.source };
}

// ── 10. what Noria says about itself ─────────────────────────────────────────────────────────────────────────────────
// Live-data domains and whether a real source is connected. state "none" means: no source is connected YET. That is an engineering gap (a provider
// or integration to build), never a statement that Noria cannot do this kind of work: the target is real, and until it is built Noria says plainly that
// it cannot verify that question YET and will not answer it from memory or guess.
export const DOMAINS = [
  ["Exchange rates", "fx", "connected", "3 independent feeds (an ECB reference, two aggregators); daily reference rates, not trading prices"],
  ["Cryptocurrency prices", "crypto", "connected", "4 exchanges and an aggregator compared live"],
  ["Weather", "weather", "connected", "an official national meteorological service and a weather model compared"],
  ["Date, time and arithmetic", "time", "connected", "computed exactly, not looked up"],
  ["News and current events", "news", "partial", "published news feeds and Wikipedia; the open-web provider is out of allowance, so coverage is degraded"],
  ["Office holders and current facts", "general", "partial", "checked against dated evidence; answers 'couldn't confirm' when evidence is missing"],
  ["Flight status", "flight_status", "none", "infrastructure required: an aviation data provider and a flights adapter through the reality layer are not built yet"],
  ["Traffic", "traffic", "none", "infrastructure required: a routing/traffic provider and adapter are not built yet"],
  ["Stock and market prices", "stock_price", "none", "infrastructure required: a market-data provider (delayed quotes are often free; real-time is licensed) and adapter are not built yet"],
  ["Medical guidance (dosage, treatment, drug interactions)", "medical_guidance", "none", "infrastructure required: an authoritative medical source and adapter; the source lock is ready, and until then dosage or treatment advice is never given from memory"],
  ["Visa, immigration and appointment systems", "appointment_availability", "none", "infrastructure required: official per-country sources and adapters; the source lock is ready"],
  ["Law and regulation", "government_announcement", "none", "infrastructure required: official legislation and court sources; the source lock is ready"],
  ["Company registrations", "company_registration", "none", "infrastructure required: a business-registry provider and adapter are not built yet"],
].map(([name, domain, state, note]) => ({ name, domain, state, note, label: state === "connected" ? "Target · connected" : state === "partial" ? "Target · partly connected (degraded)" : "Target · infrastructure required · not yet implemented", freshness: (FRESHNESS[domain] || FRESHNESS.general).label }));
export function describeReality() {
  return { authority: AUTHORITY, statuses: Object.keys(STATUS), sources: Object.entries(SOURCES).map(([id, s]) => ({ id, ...s })), freshness: Object.fromEntries(Object.entries(FRESHNESS).map(([k, v]) => [k, v.label])), locks: Object.fromEntries(Object.entries(LOCKS).map(([k, v]) => [k, { max_level: v.maxLevel, why: v.why }])), domains: DOMAINS,
    principles: ["Noria answers only when an answer is justified; it never turns UNKNOWN into a confident answer.", "A value is stated only with its sources, authority and time.", "Conflicts are reported, not silently resolved.", "Knowledge (stable), live data and the person's private data are never mixed in one verification."] };
}
