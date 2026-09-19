// Cloudflare Pages (Advanced Mode) — Noria's front door AND her brain, served
// entirely from Cloudflare's edge. The workspace UI is static assets (instant,
// global, never suspends). Live web search runs here. And /brain/* now calls a
// free multi-model LLM chain DIRECTLY (Groq primary, Gemini fallback) — so Noria
// answers on her own, with no dependency on any Render/Fly service or database.
//
// Keys come from environment variables (Pages project secrets), never hardcoded:
//   GROQ_API_KEY   (required)  — https://console.groq.com
//   GEMINI_API_KEY (optional)  — https://aistudio.google.com/apikey  (AIza… key)
//   TAVILY_KEY     (optional)  — full open-web search, FREE 1k/mo, no card (tavily.com)
//   BRAVE_KEY      (optional)  — general web search, free 2k/mo (needs a card)
// Even with NO search key at all, live grounding works for free via Wikipedia
// (knowledge/history) + Google News RSS (up-to-the-minute current events).
// Model IDs are env-overridable (GROQ_MODEL, GROQ_FALLBACK_MODEL, GEMINI_MODEL).

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const JSON_H = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" };
const SSE_H = { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "access-control-allow-origin": "*" };
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// ── Web search ─────────────────────────────────────────────────────────────────
function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(+n); } catch (_) { return ""; } })
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}
function decodeDDG(u) {
  try {
    if (u.includes("uddg=")) {
      const uddg = new URL(u.startsWith("//") ? "https:" + u : u).searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
  } catch (_) {}
  return u.startsWith("//") ? "https:" + u : u;
}
async function ddgHtml(q) {
  const results = [];
  try {
    const r = await fetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q), { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } });
    const html = await r.text();
    const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 6) {
      const url = decodeDDG(m[1]), title = stripTags(m[2]), snippet = stripTags(m[3]);
      if (title && snippet) results.push({ url, title, snippet });
    }
  } catch (_) {}
  return results;
}
async function braveSearch(q, key) {
  try {
    const r = await fetch("https://api.search.brave.com/res/v1/web/search?count=6&q=" + encodeURIComponent(q), {
      headers: { "Accept": "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": key },
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (((j.web && j.web.results) || []).slice(0, 6))
      .map((x) => ({ title: (x.title || "").trim(), snippet: stripTags(x.description || "").slice(0, 220), url: x.url || "" }))
      .filter((x) => x.title && x.url);
  } catch (_) { return []; }
}
async function ddgInstant(q) {
  const results = [];
  try {
    const r = await fetch("https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=" + encodeURIComponent(q), { headers: { "User-Agent": UA } });
    const j = await r.json();
    if (j.AbstractText) results.push({ title: j.Heading || q, snippet: j.AbstractText, url: j.AbstractURL || "" });
    (j.RelatedTopics || []).forEach((t) => { if (t.Text && results.length < 6) results.push({ title: (t.Text || "").split(" - ")[0].slice(0, 90), snippet: t.Text, url: t.FirstURL || "" }); });
  } catch (_) {}
  return results;
}
// Wikipedia — free, no key, and (unlike DDG's HTML endpoint) NOT blocked from
// Cloudflare IPs. Covers the breadth of human knowledge and is updated within
// minutes for major current events, so it grounds the vast majority of factual,
// historical, biographical and "what happened" queries at $0.
// Wikipedia's search ranks keyword/entity queries far better than verbose
// natural-language questions ("Who won the 2026 FIFA World Cup?" surfaces the
// Group-A page; "2026 FIFA World Cup" surfaces the main article). Strip the
// question stem so grounding hits the authoritative article.
function toSearchQuery(q) {
  let s = String(q || "").trim().replace(/[?!.]+/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^(who|what|whats|when|where|why|how|which|whose|is|are|was|were|did|does|do|can|could|would|will|should|tell me|give me|show me|find|search for|look up|please)\b[\s,:-]*/i, "");
  s = s.replace(/^(won|win|is|are|was|were|the|a|an|about|for|by|of|in)\b\s+/i, "");
  s = s.trim();
  return s.length >= 2 ? s : String(q || "").trim();
}
async function wikiFetchHits(query) {
  const s = await fetch(
    "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=" +
      encodeURIComponent(query) + "&origin=*",
    { headers: { "User-Agent": UA, "Api-User-Agent": "NoriaBody/1.0 (grounding)" } }
  );
  if (!s.ok) return [];
  const sj = await s.json();
  return ((sj.query && sj.query.search) || []).slice(0, 3);
}
async function wikiSearch(q) {
  try {
    const cleaned = toSearchQuery(q);
    let hits = await wikiFetchHits(cleaned);
    // Fall back to the raw phrasing only if the keyword form found nothing.
    if (!hits.length && cleaned !== q) hits = await wikiFetchHits(q);
    if (!hits.length) return [];
    const summaries = await Promise.all(hits.map(async (h) => {
      const title = h.title;
      const slug = encodeURIComponent(title.replace(/ /g, "_"));
      try {
        const r = await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + slug, {
          headers: { "User-Agent": UA, "Api-User-Agent": "NoriaBody/1.0 (grounding)" },
        });
        if (!r.ok) return null;
        const j = await r.json();
        const snip = (j.extract || stripTags(h.snippet || "")).slice(0, 320);
        if (!snip) return null;
        return {
          title,
          snippet: snip,
          url: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) ||
            ("https://en.wikipedia.org/wiki/" + slug),
        };
      } catch (_) { return null; }
    }));
    return summaries.filter(Boolean);
  } catch (_) { return []; }
}
// Google News RSS — FREE, no key, no card, and works from Cloudflare (DDG does
// not). Returns real, dated headlines from major outlets — the live "pulse of
// the world" that Wikipedia alone can't give. This is what makes Noria current.
// Direct news-org RSS feeds. Unlike Google News/DDG (which 503 from Cloudflare's
// IPs), these serve clean feeds with real snippets straight to the Worker. BBC +
// NPR cover world / tech / business — the live pulse Wikipedia can't give.
const NEWS_FEEDS = [
  "http://feeds.bbci.co.uk/news/rss.xml",
  "http://feeds.bbci.co.uk/news/world/rss.xml",
  "http://feeds.bbci.co.uk/news/technology/rss.xml",
  "http://feeds.bbci.co.uk/news/business/rss.xml",
  "https://feeds.npr.org/1001/rss.xml",
];
function cdata(s) { return String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"); }
function parseFeed(xml) {
  const out = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const title = stripTags(cdata(((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "")));
    const link = stripTags(cdata(((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "")));
    const desc = stripTags(cdata(((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "")));
    const pub = (((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "").trim());
    if (title) out.push({ title, snippet: desc, url: link, pub, ts: Date.parse(pub) || 0 });
  }
  return out;
}
async function fetchFeed(u) {
  try { const r = await fetch(u, { headers: { "User-Agent": UA } }); if (!r.ok) return []; return parseFeed(await r.text()); }
  catch (_) { return []; }
}
// Is this a general "what's the news" ask (no specific topic to search on)?
function isGeneralNews(q) {
  const s = String(q || "");
  return /\b(top|latest|current|today'?s?|breaking)?\s*(news|headlines?)\b/i.test(s) &&
    !/\b(about|on|regarding|of the|for)\b/i.test(s) && s.split(/\s+/).length <= 8;
}
async function newsSearch(q) {
  const lists = await Promise.all(NEWS_FEEDS.map(fetchFeed));
  let items = [].concat.apply([], lists);
  if (!items.length) return [];
  const seen = new Set();
  items = items.filter((x) => { const k = x.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const fmt = (x) => ({ title: x.title, snippet: (x.snippet || "").slice(0, 240) + (x.pub ? " (" + x.pub.slice(0, 16) + ")" : ""), url: x.url, date: x.pub || "" });
  if (isGeneralNews(q)) {
    items.sort((a, b) => b.ts - a.ts);
    return items.slice(0, 6).map(fmt);
  }
  // Topical: score items by keyword overlap with the query.
  const toks = toSearchQuery(q).toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!toks.length) { items.sort((a, b) => b.ts - a.ts); return items.slice(0, 4).map(fmt); }
  const scored = items.map((x) => {
    const hay = (x.title + " " + x.snippet).toLowerCase();
    let s = 0; for (const t of toks) if (hay.includes(t)) s++;
    return { x, s };
  }).filter((o) => o.s > 0).sort((a, b) => (b.s - a.s) || (b.x.ts - a.x.ts));
  return scored.slice(0, 5).map((o) => fmt(o.x));
}
// Tavily — a free, no-credit-card general web-search API built for grounding AI
// (1,000 searches/month on the free plan, email signup only, https://tavily.com).
// Optional: set TAVILY_KEY to give Noria full open-web results, ChatGPT-style.
// Returns an array of results on success (possibly empty), or null if THIS key
// failed (rate-limit/invalid/network) — so the caller can advance to the next
// key on a failure but stop cleanly on a genuine no-results.
// Code-level recency sort: parse each result's timestamp and put the NEWEST first,
// BEFORE it reaches the model — so on "latest/current" queries the freshest source
// leads the injected context (stronger than a prompt instruction alone). Undated
// items keep their original relative order, after the dated ones.
function recencySort(results) {
  return results
    .map((r, i) => ({ r, i, t: Date.parse(r.date || r.pub || "") || 0 }))
    .sort((a, b) => (b.t - a.t) || (a.i - b.i))
    .map((o) => o.r);
}
async function tavilySearch(q, key) {
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query: q, max_results: 6, search_depth: "basic", include_answer: true }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const rows = (j.results || []).slice(0, 6).map((x) => ({
      title: (x.title || "").trim(), snippet: stripTags(x.content || "").slice(0, 300), url: x.url || "",
      date: x.published_date || "", // Tavily returns this for news-type results
    })).filter((x) => x.title && x.url);
    const sorted = recencySort(rows); // newest-dated source first
    if (j.answer) sorted.unshift({ title: "Summary", snippet: stripTags(j.answer).slice(0, 320), url: "", date: "" });
    return sorted;
  } catch (_) { return null; }
}
async function webSearch(q, env) {
  // Priority 1 — a keyed general-web provider, if the owner supplied one
  // (Tavily is free/no-card; Brave is free-with-card). Best full-web coverage.
  // Multiple Tavily keys rotate round-robin (3 keys = 3× the free monthly quota);
  // a rate-limited/invalid key falls through to the next automatically.
  const tks = rotate(parseKeys(env, "TAVILY_KEYS", "TAVILY_KEY"));
  for (const k of tks) {
    const t = await tavilySearch(q, k);
    if (t === null) continue;      // this key failed → try the next key
    if (t.length) return t;         // got open-web results
    break;                          // key worked but no hits → use the free fallback
  }
  if (env && env.BRAVE_KEY) { const b = await braveSearch(q, env.BRAVE_KEY); if (b.length) return b; }
  // Priority 2 — the free, keyless, CF-working pair: Wikipedia (knowledge/history)
  // + Google News (live current events). Merge them, leading with whichever the
  // query favours, so Noria answers with both depth AND up-to-the-minute facts.
  const [w, n] = await Promise.all([wikiSearch(q), newsSearch(q)]);
  const newsy = /\b(latest|current|today|tonight|now|recent|breaking|news|update|price|stock|score|result|this (week|month|year)|as of|202\d|203\d)\b/i.test(String(q || ""));
  // On time-sensitive queries, sort the merged pool newest-first (news carries dates,
  // Wikipedia doesn't → fresh news leads, knowledge follows). Otherwise keep the
  // knowledge-first order for stable factual/historical answers.
  const merged = (newsy ? recencySort(n.concat(w)) : w.concat(n)).filter((x) => x && x.title);
  if (merged.length) return merged.slice(0, 6);
  // Priority 3 — last-resort fallbacks (usually blocked/narrow from CF).
  const r = await ddgHtml(q); if (r.length) return r;
  return await ddgInstant(q);
}
// Build a compact, dated grounding block to inject into the reasoning prompt.
function groundingBlock(results) {
  if (!results || !results.length) return "";
  const today = new Date().toISOString().slice(0, 10);
  const lines = results.slice(0, 7).map((r, i) =>
    `[${i + 1}] ${r.title}${r.snippet ? " — " + r.snippet : ""}${r.url ? " (" + r.url + ")" : ""}`
  ).join("\n");
  return "\n\nLIVE WEB CONTEXT — retrieved " + today + " (this is TODAY'S date). " +
    "Treat these results as current, authoritative fact and prefer them over your training " +
    "when they disagree. Anything described in the past tense here HAS ALREADY HAPPENED as of " +
    "today — never say an event 'has not happened yet' or 'is not yet determined' if the " +
    "results state its outcome. CRITICAL: when the question asks for the latest / current / " +
    "most recent / newest state of something, base your answer on the MOST RECENTLY DATED item " +
    "in these results and state that date — never present an older dated item as the current " +
    "situation when a newer one is present. If the results conflict, the newest date wins. " +
    "You must synthesize your answer STRICTLY from these facts: if they are thin, conflicting, " +
    "or do not contain the exact answer, say plainly 'I'm not certain based on current live " +
    "data' rather than extrapolating or inventing anything. CRITICAL anti-fabrication rule: if " +
    "the specific person, place, organisation or event the user names does NOT actually appear " +
    "in these results, do NOT describe it as real or invent details about it — say you couldn't " +
    "find current information about it. Your own memory is out of date (it stops before today): for " +
    "anything that changes over time — who holds an office or title, prices, scores, laws, records, " +
    "ages — rely ONLY on these results, and if they do not state it, say you couldn't verify it. " +
    "Answer directly from these results, and never mention " +
    "this block, the search, or that you looked anything up:\n" + lines;
}
// Used when a question needs live facts but the web search came back empty. Without this she would
// answer from stale memory (e.g. name a former office-holder as the current one) with full confidence.
function noLiveBlock() {
  const now = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return "\n\nLIVE DATA UNAVAILABLE — today is " + now + ". Live search returned nothing for this question. " +
    "Your own memory is out of date (it stops before today). For anything that changes over time — who " +
    "currently holds an office or title, prices, scores, news, weather — do NOT answer from memory: say " +
    "plainly that you couldn't verify current information right now, and offer what you reliably know " +
    "as background, clearly marked as possibly out of date. Never mention this note.";
}
// A long or multi-part question makes a poor web-search phrase (the results drift off-topic). Turn it
// into at most two short, focused search queries with a fast model; short questions are used as-is.
// Any failure falls back to the original question, so this can only ever help.
async function planSearchQueries(q, env) {
  const s = String(q || "").trim();
  if (s.split(/\s+/).length <= 10 && (s.match(/\?/g) || []).length <= 1) return [s];
  for (const key of rotate(groqKeys(env))) {
    try {
      const t = await openaiCompatible("https://api.groq.com/openai/v1/chat/completions", key, [env.GROQ_FAST_MODEL || "openai/gpt-oss-20b"], [
        { role: "system", content: "Turn the user's question into at most 2 short, focused web-search queries that together find the facts needed (for example one for who currently holds an office, one for the recent news about it). Output ONLY a JSON array of strings, nothing else." },
        { role: "user", content: s.slice(0, 500) },
      ], { maxTokens: 800, temperature: 0 });
      const m = String(t || "").match(/\[[\s\S]*\]/);
      const arr = m ? JSON.parse(m[0]) : [];
      const qs = arr.filter((x) => typeof x === "string" && x.trim()).slice(0, 2).map((x) => x.trim().slice(0, 200));
      if (qs.length) return qs;
    } catch (_) { /* try the next key, then fall back to the question itself */ }
  }
  return [s];
}
// Heuristic: does this query need up-to-the-minute or verifiable external facts?
function serverNeedsWeb(q) {
  const s = String(q || "");
  if (/\b(current|latest|today|tonight|now|this (week|month|year)|recent|breaking|news|update|price|stock|score|weather|as of|right now|202[4-9]|203\d)\b/i.test(s)) return true;
  if (/\b(who is|who won|what happened|when (is|was|did)|how much (is|does)|release date|schedule|standings|results)\b/i.test(s)) return true;
  return false;
}

// ── Noria's brain: free multi-model LLM (Groq primary → Gemini fallback) ─────────
function buildMessages(body) {
  const messages = [];
  if (body.system) messages.push({ role: "system", content: String(body.system) });
  const history = Array.isArray(body.history) ? body.history : [];
  for (const h of history) if (h && h.content) messages.push({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.content) });
  if (body.query) messages.push({ role: "user", content: String(body.query) });
  return messages;
}
// Router-level grounding: when a query needs live facts, fetch the web and fold
// the results into the system message so every provider in the fallback chain
// reasons over the same fresh context. `ground` in the request body forces it on
// (true) or off (false, e.g. a client that already grounded itself); otherwise
// the router decides with serverNeedsWeb().
async function groundMessages(messages, body, env) {
  const q = String(body.query || "");
  const want = body.ground === true || (body.ground !== false && serverNeedsWeb(q));
  if (!want || !q) return { messages, grounded: false };
  const queries = await planSearchQueries(q, env).catch(() => [q]);
  const lists = await Promise.all(queries.map((x) => webSearch(x, env).catch(() => [])));
  const seen = new Set(), results = [];
  for (const list of lists) for (const r of list || []) { const k = r && (r.url || r.title); if (k && !seen.has(k)) { seen.add(k); results.push(r); } }
  const block = groundingBlock(results.slice(0, 7)) || noLiveBlock();
  const out = messages.slice();
  const sysIdx = out.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) out[sysIdx] = { role: "system", content: out[sysIdx].content + block };
  else out.unshift({ role: "system", content: block.trim() });
  return { messages: out, grounded: true };
}
// KEY ROTATION + PROVIDER FALLBACK — so free quota effectively never hits zero.
// Add capacity at $0 by supplying comma-separated keys and/or more providers:
//   GROQ_API_KEYS = k1,k2,k3    GEMINI_API_KEYS = g1,g2    OPENROUTER_API_KEYS = o1,o2
// Keys are tried round-robin; on a rate-limit/quota/model error, the next key —
// then the next provider — is used automatically.
function parseKeys(env, ...names) {
  const keys = [];
  for (const n of names) { const v = env[n]; if (v) for (const k of String(v).split(",").map((s) => s.trim()).filter(Boolean)) if (!keys.includes(k)) keys.push(k); }
  return keys;
}
let _rot = 0;
function rotate(arr) { if (arr.length <= 1) return arr.slice(); const s = _rot++ % arr.length; return arr.slice(s).concat(arr.slice(0, s)); }
const groqKeys = (env) => parseKeys(env, "GROQ_API_KEYS", "GROQ_API_KEY");
const geminiKeys = (env) => parseKeys(env, "GEMINI_API_KEYS", "GEMINI_API_KEY"); // accepts AIza… and newer AQ.… key formats
const openrouterKeys = (env) => parseKeys(env, "OPENROUTER_API_KEYS", "OPENROUTER_API_KEY");
const brainConfigured = (env) => groqKeys(env).length || geminiKeys(env).length || openrouterKeys(env).length;

// Shared OpenAI-compatible completion (Groq + OpenRouter). gpt-oss models spend
// tokens on internal reasoning, so the budget is generous; answer is in content.
async function openaiCompatible(url, key, models, messages, opts, extraHeaders) {
  let lastErr = "";
  for (const model of models) {
    const r = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", Authorization: "Bearer " + key }, extraHeaders || {}),
      body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 8000, temperature: opts.temperature ?? 0.4, stream: false }),
    });
    if (r.ok) {
      const d = await r.json();
      const text = ((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "").trim();
      if (text) return text;
      lastErr = model + ": empty"; continue;
    }
    lastErr = model + " " + r.status + ": " + (await r.text()).slice(0, 160);
    if (r.status === 429 || r.status === 404 || /model|not found|decommission|unavailable/i.test(lastErr)) continue; // next model on this key
    throw new Error(lastErr); // other error → caller advances to next key/provider
  }
  throw new Error(lastErr || "no model");
}
async function geminiComplete(key, env, messages, opts) {
  const model = opts.geminiModel || env.GEMINI_MODEL || "gemini-2.5-flash";
  const system = (messages.find((m) => m.role === "system") || {}).content || "";
  const contents = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + key, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system_instruction: system ? { parts: [{ text: system }] } : undefined, contents, generationConfig: { maxOutputTokens: opts.maxTokens ?? 8000, temperature: opts.temperature ?? 0.4 } }),
  });
  if (!r.ok) throw new Error("gemini " + r.status + ": " + (await r.text()).slice(0, 160));
  const d = await r.json();
  return ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] && d.candidates[0].content.parts[0].text) || "").trim();
}
// Task-based routing: deep queries (analysis/coding/math/reasoning) go to the
// strongest models with a big budget; everyday chat goes to fast, low-latency models.
async function brainComplete(messages, env, opts = {}) {
  const attempts = [];
  const gm = opts.deep
    ? [env.GROQ_MODEL || "openai/gpt-oss-120b"]
    : [env.GROQ_FAST_MODEL || "openai/gpt-oss-20b", env.GROQ_MODEL || "openai/gpt-oss-120b"];
  // Note: Gemini Pro models are quota-gated on the free tier, so we use flash for
  // both modes (env-overridable). Deep-mode strength comes from Groq gpt-oss-120b + budget.
  const gemOpts = Object.assign({}, opts, { geminiModel: opts.deep ? (env.GEMINI_DEEP_MODEL || "gemini-2.5-flash") : (env.GEMINI_MODEL || "gemini-2.5-flash") });
  for (const key of rotate(groqKeys(env))) attempts.push({ name: "groq", fn: () => openaiCompatible("https://api.groq.com/openai/v1/chat/completions", key, gm, messages, opts) });
  for (const key of rotate(geminiKeys(env))) attempts.push({ name: "gemini", fn: () => geminiComplete(key, env, messages, gemOpts) });
  const om = [env.OPENROUTER_MODEL || "qwen/qwen3.8-27b:free", env.OPENROUTER_FALLBACK_MODEL || "z-ai/glm-5.2:free"];
  for (const key of rotate(openrouterKeys(env))) attempts.push({ name: "openrouter", fn: () => openaiCompatible("https://openrouter.ai/api/v1/chat/completions", key, om, messages, opts, { "HTTP-Referer": "https://noria.skyglobegroup.com", "X-Title": "Noria" }) });
  if (!attempts.length) throw new Error("no model key configured");
  const errs = [];
  for (const a of attempts) { try { const t = await a.fn(); if (t) return t; errs.push(a.name + ": empty"); } catch (e) { errs.push(a.name + ": " + e.message); } }
  throw new Error("Noria's brain is unavailable → " + errs.join(" | "));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type" } });
    }

    // ── Voice in: audio bytes → Whisper on Groq (free). Client falls back to the
    // Cloudflare Whisper worker, then to the browser recognizer, if this fails. ──
    if (path === "/stt" && request.method === "POST") {
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return new Response(JSON.stringify({ error: "no audio" }), { status: 400, headers: JSON_H });
      if (buf.byteLength > 4 * 1024 * 1024) return new Response(JSON.stringify({ error: "audio too large" }), { status: 413, headers: JSON_H });
      const ct = (request.headers.get("content-type") || "audio/webm").split(";")[0];
      const ext = /mp4|m4a|aac/.test(ct) ? "m4a" : /ogg/.test(ct) ? "ogg" : /wav/.test(ct) ? "wav" : /mpeg|mp3/.test(ct) ? "mp3" : "webm";
      let lastErr = "no groq key";
      for (const key of rotate(groqKeys(env))) {
        try {
          const fd = new FormData();
          fd.append("file", new Blob([buf], { type: ct }), "speech." + ext);
          fd.append("model", env.GROQ_STT_MODEL || "whisper-large-v3-turbo");
          fd.append("response_format", "json");
          fd.append("temperature", "0");
          const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + key }, body: fd });
          if (r.ok) { const d = await r.json(); return new Response(JSON.stringify({ text: String(d.text || "").trim() }), { headers: JSON_H }); }
          lastErr = "groq " + r.status;
        } catch (e) { lastErr = e.message; }
      }
      return new Response(JSON.stringify({ error: lastErr }), { status: 502, headers: JSON_H });
    }

    // ── Live web search ──
    if (path === "/search" && request.method === "GET") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return new Response(JSON.stringify({ error: "no query" }), { status: 400, headers: JSON_H });
      const results = await webSearch(q, env).catch(() => []);
      return new Response(JSON.stringify({ query: q, results }), { headers: JSON_H });
    }

    // ── Brain: non-streaming (the workspace's structured JSON path) ──
    if (path === "/brain/ask" && request.method === "POST") {
      let body; try { body = await request.json(); } catch (_) { body = {}; }
      let messages = buildMessages(body);
      if (!messages.length) return new Response(JSON.stringify({ error: "empty request" }), { status: 400, headers: JSON_H });
      const g = await groundMessages(messages, body, env);
      messages = g.messages;
      const q = String(body.query || "");
      const deep = /\b(analy[sz]e|analysis|calculat|comput|code|coding|program|debug|architect|design|solve|prove|deriv|optimi[sz]|algorithm|reason|strateg|framework|evaluat|equation|integral|theorem|compare|business plan|roadmap|proposal|cv|résumé|resume|cover letter|itinerary|report)\b/i.test(q) || q.length > 420;
      // Grounded (live-data) answers run cooler to curb fabrication; free chat stays warm.
      const temperature = g.grounded ? 0.2 : (typeof body.temperature === "number" ? body.temperature : 0.4);
      try {
        const text = await brainComplete(messages, env, { deep, maxTokens: deep ? 8000 : 2600, temperature });
        return new Response(JSON.stringify({ answer: text }), { headers: JSON_H });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: JSON_H });
      }
    }

    // ── Brain: streaming (SSE) — translate Groq deltas to the app's {token}/{done} ──
    if (path === "/brain/ask/stream" && request.method === "POST") {
      let body; try { body = await request.json(); } catch (_) { body = {}; }
      let messages = buildMessages(body);
      messages = await groundMessages(messages, body, env);
      const gkeys = rotate(groqKeys(env));
      if (!gkeys.length) return new Response(`data: ${JSON.stringify({ error: "no brain key" })}\n\n`, { status: 502, headers: SSE_H });
      // Rotate across Groq keys until one accepts the stream (skips a rate-limited key).
      let up = null, lastErr = "";
      for (const key of gkeys) {
        try {
          const r = await fetch(GROQ_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
            body: JSON.stringify({ model: env.GROQ_MODEL || "openai/gpt-oss-120b", messages, max_tokens: 8000, temperature: 0.4, stream: true }),
          });
          if (r.ok) { up = r; break; }
          lastErr = "groq " + r.status; try { await r.body.cancel(); } catch (_) {}
        } catch (e) { lastErr = e.message; }
      }
      if (!up) return new Response(`data: ${JSON.stringify({ error: "Cannot reach Noria's brain: " + lastErr })}\n\n`, { status: 502, headers: SSE_H });
      const stream = new ReadableStream({
        async start(controller) {
          const reader = up.body.getReader();
          const dec = new TextDecoder(); const enc = new TextEncoder();
          let buf = "";
          const send = (obj) => controller.enqueue(enc.encode("data: " + JSON.stringify(obj) + "\n\n"));
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let nl;
              while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (data === "[DONE]") { send({ done: true }); controller.close(); return; }
                try { const j = JSON.parse(data); const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content; if (delta) send({ token: delta }); } catch (_) {}
              }
            }
            send({ done: true }); controller.close();
          } catch (e) { send({ error: e.message }); controller.close(); }
        },
      });
      return new Response(stream, { headers: SSE_H });
    }

    // ── Feedback (no engine to record it now) — accept gracefully ──
    if (path === "/brain/feedback" && request.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_H });
    }
    // ── Health ── (reports how many keys per provider are configured)
    if (path === "/brain/health") {
      const g = groqKeys(env).length, gm = geminiKeys(env).length, o = openrouterKeys(env).length;
      const ok = g || gm || o;
      return new Response(JSON.stringify({ status: ok ? "ok" : "no-key", keys: { groq: g, gemini: gm, openrouter: o } }), { headers: JSON_H });
    }

    // ── Static assets, served by Cloudflare Pages ──
    // Front door = the workspace (served in place at "/", no redirect). Pages serves
    // workspace.html at the clean path "/workspace", so we fetch that for "/".
    const assetPath = path === "/" ? "/workspace" : path;
    const assetReq = assetPath === path ? request : new Request(new URL(assetPath + url.search, url.origin), request);
    let resp = await env.ASSETS.fetch(assetReq);
    const ct = resp.headers.get("content-type") || "";
    // Pinned third-party libraries (three.js 0.160.0) and the 3D face never change under the same URL,
    // so they are cached hard: the 3D page then loads from the visitor's own device after the first time.
    if (assetPath.startsWith("/vendor/") || assetPath === "/assets/facecap.glb") {
      resp = new Response(resp.body, resp);
      resp.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return resp;
    }
    const isCode = /text\/html|javascript|ecmascript|text\/css|application\/json|manifest/i.test(ct)
      || /\.(html|js|mjs|css|json|webmanifest)$/i.test(assetPath)
      || assetPath === "/workspace";
    if (isCode) {
      resp = new Response(resp.body, resp);
      resp.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
      resp.headers.delete("etag");
      resp.headers.delete("last-modified");
      resp.headers.delete("expires");
    }
    return resp;
  },
};
