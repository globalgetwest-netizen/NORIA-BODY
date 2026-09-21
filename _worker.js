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
  // Africa and the wider world (each feed has its own time limit; one that is down simply adds nothing)
  "https://feeds.bbci.co.uk/news/world/africa/rss.xml",
  "https://www.aljazeera.com/xml/rss/all.xml",
  "https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf",
  "https://www.myjoyonline.com/feed/",
  "https://www.graphic.com.gh/news/general-news.feed",
  "https://3news.com/feed/",
  "https://www.vanguardngr.com/feed/",
  "https://www.nation.africa/kenya/rss.xml",
  "https://www.standardmedia.co.ke/rss/headlines.php",
  "https://punchng.com/feed/",
  "https://www.premiumtimesng.com/feed",
];
function cdata(s) { return String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"); }
function parseFeed(xml) {
  const out = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const title = stripTags(cdata(((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "")));
    const link = stripTags(cdata(((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "")));
    const desc = stripTags(cdata(((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "")));
    const pub = (((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || b.match(/<dc:date>([\s\S]*?)<\/dc:date>/) || [])[1] || "").trim());
    if (title) out.push({ title, snippet: desc, url: link, pub, ts: Date.parse(pub) || 0 });
  }
  return out;
}
async function fetchFeed(u) {
  try { const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(4500) }); if (!r.ok) return []; return parseFeed(await r.text()); }
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
// RELEVANCE comes before recency. Ordering everything newest-first put unrelated fresh headlines above the page that actually
// answers the question. So each result is scored on how many of the question's distinctive words it contains (the names and
// subject words, not "who", "latest" or "price"); results that do not cover the subject are dropped; and only among the
// relevant ones does the newest come first. If nothing is relevant, nothing is returned, which is the honest result.
const RANK_GENERIC = new Set("price cost worth latest current currently news today tonight recent recently now right still this that week month year many much people live new about tell what who which where when does have has been the and for are was were with from into than then his her their they them will would could should can you your our not but all any one two more most some such only over very also just only who's whos won win wins winner winners champion champions get got give show find list name named called".split(" "));
const stem = (w) => w.replace(/(ies)$/, "y").replace(/(es|s)$/, "");
function distinctiveTerms(q) {
  const words = fold(toSearchQuery(q)).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !RANK_GENERIC.has(w));
  return [...new Set(words.map(stem))];
}
function rankRelevant(pool, q, fresh) {
  const terms = distinctiveTerms(q);
  if (!terms.length) return fresh ? recencySort(pool) : pool;
  const scored = pool.map((r, i) => {
    const hay = fold((r.title || "") + " " + (r.snippet || "") + " " + (r.url || ""));
    const hit = terms.filter((t) => hay.includes(t)).length;
    return { r, i, score: hit / terms.length, t: Date.parse(r.date || r.pub || "") || 0, web: r.src === "web" };
  });
  const need = terms.length <= 2 ? 1 : 0.6; // one or two subject words must all appear; longer questions need most of them
  let keep = scored.filter((x) => x.score >= need);
  if (!keep.length) keep = scored.filter((x) => x.web && x.score >= 0.34).slice(0, 3); // the open-web engine ranks by meaning; trust its best few
  const tier = (x) => (x.score >= 0.99 ? 2 : 1);
  keep.sort((a, b) => (tier(b) - tier(a)) || (fresh ? (b.t - a.t) : 0) || (a.i - b.i));
  return keep.map((x) => x.r);
}
async function webSearch(q, env, fresh) {
  // Every source runs at the same time and each has its own time limit, so one slow or failing source can never cost the
  // others: Tavily (open web, key rotation), Brave (if a key is set), Wikipedia (knowledge, updated within minutes for big
  // events) and live news feeds from Africa and the world. Results are merged, de-duplicated, and — for anything time-
  // sensitive — ordered newest first, so the freshest source leads. Tavily's own written "summary" is kept but placed last,
  // because it is a machine-made paraphrase, not a source.
  const isFresh = fresh !== undefined ? !!fresh : /\b(latest|current|currently|today|tonight|now|recent|breaking|news|update|price|stock|score|result|this (week|month|year)|as of|202\d|203\d)\b/i.test(String(q || ""));
  const tks = rotate(parseKeys(env, "TAVILY_KEYS", "TAVILY_KEY"));
  const tavilyP = withTimeout((async () => { for (const k of tks) { const t = await tavilySearch(q, k); if (t === null) continue; return t; } return []; })(), 7000, []);
  const braveP = env && env.BRAVE_KEY ? withTimeout(braveSearch(q, env.BRAVE_KEY), 6000, []) : Promise.resolve([]);
  const [tv, br, w, n] = await Promise.all([tavilyP, braveP, withTimeout(wikiSearch(q), 6000, []), withTimeout(newsSearch(q), 6000, [])]);
  const summary = (tv || []).filter((x) => x.title === "Summary").map((x) => Object.assign({}, x, { snippet: "(search-engine summary — check it against the sources above) " + x.snippet }));
  const tag = (list, src) => (list || []).map((x) => Object.assign({}, x, { src }));
  const rows = tag((tv || []).filter((x) => x.title !== "Summary"), "web");
  const seen = new Set(), pool = [];
  for (const x of [].concat(rows, tag(br, "web"), isFresh ? tag(n, "news").concat(tag(w, "wiki")) : tag(w, "wiki").concat(tag(n, "news")))) {
    const k = x && (x.url || x.title); if (!k || !x.title || seen.has(k)) continue; seen.add(k); pool.push(x);
  }
  const ordered = rankRelevant(pool, q, isFresh);
  const out = ordered.slice(0, 8).concat(summary);
  if (out.length) return out;
  const r = await withTimeout(ddgHtml(q), 5000, []); if (r.length) return r;
  return await withTimeout(ddgInstant(q), 5000, []);
}
// Build a compact, dated grounding block to inject into the reasoning prompt.
function groundingBlock(results) {
  if (!results || !results.length) return "";
  const today = new Date().toISOString().slice(0, 10);
  const stamp = (r) => { const t = Date.parse(r.date || r.pub || ""); return t ? " [dated " + new Date(t).toISOString().slice(0, 10) + "]" : ""; };
  const lines = results.slice(0, 9).map((r, i) =>
    `[${i + 1}] ${r.title}${stamp(r)}${r.snippet ? " — " + r.snippet : ""}${r.url ? " (" + r.url + ")" : ""}`
  ).join("\n");
  const dates = results.map((r) => Date.parse(r.date || r.pub || "")).filter(Boolean);
  const freshness = dates.length
    ? " The newest dated source is " + new Date(Math.max(...dates)).toISOString().slice(0, 10) + " (" + Math.max(0, Math.round((Date.now() - Math.max(...dates)) / 86400000)) + " days old)."
    : " None of these sources carries a date, so for anything that changes over time say that you could not confirm how current it is.";
  return "\n\nLIVE WEB CONTEXT — retrieved " + today + " (this is TODAY'S date)." + freshness + " " +
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
  // Only the live thread travels, and long earlier messages are shortened: what was said a few turns ago is context,
  // not something to re-send in full on every turn (this is most of the cost of a long conversation).
  for (const h of history.slice(-8)) if (h && h.content) { const c = String(h.content); messages.push({ role: h.role === "assistant" ? "assistant" : "user", content: c.length > 700 ? c.slice(0, 700) + "…" : c }); }
  if (body.query) messages.push({ role: "user", content: String(body.query) });
  return messages;
}
// ── EXACT TIME — never guessed, never read off a web page ────────────────────────
// Search snippets carry stale clock times and the model just invents one. So time and date questions
// are answered from THIS server's clock, converted with the built-in timezone database (which also
// handles daylight saving correctly). One line per place: "names" → "Label|IANA zone;…".
const TZ_DATA = [
  ["ghana|accra|kumasi", "Ghana (Accra)|Africa/Accra"], ["nigeria|lagos|abuja", "Nigeria (Lagos)|Africa/Lagos"], ["kenya|nairobi", "Kenya (Nairobi)|Africa/Nairobi"],
  ["south africa|johannesburg|cape town|pretoria|durban", "South Africa|Africa/Johannesburg"], ["egypt|cairo", "Egypt (Cairo)|Africa/Cairo"], ["ethiopia|addis ababa", "Ethiopia (Addis Ababa)|Africa/Addis_Ababa"],
  ["tanzania|dar es salaam|dodoma", "Tanzania|Africa/Dar_es_Salaam"], ["uganda|kampala", "Uganda (Kampala)|Africa/Kampala"], ["rwanda|kigali", "Rwanda (Kigali)|Africa/Kigali"], ["senegal|dakar", "Senegal (Dakar)|Africa/Dakar"],
  ["ivory coast|cote d'ivoire|abidjan", "Ivory Coast (Abidjan)|Africa/Abidjan"], ["cameroon|yaounde|douala", "Cameroon|Africa/Douala"], ["morocco|rabat|casablanca", "Morocco|Africa/Casablanca"], ["algeria|algiers", "Algeria (Algiers)|Africa/Algiers"],
  ["tunisia|tunis", "Tunisia (Tunis)|Africa/Tunis"], ["libya|tripoli", "Libya (Tripoli)|Africa/Tripoli"], ["sudan|khartoum", "Sudan (Khartoum)|Africa/Khartoum"], ["south sudan|juba", "South Sudan (Juba)|Africa/Juba"],
  ["zambia|lusaka", "Zambia (Lusaka)|Africa/Lusaka"], ["zimbabwe|harare", "Zimbabwe (Harare)|Africa/Harare"], ["mozambique|maputo", "Mozambique (Maputo)|Africa/Maputo"], ["angola|luanda", "Angola (Luanda)|Africa/Luanda"],
  ["namibia|windhoek", "Namibia (Windhoek)|Africa/Windhoek"], ["botswana|gaborone", "Botswana (Gaborone)|Africa/Gaborone"], ["malawi|lilongwe", "Malawi|Africa/Blantyre"], ["madagascar|antananarivo", "Madagascar|Indian/Antananarivo"],
  ["mali|bamako", "Mali (Bamako)|Africa/Bamako"], ["burkina faso|ouagadougou", "Burkina Faso|Africa/Ouagadougou"], ["niger|niamey", "Niger (Niamey)|Africa/Niamey"], ["chad|n'djamena|ndjamena", "Chad|Africa/Ndjamena"],
  ["togo|lome", "Togo (Lomé)|Africa/Lome"], ["benin|cotonou|porto-novo", "Benin|Africa/Porto-Novo"], ["liberia|monrovia", "Liberia (Monrovia)|Africa/Monrovia"], ["sierra leone|freetown", "Sierra Leone (Freetown)|Africa/Freetown"],
  ["gambia|banjul", "Gambia (Banjul)|Africa/Banjul"], ["guinea|conakry", "Guinea (Conakry)|Africa/Conakry"], ["guinea-bissau|bissau", "Guinea-Bissau|Africa/Bissau"], ["gabon|libreville", "Gabon (Libreville)|Africa/Libreville"],
  ["somalia|mogadishu", "Somalia (Mogadishu)|Africa/Mogadishu"], ["eritrea|asmara", "Eritrea (Asmara)|Africa/Asmara"], ["djibouti", "Djibouti|Africa/Djibouti"], ["mauritius", "Mauritius|Indian/Mauritius"], ["lesotho|maseru", "Lesotho|Africa/Maseru"], ["eswatini|swaziland|mbabane", "Eswatini|Africa/Mbabane"],
  ["burundi|bujumbura", "Burundi|Africa/Bujumbura"], ["congo brazzaville|republic of the congo|brazzaville", "Congo (Brazzaville)|Africa/Brazzaville"], ["central african republic|bangui", "Central African Republic|Africa/Bangui"], ["mauritania|nouakchott", "Mauritania|Africa/Nouakchott"], ["cape verde|cabo verde", "Cape Verde|Atlantic/Cape_Verde"],
  ["dr congo|drc|democratic republic of the congo|kinshasa|congo", "DR Congo (Kinshasa)|Africa/Kinshasa;DR Congo (Lubumbashi)|Africa/Lubumbashi"],
  ["china|beijing|shanghai|shenzhen|guangzhou", "China|Asia/Shanghai"], ["hong kong", "Hong Kong|Asia/Hong_Kong"], ["taiwan|taipei", "Taiwan (Taipei)|Asia/Taipei"], ["japan|tokyo|osaka", "Japan (Tokyo)|Asia/Tokyo"], ["south korea|korea|seoul", "South Korea (Seoul)|Asia/Seoul"], ["north korea|pyongyang", "North Korea|Asia/Pyongyang"],
  ["india|delhi|mumbai|new delhi|bangalore|kolkata|chennai", "India|Asia/Kolkata"], ["pakistan|karachi|islamabad|lahore", "Pakistan|Asia/Karachi"], ["bangladesh|dhaka", "Bangladesh (Dhaka)|Asia/Dhaka"], ["sri lanka|colombo", "Sri Lanka (Colombo)|Asia/Colombo"], ["nepal|kathmandu", "Nepal (Kathmandu)|Asia/Kathmandu"],
  ["afghanistan|kabul", "Afghanistan (Kabul)|Asia/Kabul"], ["iran|tehran", "Iran (Tehran)|Asia/Tehran"], ["iraq|baghdad", "Iraq (Baghdad)|Asia/Baghdad"], ["saudi arabia|saudi|riyadh|jeddah|mecca", "Saudi Arabia (Riyadh)|Asia/Riyadh"], ["uae|united arab emirates|dubai|abu dhabi", "UAE (Dubai)|Asia/Dubai"],
  ["qatar|doha", "Qatar (Doha)|Asia/Qatar"], ["kuwait", "Kuwait|Asia/Kuwait"], ["oman|muscat", "Oman (Muscat)|Asia/Muscat"], ["bahrain", "Bahrain|Asia/Bahrain"], ["yemen|sanaa|aden", "Yemen|Asia/Aden"], ["jordan|amman", "Jordan (Amman)|Asia/Amman"], ["lebanon|beirut", "Lebanon (Beirut)|Asia/Beirut"],
  ["syria|damascus", "Syria (Damascus)|Asia/Damascus"], ["israel|jerusalem|tel aviv", "Israel (Jerusalem)|Asia/Jerusalem"], ["turkey|turkiye|istanbul|ankara", "Türkiye (Istanbul)|Europe/Istanbul"], ["thailand|bangkok", "Thailand (Bangkok)|Asia/Bangkok"], ["vietnam|hanoi|ho chi minh", "Vietnam|Asia/Ho_Chi_Minh"],
  ["malaysia|kuala lumpur", "Malaysia (Kuala Lumpur)|Asia/Kuala_Lumpur"], ["singapore", "Singapore|Asia/Singapore"], ["philippines|manila", "Philippines (Manila)|Asia/Manila"], ["cambodia|phnom penh", "Cambodia|Asia/Phnom_Penh"], ["laos|vientiane", "Laos|Asia/Vientiane"], ["myanmar|burma|yangon", "Myanmar (Yangon)|Asia/Yangon"],
  ["mongolia|ulaanbaatar", "Mongolia|Asia/Ulaanbaatar"], ["uzbekistan|tashkent", "Uzbekistan (Tashkent)|Asia/Tashkent"], ["azerbaijan|baku", "Azerbaijan (Baku)|Asia/Baku"], ["armenia|yerevan", "Armenia (Yerevan)|Asia/Yerevan"], ["kyrgyzstan|bishkek", "Kyrgyzstan|Asia/Bishkek"], ["tajikistan|dushanbe", "Tajikistan|Asia/Dushanbe"], ["turkmenistan|ashgabat", "Turkmenistan|Asia/Ashgabat"],
  ["indonesia|jakarta", "Indonesia (Jakarta)|Asia/Jakarta;Indonesia (Bali/Makassar)|Asia/Makassar;Indonesia (Papua)|Asia/Jayapura"], ["kazakhstan|almaty|astana", "Kazakhstan (Almaty)|Asia/Almaty"], ["maldives", "Maldives|Indian/Maldives"], ["brunei", "Brunei|Asia/Brunei"], ["bhutan|thimphu", "Bhutan|Asia/Thimphu"],
  ["uk|u.k.|united kingdom|britain|great britain|england|london|scotland|wales", "United Kingdom (London)|Europe/London"], ["ireland|dublin", "Ireland (Dublin)|Europe/Dublin"], ["france|paris", "France (Paris)|Europe/Paris"], ["germany|berlin|frankfurt|munich", "Germany (Berlin)|Europe/Berlin"], ["spain|madrid|barcelona", "Spain (Madrid)|Europe/Madrid"],
  ["portugal|lisbon", "Portugal (Lisbon)|Europe/Lisbon"], ["italy|rome|milan", "Italy (Rome)|Europe/Rome"], ["netherlands|holland|amsterdam", "Netherlands (Amsterdam)|Europe/Amsterdam"], ["belgium|brussels", "Belgium (Brussels)|Europe/Brussels"], ["switzerland|zurich|geneva|bern", "Switzerland (Zurich)|Europe/Zurich"],
  ["austria|vienna", "Austria (Vienna)|Europe/Vienna"], ["sweden|stockholm", "Sweden (Stockholm)|Europe/Stockholm"], ["norway|oslo", "Norway (Oslo)|Europe/Oslo"], ["denmark|copenhagen", "Denmark (Copenhagen)|Europe/Copenhagen"], ["finland|helsinki", "Finland (Helsinki)|Europe/Helsinki"], ["iceland|reykjavik", "Iceland (Reykjavik)|Atlantic/Reykjavik"],
  ["poland|warsaw", "Poland (Warsaw)|Europe/Warsaw"], ["czechia|czech republic|prague", "Czechia (Prague)|Europe/Prague"], ["hungary|budapest", "Hungary (Budapest)|Europe/Budapest"], ["romania|bucharest", "Romania (Bucharest)|Europe/Bucharest"], ["bulgaria|sofia", "Bulgaria (Sofia)|Europe/Sofia"], ["greece|athens", "Greece (Athens)|Europe/Athens"],
  ["ukraine|kyiv|kiev", "Ukraine (Kyiv)|Europe/Kyiv"], ["belarus|minsk", "Belarus (Minsk)|Europe/Minsk"], ["serbia|belgrade", "Serbia (Belgrade)|Europe/Belgrade"], ["croatia|zagreb", "Croatia (Zagreb)|Europe/Zagreb"], ["slovakia|bratislava", "Slovakia|Europe/Bratislava"], ["slovenia|ljubljana", "Slovenia|Europe/Ljubljana"],
  ["estonia|tallinn", "Estonia (Tallinn)|Europe/Tallinn"], ["latvia|riga", "Latvia (Riga)|Europe/Riga"], ["lithuania|vilnius", "Lithuania (Vilnius)|Europe/Vilnius"], ["cyprus|nicosia", "Cyprus (Nicosia)|Asia/Nicosia"], ["malta|valletta", "Malta|Europe/Malta"], ["luxembourg", "Luxembourg|Europe/Luxembourg"], ["albania|tirana", "Albania|Europe/Tirane"],
  ["russia|moscow", "Russia (Moscow)|Europe/Moscow;Russia (Yekaterinburg)|Asia/Yekaterinburg;Russia (Novosibirsk)|Asia/Novosibirsk;Russia (Vladivostok)|Asia/Vladivostok"],
  ["usa|u.s.a.|u.s.|united states|united states of america|america|the us", "USA (New York, Eastern)|America/New_York;USA (Chicago, Central)|America/Chicago;USA (Denver, Mountain)|America/Denver;USA (Los Angeles, Pacific)|America/Los_Angeles;USA (Anchorage, Alaska)|America/Anchorage;USA (Honolulu, Hawaii)|Pacific/Honolulu"],
  ["new york|nyc|washington|washington dc|boston|miami|atlanta|philadelphia", "New York / US East Coast|America/New_York"], ["chicago|houston|dallas|texas", "Chicago / US Central|America/Chicago"], ["denver|phoenix|salt lake city", "Denver / US Mountain|America/Denver"],
  ["los angeles|san francisco|seattle|las vegas|california", "Los Angeles / US Pacific|America/Los_Angeles"], ["hawaii|honolulu", "Hawaii|Pacific/Honolulu"], ["alaska|anchorage", "Alaska|America/Anchorage"],
  ["canada", "Canada (Toronto, Eastern)|America/Toronto;Canada (Winnipeg, Central)|America/Winnipeg;Canada (Edmonton, Mountain)|America/Edmonton;Canada (Vancouver, Pacific)|America/Vancouver;Canada (Halifax, Atlantic)|America/Halifax;Canada (St. John's)|America/St_Johns"],
  ["toronto|ottawa|montreal", "Toronto / Ottawa|America/Toronto"], ["vancouver", "Vancouver|America/Vancouver"], ["mexico|mexico city", "Mexico (Mexico City)|America/Mexico_City"], ["cuba|havana", "Cuba (Havana)|America/Havana"], ["jamaica|kingston", "Jamaica|America/Jamaica"], ["haiti", "Haiti|America/Port-au-Prince"],
  ["dominican republic|santo domingo", "Dominican Republic|America/Santo_Domingo"], ["panama", "Panama|America/Panama"], ["costa rica", "Costa Rica|America/Costa_Rica"], ["guatemala", "Guatemala|America/Guatemala"], ["puerto rico", "Puerto Rico|America/Puerto_Rico"], ["trinidad|tobago", "Trinidad and Tobago|America/Port_of_Spain"], ["barbados", "Barbados|America/Barbados"], ["bahamas|nassau", "Bahamas (Nassau)|America/Nassau"],
  ["brazil|brasilia|sao paulo|rio de janeiro|rio", "Brazil (Brasília / São Paulo)|America/Sao_Paulo;Brazil (Manaus)|America/Manaus"], ["argentina|buenos aires", "Argentina (Buenos Aires)|America/Argentina/Buenos_Aires"], ["chile|santiago", "Chile (Santiago)|America/Santiago"], ["colombia|bogota", "Colombia (Bogotá)|America/Bogota"], ["peru|lima", "Peru (Lima)|America/Lima"],
  ["venezuela|caracas", "Venezuela (Caracas)|America/Caracas"], ["ecuador|quito", "Ecuador (Quito)|America/Guayaquil"], ["bolivia|la paz", "Bolivia (La Paz)|America/La_Paz"], ["uruguay|montevideo", "Uruguay (Montevideo)|America/Montevideo"], ["paraguay|asuncion", "Paraguay (Asunción)|America/Asuncion"], ["guyana", "Guyana|America/Guyana"], ["suriname", "Suriname|America/Paramaribo"],
  ["australia", "Australia (Sydney/Melbourne/Canberra)|Australia/Sydney;Australia (Brisbane)|Australia/Brisbane;Australia (Adelaide)|Australia/Adelaide;Australia (Darwin)|Australia/Darwin;Australia (Perth)|Australia/Perth"],
  ["sydney|melbourne|canberra", "Sydney / Melbourne|Australia/Sydney"], ["brisbane|queensland", "Brisbane|Australia/Brisbane"], ["adelaide", "Adelaide|Australia/Adelaide"], ["perth", "Perth|Australia/Perth"], ["darwin", "Darwin|Australia/Darwin"],
  ["new zealand|auckland|wellington", "New Zealand (Auckland)|Pacific/Auckland"], ["fiji", "Fiji|Pacific/Fiji"], ["papua new guinea|port moresby", "Papua New Guinea|Pacific/Port_Moresby"],
  ["utc|gmt|zulu|greenwich", "UTC / GMT|UTC"], ["est|edt|eastern time", "US Eastern|America/New_York"], ["pst|pdt|pacific time", "US Pacific|America/Los_Angeles"], ["cet|cest|central european", "Central European|Europe/Paris"], ["west africa time", "West Africa (Lagos)|Africa/Lagos"],
  ["east africa time", "East Africa (Nairobi)|Africa/Nairobi"], ["sast", "South Africa (SAST)|Africa/Johannesburg"], ["jst", "Japan (JST)|Asia/Tokyo"],
];
let _tzIndex = null;
function tzIndex() {
  if (_tzIndex) return _tzIndex;
  const list = [];
  for (const [names, zones] of TZ_DATA) {
    const zs = zones.split(";").map((z) => { const [label, tz] = z.split("|"); return { label, tz }; });
    for (const n of names.split("|")) list.push({ name: n, zones: zs });
  }
  list.sort((a, b) => b.name.length - a.name.length); // longest first: "south africa" before "africa", "guinea-bissau" before "guinea"
  return (_tzIndex = list);
}
function findPlaces(q) {
  let s = " " + String(q || "").toLowerCase().replace(/[?!,;:()"“”]/g, " ").replace(/\s+/g, " ") + " ";
  const found = [], seenTz = new Set();
  for (const p of tzIndex()) {
    const key = " " + p.name + " ";
    if (!s.includes(key)) continue;
    s = s.split(key).join("  "); // consume it so a shorter name inside it can't match again
    const zones = p.zones.filter((z) => !seenTz.has(z.tz));
    zones.forEach((z) => seenTz.add(z.tz));
    if (zones.length) found.push(zones);
    if (found.length >= 4) break;
  }
  return found.flat().slice(0, 8);
}
function fmtTime(now, tz) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
  const t = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(now);
  // UTC offset from the zone's wall-clock parts (independent of the runtime's own time zone).
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(now).map((x) => [x.type, x.value]));
  const off = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(now.getTime() / 1000) * 1000) / 900000) * 15; // minutes, nearest quarter hour
  const sign = off < 0 ? "-" : "+", a = Math.abs(off), oh = Math.floor(a / 60), om = a % 60;
  return f + ", " + t + " (UTC" + sign + oh + (om ? ":" + String(om).padStart(2, "0") : "") + ")";
}
// Returns a system-prompt block with the exact times, or "" when the question isn't about time/date.
function timeBlock(q, userTz) {
  const s = String(q || "");
  if (parseDates(s).length) return ""; // "what day will 25 Dec 2027 be" is a calendar question, handled by the calendar tool
  // "what time should I eat" / "what date of birth" are NOT clock questions — only real "what time is it" forms count.
  const strong = /\b(what('?s| is)?( the)? (current |local |exact )?time\b(?! (should|do|does|would|can|to|for|of)\b)|what time (is it|now|right now)|current (local )?time|local time|time (right )?now|time is it|today'?s date|(what('?s| is)?|current) (the )?(date|day)\b(?! (of|for|to|when)\b)|what day is (it|today)|date today|what year is it)/i.test(s);
  const withPlace = /\btime\b.*\b(in|at|for|of)\b|\b(in|at|for)\b.*\btime\b/i.test(s);
  if (!strong && !withPlace) return "";
  const places = findPlaces(s);
  if (!strong && !places.length) return "";
  const now = new Date();
  const lines = [];
  for (const z of places) { try { lines.push("- " + z.label + ": " + fmtTime(now, z.tz)); } catch (_) { /* unknown zone on this runtime — skip it */ } }
  if (!places.length && userTz) { try { lines.push("- The user's own location (" + userTz + "): " + fmtTime(now, userTz)); } catch (_) {} }
  lines.push("- UTC: " + fmtTime(now, "UTC"));
  return "\n\nEXACT CURRENT TIME — read from the system clock at the moment of this question. This is authoritative: " +
    "use ONLY these times and ignore any clock time or date that appears in web results, search snippets or your memory. " +
    "Answer naturally and briefly, naming the place and its time (for example \"It's 8:46 PM in Accra.\"). " +
    "If a country has several time zones, give the main ones from the list. If the user gave no place, give their own local time if listed, otherwise UTC and offer to convert.\n" + lines.join("\n");
}
// ── EXACT-DATA TOOLS — numbers come from a calculator or a live data feed, never from the model ────
// Weather (Open-Meteo), currency (exchangerate-api open feed), crypto (Binance → CoinGecko), calendar
// arithmetic and plain math. Each returns "" when the question isn't about it, an authoritative block
// when it is, or an "unavailable" block if the feed didn't answer — so she says so instead of guessing.
async function jget(url, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms || 3500);
  try { const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": UA } }); return r.ok ? await r.json() : null; }
  catch (_) { return null; } finally { clearTimeout(t); }
}
// A live feed that is only slow for a moment gets one more, longer try before Noria says it is unavailable.
const jretry = async (url) => (await jget(url, 3500)) || (await jget(url, 6000));
const unavailable = (what) => "\n\nLIVE " + what.toUpperCase() + " DATA UNAVAILABLE — the live data service did not answer just now. Do NOT guess or use remembered numbers: tell the user plainly that you couldn't fetch live " + what + " right now and suggest trying again in a moment. Never mention this note.";
const fmtNum = (n, d) => Number(n).toLocaleString("en-US", { maximumFractionDigits: d == null ? 2 : d });

// Weather ------------------------------------------------------------------------------------------
const WMO = { 0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle", 61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain", 71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light rain showers", 81: "rain showers", 82: "violent rain showers", 85: "snow showers", 86: "heavy snow showers", 95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail" };
function weatherPlace(q, userTz) {
  const s = String(q || "");
  const pats = [
    /\b(?:weather|temperature|forecast|humidity|rain(?:ing)?|windy|sunny)\b(?:\s+(?:like|forecast|report))?\s+(?:in|at|for|of|near|around)\s+([^?.!,;]+)/i,
    /\bhow\s+(?:hot|cold|warm)\b[^?.!,;]*?\b(?:in|at)\s+([^?.!,;]+)/i,
    /\bhow\s+(?:hot|cold|warm)\s+is\s+(?!it\b|there\b|outside\b)([A-Za-z][^?.!,;]*)/i, // "how cold is London today"
    /\b(?:in|at|for|near|around)\s+([^?.!,;]+?)\s+(?:weather|temperature|forecast)\b/i,
    /^\W*(?:what(?:'s| is)?\s+|how(?:'s| is)\s+|tell me\s+)?(?:the\s+)?([A-Za-z][A-Za-z .'-]{1,30}?)\s+(?:weather|temperature|forecast)\b/i,
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m) { const p = m[1].replace(/\b(right now|now|today|tonight|tomorrow|this (?:week|weekend|morning|afternoon|evening)|currently|at the moment|please|like|going to be|will be|the)\b.*$/i, "").replace(/^the\s+/i, "").trim(); if (p && p.length > 1) return p; }
  }
  if (userTz && userTz.includes("/")) return userTz.split("/").pop().replace(/_/g, " ");
  return "";
}
async function weatherBlock(q, userTz) {
  if (!/\b(weather|temperature|forecast|raining|rain|humidity|how (?:hot|cold|warm)|windy|sunny|snowing)\b/i.test(q)) return "";
  // "Convert 30 degrees Celsius to Fahrenheit" is a unit question, not weather.
  if (/\b(convert|conversion|celsius|fahrenheit|kelvin|centigrade)\b|°\s*[cfk]\b|\bto\s+(?:c|f|k)\b/i.test(q)) return "";
  let place = weatherPlace(q, userTz);
  // Falling back to the visitor's own city is only right when the question is plainly about the weather.
  if (place && !/\b(in|at|for|near|around)\s+/i.test(q) && !/\b(weather|forecast|temperature|how (?:hot|cold|warm)|raining|rain)\b/i.test(q)) place = "";
  if (!place) return "";
  const g = await jretry("https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=" + encodeURIComponent(place));
  const loc = g && g.results && g.results[0];
  if (!loc) return g === null ? unavailable("weather") : "";
  const f = await jretry("https://api.open-meteo.com/v1/forecast?latitude=" + loc.latitude + "&longitude=" + loc.longitude +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=3&timezone=auto");
  if (!f || !f.current) return unavailable("weather");
  const c = f.current, d = f.daily || {}, name = loc.name + (loc.country ? ", " + loc.country : "");
  const day = (i) => d.time && d.time[i] ? d.time[i] + ": " + (WMO[d.weather_code[i]] || "") + ", high " + d.temperature_2m_max[i] + "°C, low " + d.temperature_2m_min[i] + "°C, rain chance " + (d.precipitation_probability_max ? d.precipitation_probability_max[i] : "?") + "%" : "";
  return "\n\nLIVE WEATHER for " + name + " (Open-Meteo, measured " + c.time + " local time) — authoritative; use these exact numbers and never substitute remembered or web figures.\n" +
    "- Now: " + c.temperature_2m + "°C (feels like " + c.apparent_temperature + "°C), " + (WMO[c.weather_code] || "conditions unknown") + ", humidity " + c.relative_humidity_2m + "%, wind " + c.wind_speed_10m + " km/h, precipitation " + c.precipitation + " mm\n" +
    "- Today — " + day(0) + "\n- Tomorrow — " + day(1) + "\n- Day after — " + day(2) + "\nAnswer briefly with the place, the temperature and the conditions.";
}

// Currency -----------------------------------------------------------------------------------------
const CUR_NAMES = [
  ["ghanaian cedis?|ghana cedis?|cedis?|ghs", "GHS"], ["nigerian nairas?|nairas?|naira|ngn", "NGN"], ["kenyan shillings?|kes", "KES"], ["ugandan shillings?|ugx", "UGX"], ["tanzanian shillings?|tzs", "TZS"],
  ["south african rands?|rands?|zar", "ZAR"], ["us dollars?|u\\.s\\. dollars?|american dollars?|dollars?|usd|bucks", "USD"], ["euros?|eur", "EUR"], ["british pounds?|pounds? sterling|pounds?|gbp|sterling", "GBP"],
  ["japanese yen|yen|jpy", "JPY"], ["chinese yuan|yuan|renminbi|rmb|cny", "CNY"], ["indian rupees?|rupees?|inr", "INR"], ["cfa francs?|west african cfa|xof|cfa", "XOF"], ["canadian dollars?|cad", "CAD"],
  ["australian dollars?|aud", "AUD"], ["swiss francs?|chf", "CHF"], ["emirati dirhams?|uae dirhams?|dirhams?|aed", "AED"], ["saudi riyals?|riyals?|sar", "SAR"], ["egyptian pounds?|egp", "EGP"],
  ["brazilian reals?|reais|brl", "BRL"], ["mexican pesos?|mxn", "MXN"], ["south korean won|korean won|won|krw", "KRW"], ["turkish lira|lira|try", "TRY"], ["russian rubles?|rubles?|roubles?|rub", "RUB"],
  ["pakistani rupees?|pkr", "PKR"], ["bangladeshi taka|taka|bdt", "BDT"], ["singapore dollars?|sgd", "SGD"], ["hong kong dollars?|hkd", "HKD"], ["new zealand dollars?|nzd", "NZD"],
  ["moroccan dirhams?|mad", "MAD"], ["ethiopian birr|birr|etb", "ETB"], ["rwandan francs?|rwf", "RWF"], ["zambian kwacha|kwacha|zmw", "ZMW"], ["botswana pula|pula|bwp", "BWP"],
];
let _curRe = null, _curMap = null;
function curIndex() {
  if (_curRe) return;
  const pairs = [];
  for (const [alts, code] of CUR_NAMES) for (const a of alts.split("|")) pairs.push([a, code]);
  pairs.sort((x, y) => y[0].length - x[0].length);
  _curRe = new RegExp("(?<![a-z])(?:" + pairs.map((p) => p[0]).join("|") + ")(?![a-z])|[$€£¥]", "gi");
  _curMap = pairs;
}
function curCode(txt) {
  const t = txt.toLowerCase();
  if (t === "$") return "USD"; if (t === "€") return "EUR"; if (t === "£") return "GBP"; if (t === "¥") return "JPY";
  for (const [a, code] of _curMap) if (new RegExp("^(?:" + a + ")$", "i").test(t)) return code;
  return "";
}
async function currencyBlock(q) {
  const s = String(q || "");
  if (!/\b(convert|conversion|exchange|how (?:many|much)|worth|rate|equals?|equivalent|in|into|to)\b|=/i.test(s)) return "";
  curIndex();
  const found = []; let m; _curRe.lastIndex = 0;
  while ((m = _curRe.exec(s))) { const code = curCode(m[0]); if (code) found.push({ code, at: m.index }); }
  const distinct = found.filter((f, i) => found.findIndex((g) => g.code === f.code) === i);
  if (distinct.length < 2) return "";
  const num = s.match(/\d[\d,]*(?:\.\d+)?/);
  const amount = num ? parseFloat(num[0].replace(/,/g, "")) : 1;
  const a = distinct[0], b = distinct[1];
  // "how many cedis is 1 dollar" → the amount belongs to the SECOND currency; "100 dollars in cedis" → the FIRST.
  const targetFirst = num ? a.at < num.index : /^\W*how\s+(?:many|much)\s+/i.test(s) && /^\W*how\s+(?:many|much)\s+(?:of\s+)?(?:[a-z.]+\s+){0,2}(?:is|are|do|does|would|will|can)\b/i.test(s);
  const from = targetFirst ? b.code : a.code, to = targetFirst ? a.code : b.code;
  if (from === to) return "";
  const j = await jget("https://open.er-api.com/v6/latest/" + from);
  const rate = j && j.rates && j.rates[to];
  if (!rate) return unavailable("exchange-rate");
  const when = j.time_last_update_utc || "today";
  const out = amount * rate;
  return "\n\nLIVE EXCHANGE RATE (open exchange-rate feed, updated " + when + ") — authoritative; use these exact numbers.\n" +
    "- 1 " + from + " = " + fmtNum(rate, rate < 1 ? 6 : 4) + " " + to + (amount === 1 ? "" : "\n- " + fmtNum(amount, 6) + " " + from + " = " + fmtNum(out, out < 1 ? 6 : 2) + " " + to) +
    "\nAnswer briefly with the converted amount and mention it is a live mid-market rate (banks and transfer services add a margin).";
}

// Crypto -------------------------------------------------------------------------------------------
const COINS = [["bitcoin|btc", "BTCUSDT", "bitcoin", "Bitcoin"], ["ethereum|ether|eth", "ETHUSDT", "ethereum", "Ethereum"], ["solana|sol", "SOLUSDT", "solana", "Solana"], ["bnb|binance coin", "BNBUSDT", "binancecoin", "BNB"],
  ["xrp|ripple", "XRPUSDT", "ripple", "XRP"], ["cardano|ada", "ADAUSDT", "cardano", "Cardano"], ["dogecoin|doge", "DOGEUSDT", "dogecoin", "Dogecoin"], ["litecoin|ltc", "LTCUSDT", "litecoin", "Litecoin"],
  ["tron|trx", "TRXUSDT", "tron", "TRON"], ["polkadot|dot", "DOTUSDT", "polkadot", "Polkadot"], ["avalanche|avax", "AVAXUSDT", "avalanche-2", "Avalanche"], ["chainlink|link", "LINKUSDT", "chainlink", "Chainlink"], ["toncoin|ton", "TONUSDT", "the-open-network", "Toncoin"]];
async function cryptoBlock(q) {
  const s = String(q || "").toLowerCase();
  if (!/\b(price|cost|worth|trading|value|rate|how much|market|today|now|up|down)\b/.test(s)) return "";
  const hits = COINS.filter(([names]) => new RegExp("(?<![a-z])(?:" + names + ")(?![a-z])", "i").test(s)).slice(0, 3);
  if (!hits.length) return "";
  const rows = [];
  // Several exchanges are asked AT THE SAME TIME and the first good answer wins — some data-center regions
  // are blocked by individual exchanges (e.g. Binance), so no single one can be relied on.
  const firstOf = (ps) => new Promise((res) => { let n = ps.length; ps.forEach((p) => p.then((v) => { if (v) res(v); else if (--n === 0) res(null); }, () => { if (--n === 0) res(null); })); });
  for (const [, sym, cg, label] of hits) {
    const base = sym.replace("USDT", "");
    const got = await firstOf([
      jget("https://api.coinbase.com/v2/prices/" + base + "-USD/spot").then((c) => c && c.data && c.data.amount ? { price: parseFloat(c.data.amount), chg: null, src: "Coinbase" } : null),
      jget("https://api.kraken.com/0/public/Ticker?pair=" + (base === "BTC" ? "XBT" : base === "DOGE" ? "XDG" : base) + "USD").then((k) => { const t = k && k.result && Object.values(k.result)[0]; return t && t.c ? { price: parseFloat(t.c[0]), chg: t.o ? (parseFloat(t.c[0]) / parseFloat(t.o) - 1) * 100 : null, src: "Kraken" } : null; }),
      jget("https://api.binance.com/api/v3/ticker/24hr?symbol=" + sym).then((b) => b && b.lastPrice ? { price: parseFloat(b.lastPrice), chg: parseFloat(b.priceChangePercent), src: "Binance" } : null),
      jget("https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&include_24hr_change=true&ids=" + cg).then((c) => c && c[cg] && c[cg].usd != null ? { price: c[cg].usd, chg: c[cg].usd_24h_change, src: "CoinGecko" } : null),
    ]);
    if (!got || !isFinite(got.price)) return unavailable("crypto price");
    const { price, chg, src } = got;
    rows.push("- " + label + ": $" + fmtNum(price, price < 1 ? 6 : 2) + " USD" + (chg != null && !isNaN(chg) ? " (" + (chg >= 0 ? "+" : "") + chg.toFixed(2) + "% since the daily open)" : "") + " — " + src + ", live");
  }
  return "\n\nLIVE CRYPTO PRICES (fetched " + new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC) — authoritative; use these exact figures, never remembered ones.\n" + rows.join("\n") + "\nAnswer briefly with the price and the 24-hour move.";
}

// Calendar + arithmetic ----------------------------------------------------------------------------
const MON_RE = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const monIdx = (m) => ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(String(m).toLowerCase().slice(0, 3));
function parseDates(s) {
  const out = [];
  const add = (idx, y, mo, d) => { const t = Date.UTC(+y, mo, +d); const dt = new Date(t); if (dt.getUTCFullYear() === +y && dt.getUTCMonth() === mo && dt.getUTCDate() === +d) out.push({ idx, t }); };
  let m; const r1 = new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(" + MON_RE + ")\\.?,?\\s+(\\d{4})\\b", "gi");
  const r2 = new RegExp("\\b(" + MON_RE + ")\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b", "gi");
  const r3 = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = r1.exec(s))) add(m.index, m[3], monIdx(m[2]), m[1]);
  while ((m = r2.exec(s))) add(m.index, m[3], monIdx(m[1]), m[2]);
  while ((m = r3.exec(s))) add(m.index, m[1], +m[2] - 1, m[3]);
  return out.sort((a, b) => a.idx - b.idx);
}
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const fmtDate = (t) => { const d = new Date(t); return DAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " + ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getUTCMonth()] + " " + d.getUTCFullYear(); };
function calendarBlock(q) {
  const s = String(q || ""), dates = parseDates(s);
  if (!dates.length) return "";
  const head = "\n\nCOMPUTED EXACTLY BY THE SYSTEM (calendar) — authoritative; state these results as they are.\n", DAY = 86400000;
  const todayT = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const lines = [];
  if (dates.length >= 2 && /\b(between|from|difference|how (?:many|long)|days|weeks|apart|elapsed)\b/i.test(s)) {
    const a = dates[0].t, b = dates[1].t, n = Math.round((b - a) / DAY);
    lines.push("- " + fmtDate(a) + " to " + fmtDate(b) + ": " + Math.abs(n) + " days (" + (Math.abs(n) / 7).toFixed(1) + " weeks)" + (n < 0 ? " — the second date is earlier" : ""));
  } else if (dates.length === 1) {
    const t = dates[0].t, n = Math.round((t - todayT) / DAY);
    if (/\bhow old\b|\bage\b|\bborn\b/i.test(s) && n <= 0) { const d = new Date(t), nw = new Date(todayT); let age = nw.getUTCFullYear() - d.getUTCFullYear(); if (nw.getUTCMonth() < d.getUTCMonth() || (nw.getUTCMonth() === d.getUTCMonth() && nw.getUTCDate() < d.getUTCDate())) age--; lines.push("- Born " + fmtDate(t) + " → age today (" + fmtDate(todayT) + "): " + age + " years"); }
    else if (/\b(until|till|to go|left|remaining|since|ago|from now|days)\b/i.test(s) && /\bhow (?:many|long)\b|\bdays\b/i.test(s)) lines.push("- Today is " + fmtDate(todayT) + " (UTC). " + fmtDate(t) + (n >= 0 ? " is " + n + " days from today" : " was " + Math.abs(n) + " days ago"));
    else lines.push("- " + fmtDate(t) + (n > 0 ? " (in the future)" : n < 0 ? " (in the past)" : " (today)"));
  } else return "";
  return head + lines.join("\n");
}
function calcEval(expr) { // safe arithmetic (no eval): + - * / ^ ( ) sqrt, unary minus
  const toks = expr.match(/sqrt|\d+(?:\.\d+)?|\.\d+|[()+\-*\/^]/g); if (!toks || toks.join("").length < expr.replace(/\s+/g, "").length) return null;
  let p = 0;
  const peek = () => toks[p], next = () => toks[p++];
  function prim() {
    const t = next();
    if (t === undefined) throw 0;
    if (t === "(") { const v = add(); if (next() !== ")") throw 0; return v; }
    if (t === "sqrt") { if (next() !== "(") throw 0; const v = add(); if (next() !== ")") throw 0; return Math.sqrt(v); }
    if (t === "-") return -pow();
    if (t === "+") return pow();
    const n = parseFloat(t); if (isNaN(n)) throw 0; return n;
  }
  function pow() { const b = prim(); if (peek() === "^") { next(); return Math.pow(b, pow()); } return b; }
  function mul() { let v = pow(); while (peek() === "*" || peek() === "/") { const o = next(), r = pow(); v = o === "*" ? v * r : v / r; } return v; }
  function add() { let v = mul(); while (peek() === "+" || peek() === "-") { const o = next(), r = mul(); v = o === "+" ? v + r : v - r; } return v; }
  try { const v = add(); return p === toks.length && isFinite(v) ? v : null; } catch (_) { return null; }
}
function mathBlock(q) {
  let s = String(q || "").toLowerCase();
  if (!/\d/.test(s) || !/\b(what(?:'s| is)?|calculate|compute|how much is|evaluate|solve|equals?|result of|answer to)\b|=/.test(s)) return "";
  s = s.replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/(\d+(?:\.\d+)?)\s*(?:%|percent)\s*of\s*/g, "($1/100)*")
    .replace(/square root of\s*(\d+(?:\.\d+)?)/g, "sqrt($1)")
    .replace(/(\d+(?:\.\d+)?)\s*squared\b/g, "($1^2)").replace(/(\d+(?:\.\d+)?)\s*cubed\b/g, "($1^3)")
    .replace(/to the power of|\*\*/g, "^").replace(/\btimes\b|multiplied by|×|(?<=\d)\s*x\s*(?=\d)/g, "*")
    .replace(/divided by|÷/g, "/").replace(/\bplus\b/g, "+").replace(/\bminus\b/g, "-");
  const cands = (s.match(/(?:sqrt)?[\d.()\s+\-*\/^]{3,}/g) || []).map((x) => x.trim()).filter((x) => /\d/.test(x) && /[+*\/^]|sqrt|\d\s*-\s*\d|\)\s*-|\(/.test(x));
  if (!cands.length) return "";
  cands.sort((a, b) => b.length - a.length);
  const raw = cands[0];
  // "2-3 day plan" is a range, not a subtraction: a bare hyphen only counts as minus with spaces or an explicit calculate verb.
  if (!/[+*\/^()]|sqrt/.test(raw) && !/\s-\s/.test(raw) && !/\b(calculate|compute|evaluate|solve)\b/.test(s)) return "";
  const expr = raw.replace(/\s+/g, "");
  if (expr.length > 80) return "";
  const v = calcEval(expr);
  if (v === null) return "";
  const val = Number(v.toPrecision(12));
  return "\n\nCOMPUTED EXACTLY BY THE SYSTEM (calculator) — authoritative; do not recompute or round differently.\n- " + expr.replace(/\*/g, " × ").replace(/\//g, " ÷ ").replace(/\^/g, " ^ ") + " = " + val.toLocaleString("en-US", { maximumFractionDigits: 10 }) + "\nState the result plainly.";
}
const calcBlock = (q) => calendarBlock(q) || mathBlock(q);
// A question that is ONLY arithmetic ("what is 17% of 2,340") is answered by the calculator itself. Even with the exact
// result placed in front of a model, one reply in a few came out wrong (39.78 for 397.8), so a plain sum never goes
// through a model at all: instant, and correct every time. Anything with other words in it still goes to the model.
const MATH_WORDS = /^(what|what's|whats|is|calculate|compute|how|much|solve|evaluate|the|result|of|percent|times|plus|minus|divided|by|multiplied|squared|cubed|power|to|square|root|equals?|please|tell|me|answer|[\d.,+\-*\/^()×÷x%=]+)$/i;
function mathDirect(q) {
  const raw = String(q || "").trim();
  if (raw.length > 70 || !/\d/.test(raw)) return null;
  const toks = raw.replace(/[?!]/g, " ").split(/\s+/).filter(Boolean);
  if (!toks.length || !toks.every((t) => MATH_WORDS.test(t))) return null;
  const blk = mathBlock(raw);
  const m = /= ([^\n]+)\n/.exec(blk);
  if (!m) return null;
  const val = Number(String(m[1]).replace(/,/g, ""));
  if (!isFinite(val)) return null;
  const shown = raw.replace(/[?!=]/g, "").replace(/^(please\s+)?(tell me\s+)?(what(?:'s| is)?|whats|calculate|compute|how much is|solve|evaluate|the result of|the answer to)\s+/i, "").trim();
  return shown + " = **" + val.toLocaleString("en-US", { maximumFractionDigits: 10 }) + "**";
}
// A question about the RESULT of a year that hasn't happened yet ("who won the 2050 World Cup") has no
// true answer. Left alone, the model invents one — so the system tells her the date and forbids it.
function futureBlock(q) {
  const s = String(q || ""), now = new Date(), y = now.getUTCFullYear();
  const yrs = (s.match(/\b(20[2-9]\d|21\d\d)\b/g) || []).map(Number).filter((n) => n > y);
  if (!yrs.length || !/\b(won|win|winner|winners|champion|champions|result|results|score|elected|happened|final|beat|defeated)\b/i.test(s)) return "";
  return "\n\nFUTURE-DATE NOTICE — today is " + now.toISOString().slice(0, 10) + ". The question is about " + yrs[0] + ", which has NOT happened yet, so nobody can know who won, the result, or what happened. " +
    "Do NOT invent a winner, score or outcome. Say plainly that it hasn't happened yet (and only if you are certain, add a known scheduled fact such as the host or dates). Never mention this note.";
}
function addSystem(messages, block) {
  const out = messages.slice();
  const i = out.findIndex((m) => m.role === "system");
  if (i >= 0) out[i] = { role: "system", content: out[i].content + block };
  else out.unshift({ role: "system", content: block.trim() });
  return out;
}
// ── VERIFIED REFERENCE LIBRARY — fixed lists are quoted from here, never recalled from a model's memory ──────────
// A model asked for a long fixed list (the 99 Names, the books of the Bible, the countries of Africa) will slip:
// repeat an entry, drop one, invent one. So the well-known closed lists live here, checked entry by entry, and
// a plain request for one is answered straight from this data (instant, no model, no quota, always complete).
// For any other question that touches a list ("how many…", "the 40th name…"), the list is placed in front of the
// model as ground truth. Each list states its own count, and a self-check at load time refuses a list that is short.
const REF_NAMES99 = [
  ["Ar-Rahman", "The Most Gracious"], ["Ar-Rahim", "The Most Merciful"], ["Al-Malik", "The King"], ["Al-Quddus", "The Most Holy"],
  ["As-Salam", "The Source of Peace"], ["Al-Mu'min", "The Granter of Security"], ["Al-Muhaymin", "The Guardian"], ["Al-'Aziz", "The Almighty"],
  ["Al-Jabbar", "The Compeller"], ["Al-Mutakabbir", "The Supreme"], ["Al-Khaliq", "The Creator"], ["Al-Bari'", "The Maker"],
  ["Al-Musawwir", "The Fashioner"], ["Al-Ghaffar", "The Constant Forgiver"], ["Al-Qahhar", "The All-Subduer"], ["Al-Wahhab", "The Bestower"],
  ["Ar-Razzaq", "The Provider"], ["Al-Fattah", "The Opener"], ["Al-'Alim", "The All-Knowing"], ["Al-Qabid", "The Withholder"],
  ["Al-Basit", "The Extender"], ["Al-Khafid", "The Reducer"], ["Ar-Rafi'", "The Exalter"], ["Al-Mu'izz", "The Honourer"],
  ["Al-Mudhill", "The Humiliator"], ["As-Sami'", "The All-Hearing"], ["Al-Basir", "The All-Seeing"], ["Al-Hakam", "The Judge"],
  ["Al-'Adl", "The Utterly Just"], ["Al-Latif", "The Subtle"], ["Al-Khabir", "The All-Aware"], ["Al-Halim", "The Forbearing"],
  ["Al-'Azim", "The Magnificent"], ["Al-Ghafur", "The All-Forgiving"], ["Ash-Shakur", "The Appreciative"], ["Al-'Ali", "The Most High"],
  ["Al-Kabir", "The Most Great"], ["Al-Hafiz", "The Preserver"], ["Al-Muqit", "The Sustainer"], ["Al-Hasib", "The Reckoner"],
  ["Al-Jalil", "The Majestic"], ["Al-Karim", "The Generous"], ["Ar-Raqib", "The Watchful"], ["Al-Mujib", "The Responsive"],
  ["Al-Wasi'", "The All-Encompassing"], ["Al-Hakim", "The Wise"], ["Al-Wadud", "The Loving"], ["Al-Majid", "The Glorious"],
  ["Al-Ba'ith", "The Resurrector"], ["Ash-Shahid", "The Witness"], ["Al-Haqq", "The Truth"], ["Al-Wakil", "The Trustee"],
  ["Al-Qawiyy", "The Strong"], ["Al-Matin", "The Firm"], ["Al-Wali", "The Protecting Friend"], ["Al-Hamid", "The Praiseworthy"],
  ["Al-Muhsi", "The Accounter"], ["Al-Mubdi'", "The Originator"], ["Al-Mu'id", "The Restorer"], ["Al-Muhyi", "The Giver of Life"],
  ["Al-Mumit", "The Bringer of Death"], ["Al-Hayy", "The Ever-Living"], ["Al-Qayyum", "The Self-Subsisting"], ["Al-Wajid", "The Finder"],
  ["Al-Majid (Al-Maajid)", "The Noble"], ["Al-Wahid", "The One"], ["Al-Ahad", "The Unique"], ["As-Samad", "The Eternal Refuge"],
  ["Al-Qadir", "The Able"], ["Al-Muqtadir", "The Powerful"], ["Al-Muqaddim", "The Expediter"], ["Al-Mu'akhkhir", "The Delayer"],
  ["Al-Awwal", "The First"], ["Al-Akhir", "The Last"], ["Az-Zahir", "The Manifest"], ["Al-Batin", "The Hidden"],
  ["Al-Waali", "The Governor"], ["Al-Muta'ali", "The Most Exalted"], ["Al-Barr", "The Source of Goodness"], ["At-Tawwab", "The Acceptor of Repentance"],
  ["Al-Muntaqim", "The Avenger"], ["Al-'Afuww", "The Pardoner"], ["Ar-Ra'uf", "The Compassionate"], ["Malik-ul-Mulk", "The Master of the Kingdom"],
  ["Dhul-Jalali wal-Ikram", "The Lord of Majesty and Generosity"], ["Al-Muqsit", "The Equitable"], ["Al-Jami'", "The Gatherer"], ["Al-Ghani", "The Self-Sufficient"],
  ["Al-Mughni", "The Enricher"], ["Al-Mani'", "The Preventer"], ["Ad-Darr", "The Distresser"], ["An-Nafi'", "The Benefactor"],
  ["An-Nur", "The Light"], ["Al-Hadi", "The Guide"], ["Al-Badi'", "The Incomparable Originator"], ["Al-Baqi", "The Everlasting"],
  ["Al-Warith", "The Inheritor"], ["Ar-Rashid", "The Guide to the Right Path"], ["As-Sabur", "The Patient"],
];
const REF_BIBLE_OT = ["Genesis", "Exodus", "Leviticus", "Numbers", "Deuteronomy", "Joshua", "Judges", "Ruth", "1 Samuel", "2 Samuel", "1 Kings", "2 Kings", "1 Chronicles", "2 Chronicles", "Ezra", "Nehemiah", "Esther", "Job", "Psalms", "Proverbs", "Ecclesiastes", "Song of Solomon", "Isaiah", "Jeremiah", "Lamentations", "Ezekiel", "Daniel", "Hosea", "Joel", "Amos", "Obadiah", "Jonah", "Micah", "Nahum", "Habakkuk", "Zephaniah", "Haggai", "Zechariah", "Malachi"];
const REF_BIBLE_NT = ["Matthew", "Mark", "Luke", "John", "Acts", "Romans", "1 Corinthians", "2 Corinthians", "Galatians", "Ephesians", "Philippians", "Colossians", "1 Thessalonians", "2 Thessalonians", "1 Timothy", "2 Timothy", "Titus", "Philemon", "Hebrews", "James", "1 Peter", "2 Peter", "1 John", "2 John", "3 John", "Jude", "Revelation"];
const REF_AFRICA = [
  ["Algeria", "Algiers"], ["Angola", "Luanda"], ["Benin", "Porto-Novo"], ["Botswana", "Gaborone"], ["Burkina Faso", "Ouagadougou"], ["Burundi", "Gitega"],
  ["Cabo Verde", "Praia"], ["Cameroon", "Yaoundé"], ["Central African Republic", "Bangui"], ["Chad", "N'Djamena"], ["Comoros", "Moroni"],
  ["Congo (Republic of the)", "Brazzaville"], ["Congo (Democratic Republic of the)", "Kinshasa"], ["Côte d'Ivoire", "Yamoussoukro"], ["Djibouti", "Djibouti"],
  ["Egypt", "Cairo"], ["Equatorial Guinea", "Malabo"], ["Eritrea", "Asmara"], ["Eswatini", "Mbabane"], ["Ethiopia", "Addis Ababa"], ["Gabon", "Libreville"],
  ["Gambia", "Banjul"], ["Ghana", "Accra"], ["Guinea", "Conakry"], ["Guinea-Bissau", "Bissau"], ["Kenya", "Nairobi"], ["Lesotho", "Maseru"], ["Liberia", "Monrovia"],
  ["Libya", "Tripoli"], ["Madagascar", "Antananarivo"], ["Malawi", "Lilongwe"], ["Mali", "Bamako"], ["Mauritania", "Nouakchott"], ["Mauritius", "Port Louis"],
  ["Morocco", "Rabat"], ["Mozambique", "Maputo"], ["Namibia", "Windhoek"], ["Niger", "Niamey"], ["Nigeria", "Abuja"], ["Rwanda", "Kigali"],
  ["São Tomé and Príncipe", "São Tomé"], ["Senegal", "Dakar"], ["Seychelles", "Victoria"], ["Sierra Leone", "Freetown"], ["Somalia", "Mogadishu"],
  ["South Africa", "Pretoria (executive), Cape Town (legislative), Bloemfontein (judicial)"], ["South Sudan", "Juba"], ["Sudan", "Khartoum"],
  ["Tanzania", "Dodoma"], ["Togo", "Lomé"], ["Tunisia", "Tunis"], ["Uganda", "Kampala"], ["Zambia", "Lusaka"], ["Zimbabwe", "Harare"],
];
const REF_NIGERIA = [
  ["Abia", "Umuahia"], ["Adamawa", "Yola"], ["Akwa Ibom", "Uyo"], ["Anambra", "Awka"], ["Bauchi", "Bauchi"], ["Bayelsa", "Yenagoa"], ["Benue", "Makurdi"],
  ["Borno", "Maiduguri"], ["Cross River", "Calabar"], ["Delta", "Asaba"], ["Ebonyi", "Abakaliki"], ["Edo", "Benin City"], ["Ekiti", "Ado-Ekiti"], ["Enugu", "Enugu"],
  ["Gombe", "Gombe"], ["Imo", "Owerri"], ["Jigawa", "Dutse"], ["Kaduna", "Kaduna"], ["Kano", "Kano"], ["Katsina", "Katsina"], ["Kebbi", "Birnin Kebbi"],
  ["Kogi", "Lokoja"], ["Kwara", "Ilorin"], ["Lagos", "Ikeja"], ["Nasarawa", "Lafia"], ["Niger", "Minna"], ["Ogun", "Abeokuta"], ["Ondo", "Akure"],
  ["Osun", "Osogbo"], ["Oyo", "Ibadan"], ["Plateau", "Jos"], ["Rivers", "Port Harcourt"], ["Sokoto", "Sokoto"], ["Taraba", "Jalingo"], ["Yobe", "Damaturu"], ["Zamfara", "Gusau"],
];
const REF_GHANA = [
  ["Ahafo", "Goaso"], ["Ashanti", "Kumasi"], ["Bono", "Sunyani"], ["Bono East", "Techiman"], ["Central", "Cape Coast"], ["Eastern", "Koforidua"],
  ["Greater Accra", "Accra"], ["North East", "Nalerigu"], ["Northern", "Tamale"], ["Oti", "Dambai"], ["Savannah", "Damongo"], ["Upper East", "Bolgatanga"],
  ["Upper West", "Wa"], ["Volta", "Ho"], ["Western", "Sekondi-Takoradi"], ["Western North", "Sefwi Wiawso"],
];
const REF_SURAHS = ["Al-Fatihah", "Al-Baqarah", "Ali 'Imran", "An-Nisa", "Al-Ma'idah", "Al-An'am", "Al-A'raf", "Al-Anfal", "At-Tawbah", "Yunus", "Hud", "Yusuf", "Ar-Ra'd", "Ibrahim", "Al-Hijr", "An-Nahl", "Al-Isra", "Al-Kahf", "Maryam", "Ta-Ha", "Al-Anbiya", "Al-Hajj", "Al-Mu'minun", "An-Nur", "Al-Furqan", "Ash-Shu'ara", "An-Naml", "Al-Qasas", "Al-'Ankabut", "Ar-Rum", "Luqman", "As-Sajdah", "Al-Ahzab", "Saba", "Fatir", "Ya-Sin", "As-Saffat", "Sad", "Az-Zumar", "Ghafir", "Fussilat", "Ash-Shura", "Az-Zukhruf", "Ad-Dukhan", "Al-Jathiyah", "Al-Ahqaf", "Muhammad", "Al-Fath", "Al-Hujurat", "Qaf", "Adh-Dhariyat", "At-Tur", "An-Najm", "Al-Qamar", "Ar-Rahman", "Al-Waqi'ah", "Al-Hadid", "Al-Mujadila", "Al-Hashr", "Al-Mumtahanah", "As-Saff", "Al-Jumu'ah", "Al-Munafiqun", "At-Taghabun", "At-Talaq", "At-Tahrim", "Al-Mulk", "Al-Qalam", "Al-Haqqah", "Al-Ma'arij", "Nuh", "Al-Jinn", "Al-Muzzammil", "Al-Muddaththir", "Al-Qiyamah", "Al-Insan", "Al-Mursalat", "An-Naba", "An-Nazi'at", "'Abasa", "At-Takwir", "Al-Infitar", "Al-Mutaffifin", "Al-Inshiqaq", "Al-Buruj", "At-Tariq", "Al-A'la", "Al-Ghashiyah", "Al-Fajr", "Al-Balad", "Ash-Shams", "Al-Layl", "Ad-Duha", "Ash-Sharh", "At-Tin", "Al-'Alaq", "Al-Qadr", "Al-Bayyinah", "Az-Zalzalah", "Al-'Adiyat", "Al-Qari'ah", "At-Takathur", "Al-'Asr", "Al-Humazah", "Al-Fil", "Quraysh", "Al-Ma'un", "Al-Kawthar", "Al-Kafirun", "An-Nasr", "Al-Masad", "Al-Ikhlas", "Al-Falaq", "An-Nas"];
const REF_PLANETS = ["Mercury", "Venus", "Earth", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"];
const REF_CONTINENTS = ["Africa", "Antarctica", "Asia", "Europe", "North America", "Oceania (Australia)", "South America"];
const REF_PILLARS = [["Shahada", "the declaration of faith"], ["Salah", "the five daily prayers"], ["Zakat", "giving to those in need"], ["Sawm", "fasting during Ramadan"], ["Hajj", "the pilgrimage to Mecca, for those who are able"]];
const numbered = (rows) => rows.map((r, i) => (i + 1) + ". " + r).join("\n");
const REFS = [
  { id: "names99", n: 99, rx: /\b(99|ninety[- ]?nine)\s+(beautiful\s+)?names\b|asma+[’']?\s*-?(ul|al)[- ]?husna|\bnames? of (allah|god)\b|\b(99|ninety[- ]?nine)\s+attributes\b/i,
    title: "The 99 Names of Allah (Asma’ul-Husna)",
    body: () => numbered(REF_NAMES99.map(([a, m]) => "**" + a + "** — " + m)),
    note: "This is the widely used list of 99 attributes (the name “Allah” itself is not counted among them). Traditions differ slightly in which names are included and how they are translated." },
  { id: "bible", n: 66, rx: /\bbooks of the (holy )?bible\b|\b(list|name|all)\b.{0,25}\bbooks\b.{0,20}\bbible\b|\b66 books\b/i,
    title: "The 66 books of the Bible",
    body: () => "**Old Testament (39)**\n" + numbered(REF_BIBLE_OT) + "\n\n**New Testament (27)**\n" + numbered(REF_BIBLE_NT),
    note: "This is the Protestant canon of 66 books. Catholic Bibles have 73, adding Tobit, Judith, 1 and 2 Maccabees, Wisdom, Sirach and Baruch; Orthodox Bibles include still more." },
  { id: "africa", n: 54, rx: /\b(countries|capitals?)\b.{0,30}\bafrica(n)?\b|\bafrica(n)?\b.{0,30}\b(countries|capitals?)\b|\b54\s+(african\s+)?(countries|nations)\b/i,
    title: "The 54 countries of Africa and their capitals",
    body: () => numbered(REF_AFRICA.map(([c, k]) => "**" + c + "** — " + k)),
    note: "These are the 54 sovereign states of Africa recognised by the United Nations. Western Sahara, a disputed territory, is not counted. Some countries have more than one seat of government; the one listed is the official capital, with the exceptions shown." },
  { id: "nigeria", n: 36, rx: /\bstates? (of|in) nigeria\b|\bnigeria(n)?\b.{0,20}\bstates\b|\bnigeria(n)?\b.{0,20}\bstate capitals\b/i,
    title: "The 36 states of Nigeria and their capitals",
    body: () => numbered(REF_NIGERIA.map(([s, c]) => "**" + s + "** — " + c)) + "\n\nPlus the **Federal Capital Territory (FCT)** — Abuja.",
    note: "Nigeria has 36 states and the Federal Capital Territory." },
  { id: "ghana", n: 16, rx: /\bregions? (of|in) ghana\b|\bghana(ian)?\b.{0,20}\bregions?\b/i,
    title: "The 16 regions of Ghana and their capitals",
    body: () => numbered(REF_GHANA.map(([s, c]) => "**" + s + "** — " + c)),
    note: "Ghana has had 16 regions since 2019." },
  { id: "surahs", n: 114, rx: /\b(surahs?|suras?|chapters?)\b.{0,25}\b(qur.?an|koran)\b|\b(qur.?an|koran)\b.{0,25}\b(surahs?|suras?|chapters?)\b|\b114 (surahs?|chapters?)\b/i,
    title: "The 114 surahs of the Qur’an",
    body: () => numbered(REF_SURAHS),
    note: "Names are given in the common English transliteration; spellings vary between publications." },
  { id: "planets", n: 8, rx: /\bplanets\b.{0,25}\bsolar system\b|\bsolar system\b.{0,25}\bplanets\b|\b(list|name)\b.{0,15}\bplanets\b/i,
    title: "The eight planets, in order from the Sun", body: () => numbered(REF_PLANETS), note: "" },
  { id: "continents", n: 7, rx: /\b(list|name|what are)\b.{0,20}\b(the )?(seven |7 )?continents\b/i,
    title: "The seven continents", body: () => numbered(REF_CONTINENTS), note: "" },
  { id: "pillars", n: 5, rx: /\b(five|5) pillars of islam\b|\bpillars of islam\b/i,
    title: "The Five Pillars of Islam", body: () => numbered(REF_PILLARS.map(([a, m]) => "**" + a + "** — " + m)), note: "" },
];
// Load-time self-check: a list whose length is not what it claims is switched off, never served short.
const REF_OK = REFS.filter((r) => { const c = r.id === "bible" ? REF_BIBLE_OT.length + REF_BIBLE_NT.length : r.body().split("\n").filter((l) => /^\d+\. /.test(l)).length; return c === r.n || (r.id === "nigeria" && c === 36); });
const REF_DIRECT_NO = /\b(explain|why|meaning|meanings|history|compare|difference|translate|arabic|essay|summari[sz]e|first|last|which|who|how many|number|#\d|\d+(st|nd|rd|th)|tell me about|describe|pdf|word|excel|table)\b/i;
const REF_LIST_VERB = /\b(list|give|show|name|write|recite|what are|tell me|share|provide|all|full|complete)\b/i;
// A question about a match, a winner, the news or "the latest" is about the live world, never a fixed list, even if it shares a word with one.
const REF_NEWSY = /\b(won|win|wins|winner|winners|champion|champions|cup|match|score|final|news|latest|recent|recently|president|today|yesterday|now|current|currently)\b/i;
function refMatch(q) { q = String(q || ""); if (REF_NEWSY.test(q) && !/\b(list|all|every)\b/i.test(q)) return null; return REF_OK.find((r) => r.rx.test(q)) || null; }
// A plain "list the 99 names" is answered straight from the library.
function refDirect(q) {
  q = String(q || "").trim();
  if (q.length > 110) return null;
  const r = refMatch(q);
  if (!r || !REF_LIST_VERB.test(q) || REF_DIRECT_NO.test(q)) return null;
  return "Here is the complete list: **" + r.title + "**.\n\n" + r.body() + (r.note ? "\n\n*" + r.note + "*" : "");
}
// Anything else that touches a list gets the list as ground truth.
function refBlock(q) {
  const r = refMatch(q);
  if (!r) return "";
  return "\n\n[VERIFIED REFERENCE — " + r.title + ". This list is checked and complete (" + r.n + " entries" + (r.id === "bible" ? " in the Protestant canon" : "") + "). Answer exactly what was asked, and only from it: for a count, a position or a single entry, give just that (briefly, in a sentence); print the whole list only if the person asked for the list. Quote entries exactly as written and keep the order and numbering; never add, drop, repeat or invent an entry, and never comment on or correct the list.]\n" + r.body() + (r.note ? "\n(" + r.note + ")" : "") + "\n";
}
// Nothing outside Noria may hold up her reply: a search, a feed or a data service that stalls is given a fixed time and
// then dropped, and she answers with what she has (or says plainly that she could not get the live detail).
const withTimeout = (p, ms, fallback) => Promise.race([Promise.resolve(p).catch(() => fallback), new Promise((r) => setTimeout(() => r(fallback), ms))]);
// The real clock, on EVERY request. The time tool below only fires on the phrasings it recognises, and a model that is
// not handed the clock either says it "cannot know the time" or invents a date. So every turn carries one short line with
// the exact date and time (in the person's own time zone, plus UTC); it is the source for any question about now.
function nowBlock(tz) {
  const zone = tz && String(tz).includes("/") ? String(tz) : "UTC";
  const d = new Date();
  let local = "";
  try {
    local = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  } catch (_) { return ""; }
  return "\n\n[CURRENT DATE AND TIME — the exact server clock, authoritative: " + local + " (" + zone + "); UTC " + d.toISOString().slice(0, 16).replace("T", " ") +
    ". Use this for any question about the time, date, day of the week, month, year, or how long until or since something. Never say you cannot know the time and never guess a date.]";
}
// A plain question about the time, date or day is answered from the clock alone: a web search for "is it morning or
// evening now" only drags in other cities' times and confuses the answer.
const CLOCK_Q = /\b(what|which)\s+(day|date|month|year|time)\b|\b(what'?s|what is|tell me|give me)\s+(the\s+)?(time|date|day)\b|\bhours?\s+(until|till|left|to)\b|\bis it (still\s+)?(morning|afternoon|evening|night|late|early)\b|\b(morning|afternoon|evening|night)\s+(or|now)\b|\btoday'?s date\b|\bcurrent (time|date|day)\b|\btime (now|please)\b|\bwhat'?s the day\b/i;
const CLOCK_NOT = /\b(news|weather|price|score|president|prime minister|who|won|happen|happened|stock|rate|holiday|schedule|flight|open|opens|close|closes)\b/i;
// Who holds an office or title today is the clearest case of a fact that goes stale. Such a question is ALWAYS checked
// against live sources on the server (whatever the app already fetched), the search is aimed at the current year, and if
// the sources do not answer, Noria says so plainly. She never falls back on memory, which stops before today.
const OFFICE_ROLE = "president|vice[- ]president|prime minister|deputy prime minister|minister|foreign minister|finance minister|governor|deputy governor|mayor|ceo|chief executive|chairman|chairperson|speaker|chief justice|head of state|king|queen|leader|secretary[- ]general|secretary of state|ambassador|inspector[- ]general|director[- ]general|attorney[- ]general|commissioner|senator|premier|chancellor|emir|monarch";
const OFFICE_Q = new RegExp("\\b(who\\s+(is|are|was|'s)|who's)\\b[^?.!]{0,60}\\b(" + OFFICE_ROLE + ")\\b|\\b(current|present|new|incumbent|sitting)\\s+(" + OFFICE_ROLE + ")\\b|\\b(" + OFFICE_ROLE + ")\\s+of\\s+[a-z]", "i");
const OFFICE_NOT = /\b(write|essay|poem|story|history of|first|founder|founded|how to become|salary|requirements|qualifications|powers of|role of|duties)\b/i;
const officeAsk = (q) => OFFICE_Q.test(q) && !OFFICE_NOT.test(q);
const NO_OFFICE_ANSWER = "I couldn't check who currently holds that office just now, because my live sources didn't answer. I would rather not give you a name from memory that might be out of date. Please try again in a moment.";
// ══ GROUNDING ENGINE ═══════════════════════════════════════════════════════════════════════════════════════════════
// Noria's memory stops before today, so anything that can change (who holds a post, prices, scores, laws, records, news,
// "is X still…") has to be READ from live sources, never recalled. The engine works in four steps, for every question:
//   1. DECIDE   — does this question depend on the state of the world today? (needsLive: cues of time, of a present-tense
//                 fact about a named person / place / organisation, or of a value that moves; not a list of titles)
//   2. RETRIEVE — every source at once (open web, Wikipedia, live news feeds), each with its own time limit, merged and
//                 ordered newest first, each item carrying its date.
//   3. ANSWER   — from those sources only. If retrieval fails for a question that must be current, she says so plainly.
//   4. VERIFY   — before the answer is shown, every name and year in it is checked against the sources. An answer that
//                 introduces names the sources never mention is rewritten once under a strict instruction; if it still
//                 does, she shows what the sources actually say instead. A guess never reaches the reader.
const STABLE_TASK = /\b(write|compose|draft|poem|story|essay|lyrics|code|function|refactor|debug|translate|rephrase|reword|summari[sz]e|brainstorm|pretend|role-?play|plan|build|create|make|prepare|produce|generate|design|explain (how|why)|teach me|help me)\b/i;
const LIVE_CUE = /\b(current|currently|latest|newest|recent|recently|today|tonight|right now|this (week|month|year|season)|as of|still|upcoming|nowadays|these days|at the moment|at present|present-day|so far this)\b|\bnow\b(?!\s+that)/i;
const MOVING_VALUE = /\b(price|cost of|rate|worth|net worth|population|score|scores|standings?|results?|forecast|schedule|fixtures?|ranking|rankings|salary|version|release date|stock|share price|exchange rate|inflation|unemployment|market cap|record|odds|winner|winners|champions?|how many (people|residents|inhabitants|users|customers|members))\b/i;
const STATE_Q = /\b(who|what|which)\s+(is|are|was|were)\b|\bwho\s+(leads|runs|heads|owns|manages|coaches|captains|founded|won|wins|plays|represents|replaced|succeeded|replaces|took over)\b|\bhow (much|many)\b|\bis\s+.{2,40}\b(still|alive|dead|married|open|closed|available|legal|banned|real|true|dating|retired)\b/i;
const STABLE_FACT = /\b(capital of|currency of|official language|largest (country|city|ocean)|who (wrote|invented|discovered|painted|composed)|meaning of|definition of|synonym|antonym|boiling point|melting point|formula for|symbol for|atomic number)\b/i;
const STATUS_Q = /\bis\s+.{2,40}\b(available|open|closed|legal|banned|allowed|working|down|operating)\b/i;
const NOT_ENTITY = new Set("I,I'm,I've,I'd,I'll,Noria,The,A,An,What,Who,Which,Where,When,Why,How,Is,Are,Was,Were,Do,Does,Did,Can,Could,Should,Would,Will,Tell,Give,Show,Please,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday,January,February,March,April,May,June,July,August,September,October,November,December,English,Ok,Okay,Hi,Hello,Hey,Thanks".split(","));
function hasEntity(q) { // a capitalised name somewhere after the first word: a specific person, place or organisation is being asked about
  const words = String(q || "").replace(/[?!.,;:()"“”]/g, " ").split(/\s+/).filter(Boolean);
  return words.slice(1).some((w) => /^[A-Z][\p{L}'’-]{2,}$/u.test(w) && !NOT_ENTITY.has(w)) || /\b(his|her|their|its)\s+(net worth|age|wife|husband|salary)\b/i.test(q);
}
// 'must' = an out-of-date answer would mislead, so no live source means no answer. 'maybe' = worth checking live, but an answer
// from general knowledge is still fair when the sources have nothing.
function liveStrength(q) {
  const s = String(q || "");
  if (STABLE_TASK.test(s) && !LIVE_CUE.test(s) && !officeAsk(s)) return "no";
  if (STABLE_FACT.test(s) && !LIVE_CUE.test(s)) return "no";
  if (officeAsk(s) || LIVE_CUE.test(s) || MOVING_VALUE.test(s) || STATUS_Q.test(s)) return "must";
  if (STATE_Q.test(s) && hasEntity(s)) return "maybe";
  if (serverNeedsWeb(s)) return "must";
  return "no";
}
const NO_LIVE_ANSWER = "I couldn't reach my live sources for that just now, and it is the kind of question where an out-of-date answer would mislead you. I would rather not guess. Please try again in a moment.";

// ── verification ───────────────────────────────────────────────────────────────────────────────────────────────────
const SC_SKIP = new Set("i,i'm,i've,noria,the,a,an,as,in,on,at,it,it's,he,she,they,we,you,this,that,these,those,here,there,note,source,sources,yes,no,however,also,today,according,based,currently,current,latest,recent,live,web,context,summary,sunday,monday,tuesday,wednesday,thursday,friday,saturday,january,february,march,april,may,june,july,august,september,october,november,december,utc,gmt,and,but,or,so,if,for,from,with,while,since,after,before,during,since,then,when,where,who,what,which,why,how,is,are,was,were,his,her,their,its,one,two,three,mr,mrs,ms,dr,hon,president,minister,prime,foreign,vice,chief,secretary,governor,mayor,ceo".split(","));
const fold = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
function claimPhrases(text) {
  const clean = String(text || "").replace(/\*\*|__|`|\[\d+\]|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/g, " ");
  const phrases = new Set(), years = new Set();
  const strip = (w) => w.replace(/^[("'“‘]+|[)"'”’.,;:!?…]+$/g, "");
  for (const sent of clean.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sent.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      const w = strip(words[i]);
      if (/^[A-Z][\p{L}'’.-]+$/u.test(w) && !SC_SKIP.has(w.toLowerCase())) {
        let j = i; const run = [w];
        while (j + 1 < words.length) {
          const nx = strip(words[j + 1]);
          if (/^[A-Z][\p{L}'’.-]+$/u.test(nx) && !SC_SKIP.has(nx.toLowerCase())) { run.push(nx); j++; } else break;
        }
        if (!(i === 0 && run.length === 1)) phrases.add(run.join(" "));
        i = j + 1; continue;
      }
      i++;
    }
  }
  for (const m of clean.matchAll(/\b(?:19|20)\d{2}\b/g)) years.add(m[0]);
  return { phrases: [...phrases], years: [...years] };
}
function verifyAnswer(text, live, q) {
  if (!live || !live.ctx) return { ok: true, unsupported: [] };
  const hay = fold(live.ctx + " " + q + " " + nowBlock("UTC") + " " + (live.extra || ""));
  const { phrases, years } = claimPhrases(text);
  const bad = [];
  for (const ph of phrases) {
    const parts = fold(ph).split(/\s+/).map((w) => w.replace(/[.,'’]/g, "")).filter((w) => w.length > 2);
    if (parts.length && !parts.every((w) => hay.includes(w))) bad.push(ph);
  }
  for (const y of years) if (!hay.includes(y)) bad.push(y);
  return { ok: bad.length < 2 && !years.some((y) => !hay.includes(y)), unsupported: bad };
}
function fromSources(live) {
  const rows = (live.sources || []).slice(0, 4).map((r) => "• " + r.title + (r.date ? " (" + String(r.date).slice(0, 16) + ")" : "") + (r.snippet ? ": " + String(r.snippet).replace(/\s+/g, " ").slice(0, 220) : "") + (r.url ? "\n  " + r.url : ""));
  return "I couldn't confirm a precise answer to that from my live sources, and I don't want to guess. This is what they say:\n\n" + rows.join("\n") + "\n\nIf you tell me which part matters most, I can look again.";
}
// The answer for a question that was grounded on live sources: draft, verify, correct once, and if it still cannot be
// supported show the sources themselves.
async function liveAnswer(messages, env, g, q, opts) {
  let text = await brainComplete(messages, env, opts);
  let v = verifyAnswer(text, g.live, q);
  if (v.ok) return { text, verified: true };
  const strict = addSystem(messages, "\n\nCORRECTION — your draft mentioned things that do not appear in the LIVE WEB CONTEXT above: " + v.unsupported.slice(0, 6).join(", ") +
    ". Rewrite the answer using ONLY names, dates and figures that appear in that context. If the context does not state the answer, say plainly that you could not confirm it. Never mention this correction.");
  try { text = await brainComplete(strict, env, opts); v = verifyAnswer(text, g.live, q); if (v.ok) return { text, verified: true }; } catch (_) {}
  return { text: fromSources(g.live), verified: false };
}
// Router-level grounding: when a query needs live facts, fetch the web and fold
// the results into the system message so every provider in the fallback chain
// reasons over the same fresh context. `ground` in the request body forces it on
// (true) or off (false, e.g. a client that already grounded itself); otherwise
// the router decides with serverNeedsWeb().
async function groundMessages(messages, body, env) {
  const q = String(body.query || "");
  messages = addSystem(messages, nowBlock(body.tz));
  const rb = refBlock(q);
  if (rb) return { messages: addSystem(messages, rb), grounded: true }; // a fixed list is read off the library, not the web
  const fb = futureBlock(q);
  if (fb) return { messages: addSystem(messages, fb), grounded: true }; // no search: there is nothing true to find
  // Exact-data tools first: clock, calendar/math (instant) and weather / exchange rates / crypto (live feeds).
  const live = await withTimeout(Promise.all([weatherBlock(q, body.tz), currencyBlock(q), cryptoBlock(q)]), 9000, []);
  const tools = [timeBlock(q, body.tz), calcBlock(q)].concat(live).filter(Boolean);
  if (tools.length) {
    messages = addSystem(messages, tools.join(""));
    // Web results would only add stale or conflicting numbers, so skip the search unless the question also needs it.
    if (!/\b(news|headline|happen|happened|stock|score|scores|president|prime minister|who is|who won)\b/i.test(q)) return { messages, grounded: true };
  }
  if (CLOCK_Q.test(q) && !CLOCK_NOT.test(q)) return { messages, grounded: true }; // the clock line above is the whole answer
  const office = officeAsk(q);
  const strength = liveStrength(q);
  const want = office || body.ground === true || (body.ground !== false && strength !== "no");
  if (!want || !q) return { messages, grounded: false };
  const queries = office ? [q.replace(/[?!.]+$/, "") + " " + new Date().getUTCFullYear()] : await withTimeout(planSearchQueries(q, env), 4000, [q]);
  const lists = await Promise.all(queries.map((x) => withTimeout(webSearch(x, env, strength === "must" || office), 9000, [])));
  const seen = new Set(), results = [];
  for (const list of lists) for (const r of list || []) { const k = r && (r.url || r.title); if (k && !seen.has(k)) { seen.add(k); results.push(r); } }
  if (office && !results.length) { // one more try, with the plain question, before giving up
    const again = await withTimeout(webSearch(q.replace(/[?!.]+$/, ""), env, true), 9000, []);
    for (const r of again || []) { const k = r && (r.url || r.title); if (k && !seen.has(k)) { seen.add(k); results.push(r); } }
    if (!results.length) return { messages, grounded: true, refuse: NO_OFFICE_ANSWER };
  }
  if (!results.length && strength === "must" && !office) return { messages, grounded: true, refuse: NO_LIVE_ANSWER };
  const top = results.slice(0, 8);
  const block = groundingBlock(top) || noLiveBlock();
  const out = messages.slice();
  const sysIdx = out.findIndex((m) => m.role === "system");
  if (sysIdx >= 0) out[sysIdx] = { role: "system", content: out[sysIdx].content + block };
  else out.unshift({ role: "system", content: block.trim() });
  return { messages: out, grounded: true, live: top.length ? { ctx: block, sources: top.map((r) => ({ title: r.title, url: r.url || "", snippet: r.snippet || "", date: r.date || r.pub || "" })) } : null };
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
// Every Groq model has its OWN free allowance, so a busy model is followed by the next one before any other provider
// is needed. The first is the strongest; the rest keep her answering when its allowance is spent.
const groqModels = (env) => [env.GROQ_MODEL || "openai/gpt-oss-120b", env.GROQ_FAST_MODEL || "openai/gpt-oss-20b"].filter((m, i, a) => a.indexOf(m) === i);
let _rot = 0;
function rotate(arr) { if (arr.length <= 1) return arr.slice(); const s = _rot++ % arr.length; return arr.slice(s).concat(arr.slice(0, s)); }
const groqKeys = (env) => parseKeys(env, "GROQ_API_KEYS", "GROQ_API_KEY");
const geminiKeys = (env) => parseKeys(env, "GEMINI_API_KEYS", "GEMINI_API_KEY", "GEMINI_API_KEY_NEW"); // accepts AIza… and newer AQ.… key formats
const openrouterKeys = (env) => parseKeys(env, "OPENROUTER_API_KEYS", "OPENROUTER_API_KEY");
// More free brains: each provider below has its own free allowance and is used only when its key is set.
// Models in the order tried: the strongest first; each has its own allowance on the account.
const mistralModels = (env) => [env.MISTRAL_MODEL || "mistral-large-2512", "mistral-small-2603", "ministral-14b-2512"].filter((m, i, a) => a.indexOf(m) === i);
const mistralKeys = (env) => parseKeys(env, "MISTRAL_API_KEYS", "MISTRAL_API_KEY");
const cerebrasKeys = (env) => parseKeys(env, "CEREBRAS_API_KEYS", "CEREBRAS_API_KEY");
const brainConfigured = (env) => groqKeys(env).length || mistralKeys(env).length || cerebrasKeys(env).length || geminiKeys(env).length || openrouterKeys(env).length || !!env.AI;

// Shared OpenAI-compatible completion (Groq + OpenRouter). gpt-oss models spend
// tokens on internal reasoning, so the budget is generous; answer is in content.
let _lastUsage = null;
async function openaiCompatible(url, key, models, messages, opts, extraHeaders) {
  let lastErr = "";
  for (const model of models) {
    const r = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", Authorization: "Bearer " + key }, extraHeaders || {}),
      body: JSON.stringify({ model, messages, max_tokens: opts.maxTokens ?? 8000, temperature: opts.temperature ?? 0.4, stream: false }),
      signal: AbortSignal.timeout(20000), // a provider that stalls is skipped, never waited on
    });
    if (r.ok) {
      const d = await r.json();
      _lastUsage = d.usage || null; // read only by the diagnostic flag on /brain/ask
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
  // Each Gemini model has its own free allowance, so when one is used up the next is tried before giving up on Gemini.
  const models = [opts.geminiModel || env.GEMINI_MODEL || "gemini-2.5-flash", env.GEMINI_FALLBACK_MODEL || "gemini-2.5-flash-lite"].filter((m, i, a) => a.indexOf(m) === i);
  const system = (messages.find((m) => m.role === "system") || {}).content || "";
  const contents = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  let lastErr = "";
  for (const model of models) {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + key, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_instruction: system ? { parts: [{ text: system }] } : undefined, contents, generationConfig: { maxOutputTokens: opts.maxTokens ?? 8000, temperature: opts.temperature ?? 0.4 } }),
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) {
      const d = await r.json();
      const text = ((d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts && d.candidates[0].content.parts[0] && d.candidates[0].content.parts[0].text) || "").trim();
      if (text) return text;
      lastErr = model + ": empty"; continue;
    }
    lastErr = "gemini " + model + " " + r.status + ": " + (await r.text()).replace(/\s+/g, " ").slice(0, 120);
    if (r.status === 429 || r.status === 404 || r.status >= 500) continue;
    break;
  }
  throw new Error(lastErr || "gemini: no model");
}
// A model that has lost its thread starts repeating itself or arguing with its own list. That is never shown to a
// user: such an answer counts as a failed attempt and the next provider is tried.
function isDegenerate(text) {
  const t = String(text || "");
  if (t.length < 400) return false;
  const seen = {};
  for (const raw of t.split("\n")) {
    const l = raw.toLowerCase().replace(/^[\s>*#\-|\d.)]+/, "").replace(/[*_`|]/g, "").trim();
    if (l.length < 6) continue;
    if ((seen[l] = (seen[l] || 0) + 1) >= 4) return true;
  }
  if ((t.match(/\((?:again|duplicate)[^)]{0,40}\)/gi) || []).length >= 3) return true;
  return (t.match(/let'?s (?:correct|restructure|adjust|choose|pick|use)/gi) || []).length >= 3;
}
// Cloudflare Workers AI: runs inside Cloudflare on the free daily allowance, through the project's "AI" binding
// (Pages → Settings → Bindings → Workers AI, variable name AI). Used only if that binding exists.
const CF_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"];
async function cfAiComplete(env, messages, opts) {
  let lastErr = "";
  for (const model of CF_MODELS) {
    try {
      const out = await Promise.race([
        env.AI.run(model, { messages, max_tokens: Math.min(opts.maxTokens ?? 2000, 2500), temperature: opts.temperature ?? 0.4 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
      ]);
      const text = String((out && (out.response || (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content))) || "").trim();
      if (text) return text;
      lastErr = model + ": empty";
    } catch (e) { lastErr = model + ": " + String((e && e.message) || e).slice(0, 100); }
  }
  throw new Error("cloudflare " + lastErr);
}
// Task-based routing: deep queries (analysis/coding/math/reasoning) go to the
// strongest models with a big budget; everyday chat goes to fast, low-latency models.
async function brainComplete(messages, env, opts = {}) {
  const attempts = [];
  const gm = opts.deep
    ? groqModels(env)
    : [env.GROQ_FAST_MODEL || "openai/gpt-oss-20b"].concat(groqModels(env)).filter((m, i, a) => a.indexOf(m) === i);
  // Note: Gemini Pro models are quota-gated on the free tier, so we use flash for
  // both modes (env-overridable). Deep-mode strength comes from Groq gpt-oss-120b + budget.
  const gemOpts = Object.assign({}, opts, { geminiModel: opts.deep ? (env.GEMINI_DEEP_MODEL || "gemini-2.5-flash") : (env.GEMINI_MODEL || "gemini-2.5-flash") });
  for (const key of rotate(groqKeys(env))) attempts.push({ name: "groq", fn: () => openaiCompatible("https://api.groq.com/openai/v1/chat/completions", key, gm, messages, opts) });
  for (const key of rotate(mistralKeys(env)).slice(0, 3)) attempts.push({ name: "mistral", fn: () => openaiCompatible("https://api.mistral.ai/v1/chat/completions", key, mistralModels(env), messages, opts) });
  // Cerebras answers 402 (payment required) for these keys, so it stays out of the chain until CEREBRAS_ENABLED=1 is set.
  if (env.CEREBRAS_ENABLED === "1") for (const key of rotate(cerebrasKeys(env)).slice(0, 2)) attempts.push({ name: "cerebras", fn: () => openaiCompatible("https://api.cerebras.ai/v1/chat/completions", key, [env.CEREBRAS_MODEL || "gpt-oss-120b", "llama-3.3-70b"], messages, opts) });
  for (const key of rotate(geminiKeys(env)).slice(0, 3)) attempts.push({ name: "gemini", fn: () => geminiComplete(key, env, messages, gemOpts) });
  const om = [env.OPENROUTER_MODEL || "qwen/qwen3.8-27b:free", env.OPENROUTER_FALLBACK_MODEL || "z-ai/glm-5.2:free"];
  for (const key of rotate(openrouterKeys(env)).slice(0, 2)) attempts.push({ name: "openrouter", fn: () => openaiCompatible("https://openrouter.ai/api/v1/chat/completions", key, om, messages, opts, { "HTTP-Referer": "https://noria.skyglobegroup.com", "X-Title": "Noria" }) });
  if (env.AI) attempts.push({ name: "cloudflare", fn: () => cfAiComplete(env, messages, opts) });
  if (!attempts.length) throw new Error("no model key configured");
  const errs = [];
  for (const a of attempts) { try { const t = await a.fn(); if (t && isDegenerate(t)) { errs.push(a.name + ": rambling answer discarded"); continue; } if (t) return t; errs.push(a.name + ": empty"); } catch (e) { errs.push(a.name + ": " + e.message); } }
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

    // ── Site icons for the "Sources" chips. Fetched here (not by the visitor's browser) so the icon service
    // never sees visitors' addresses, and so an unknown site is a clean 404 — the service answers those with a
    // grey placeholder picture that a browser would otherwise show. Cached for a day.
    if (path === "/favicon" && request.method === "GET") {
      const host = (url.searchParams.get("host") || "").toLowerCase();
      if (!/^[a-z0-9]([a-z0-9.-]{1,78})[a-z0-9]$/.test(host) || !host.includes(".")) return new Response(null, { status: 400 });
      try {
        const r = await fetch("https://icons.duckduckgo.com/ip3/" + host + ".ico", { headers: { "User-Agent": UA }, cf: { cacheTtl: 86400, cacheEverything: true } });
        const ct = r.headers.get("content-type") || "";
        if (!r.ok || !/^image\//i.test(ct)) return new Response(null, { status: 404, headers: { "Cache-Control": "public, max-age=86400" } });
        return new Response(r.body, { headers: { "Content-Type": ct, "Cache-Control": "public, max-age=604800" } });
      } catch (_) { return new Response(null, { status: 404 }); }
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
      const refAns = refDirect(body.query) || mathDirect(body.query);
      if (refAns) return new Response(JSON.stringify({ answer: refAns }), { headers: JSON_H });
      const g = await groundMessages(messages, body, env);
      if (g.refuse) return new Response(JSON.stringify({ answer: g.refuse }), { headers: JSON_H });
      messages = g.messages;
      const q = String(body.query || "");
      const deep = /\b(analy[sz]e|analysis|calculat|comput|code|coding|program|debug|architect|design|solve|prove|deriv|optimi[sz]|algorithm|reason|strateg|framework|evaluat|equation|integral|theorem|compare|business plan|roadmap|proposal|cv|résumé|resume|cover letter|itinerary|report)\b/i.test(q) || q.length > 420;
      // Grounded (live-data) answers run cooler to curb fabrication; free chat stays warm.
      const temperature = g.grounded ? 0.2 : (typeof body.temperature === "number" ? body.temperature : 0.4);
      try {
        if (g.live) { // a question answered from live sources: verified against them before it is shown
          let r;
          try { r = await liveAnswer(messages, env, g, q, { deep, maxTokens: deep ? 8000 : 2600, temperature: Math.min(temperature, 0.2) }); }
          catch (_) { r = { text: fromSources(g.live), verified: false }; } // the brain is down: the sources themselves still answer
          return new Response(JSON.stringify({ answer: r.text, sources: g.live.sources, verified: r.verified }), { headers: JSON_H });
        }
        const text = await brainComplete(messages, env, { deep, maxTokens: deep ? 8000 : 2600, temperature });
        return new Response(JSON.stringify(body.debug ? { answer: text, usage: _lastUsage } : { answer: text }), { headers: JSON_H });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 503, headers: JSON_H });
      }
    }

    // ── Brain: streaming (SSE) — translate Groq deltas to the app's {token}/{done} ──
    if (path === "/brain/ask/stream" && request.method === "POST") {
      let body; try { body = await request.json(); } catch (_) { body = {}; }
      const refAns = refDirect(body.query) || mathDirect(body.query);
      if (refAns) return new Response(`data: ${JSON.stringify({ token: refAns })}

data: ${JSON.stringify({ done: true })}

`, { headers: SSE_H });
      let messages = buildMessages(body);
      const gr = await groundMessages(messages, body, env);
      if (gr.refuse) return new Response(`data: ${JSON.stringify({ token: gr.refuse })}\n\ndata: ${JSON.stringify({ done: true })}\n\n`, { headers: SSE_H });
      messages = gr.messages;
      if (gr.live) { // live-grounded: the whole answer is verified against the sources first, then sent (with the sources)
        let r;
        try { r = await liveAnswer(messages, env, gr, String(body.query || ""), { deep: false, maxTokens: body.voice ? 600 : 3000, temperature: 0.2 }); }
        catch (_) { r = { text: fromSources(gr.live), verified: false }; }
        return new Response(`data: ${JSON.stringify({ token: r.text })}\n\ndata: ${JSON.stringify({ done: true, sources: gr.live.sources, verified: r.verified })}\n\n`, { headers: SSE_H });
      }
      const gkeys = rotate(groqKeys(env));
      if (!gkeys.length) return new Response(`data: ${JSON.stringify({ error: "no brain key" })}\n\n`, { status: 502, headers: SSE_H });
      // Rotate across Groq keys until one accepts the stream (skips a rate-limited key).
      let up = null, lastErr = "";
      // A SPOKEN turn (body.voice) is a short back-and-forth, so the same strong model is asked to think
      // briefly (reasoning_effort "low") and answer briefly — the first words arrive much sooner. If Groq
      // rejects that setting the request is simply repeated the normal way, so it can never fail because of it.
      const cfgs = body.voice ? [{ effort: "low", max: 600 }, { effort: null, max: 600 }] : [{ effort: null, max: 8000 }];
      outer:
      for (const key of gkeys) {
        for (const model of groqModels(env)) {
          for (const cfg of cfgs) {
            try {
              const payload = { model, messages, max_tokens: cfg.max, temperature: 0.4, stream: true };
              if (cfg.effort && /gpt-oss/.test(model)) payload.reasoning_effort = cfg.effort;
              const r = await fetch(GROQ_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
                body: JSON.stringify(payload),
              });
              if (r.ok) { up = r; break outer; }
              lastErr = "groq " + model + " " + r.status; try { await r.body.cancel(); } catch (_) {}
              if (r.status === 429 || r.status === 413 || r.status === 404 || r.status >= 500) break; // this model is limited/unwell — try the next model
            } catch (e) { lastErr = e.message; break; }
          }
        }
      }
      if (!up) {
        // Groq is busy: Mistral's strongest model answers next, STREAMED, so the first words still appear within a moment.
        for (const key of rotate(mistralKeys(env)).slice(0, 2)) {
          for (const model of mistralModels(env).slice(0, 2)) {
            try {
              const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
                method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
                body: JSON.stringify({ model, messages, max_tokens: body.voice ? 600 : 3000, temperature: 0.4, stream: true }),
                signal: AbortSignal.timeout(12000),
              });
              if (r.ok) { up = r; break; }
              try { await r.body.cancel(); } catch (_) {}
              if (r.status !== 429 && r.status !== 404 && r.status < 500) break;
            } catch (_) { break; }
          }
          if (up) break;
        }
      }
      if (!up) {
        // Groq is busy or limited: answer through the other providers right here, so the person gets a clean reply now
        // (one request) instead of an error followed by a second, slower attempt.
        try {
          const text = await brainComplete(messages, env, { deep: false, maxTokens: body.voice ? 600 : 2600, temperature: 0.4 });
          return new Response(`data: ${JSON.stringify({ token: text })}

data: ${JSON.stringify({ done: true })}

`, { headers: SSE_H });
        } catch (_) {}
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
    // ── Which models the brain provider currently offers (names only) — so the fallback chain can be kept valid ──
    if (path === "/brain/models") {
      const k = groqKeys(env)[0];
      if (!k) return new Response(JSON.stringify({ error: "no key" }), { status: 503, headers: JSON_H });
      const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: "Bearer " + k }, signal: AbortSignal.timeout(8000) }).catch(() => null);
      const d = r && r.ok ? await r.json().catch(() => null) : null;
      return new Response(JSON.stringify({ models: d && d.data ? d.data.map((m) => m.id).sort() : null, chain: groqModels(env) }), { headers: JSON_H });
    }
    // ── Which live news feeds answer from here? (a check for the retrieval engine; names, counts and timings only) ──
    if (path === "/brain/feeds") {
      const rows = await Promise.all(NEWS_FEEDS.map(async (u) => {
        const t = Date.now();
        const items = await fetchFeed(u);
        const newest = items.reduce((m, x) => Math.max(m, x.ts || 0), 0);
        return { feed: u.replace(/^https?:\/\//, "").slice(0, 60), items: items.length, ms: Date.now() - t, newest: newest ? new Date(newest).toISOString().slice(0, 10) : "" };
      }));
      return new Response(JSON.stringify({ feeds: rows }), { headers: JSON_H });
    }
    // ── Retrieval check: what the engine would hand the model for a question (no model is called) ──
    if (path === "/brain/retrieve") {
      const q = (url.searchParams.get("q") || "").trim();
      if (!q) return new Response(JSON.stringify({ error: "no query" }), { status: 400, headers: JSON_H });
      const t = Date.now();
      const strength = liveStrength(q);
      const res = strength === "no" ? [] : await withTimeout(webSearch(q, env, true), 9000, []);
      return new Response(JSON.stringify({ query: q, strength, ms: Date.now() - t, results: res.slice(0, 8).map((r) => ({ title: r.title, date: r.date || r.pub || "", url: r.url || "", snippet: (r.snippet || "").slice(0, 140) })) }), { headers: JSON_H });
    }
    // ── Does each brain provider actually answer? One tiny request each (about 10 tokens) — reports status only, never a key ──
    // ── Does Gemini's image model answer on the free keys? One call per model, reports status and size only ──
    if (path === "/brain/imgcheck") {
      const k = geminiKeys(env)[0];
      if (!k) return new Response(JSON.stringify({ error: "no gemini key" }), { headers: JSON_H });
      const out = [];
      for (const model of ["gemini-2.5-flash-image", "gemini-2.0-flash-preview-image-generation"]) {
        const t = Date.now();
        try {
          const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + k, {
            method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(40000),
            body: JSON.stringify({ contents: [{ parts: [{ text: "A candid documentary photograph of a busy street market in Accra, Ghana at midday" }] }], generationConfig: { responseModalities: ["IMAGE", "TEXT"] } }),
          });
          const txt = await r.text();
          let img = 0; try { const d = JSON.parse(txt); for (const p of ((d.candidates || [])[0] || {}).content ? d.candidates[0].content.parts : []) if (p.inlineData) img = p.inlineData.data.length; } catch (_) {}
          out.push({ model, status: r.status, imageBase64Chars: img, ms: Date.now() - t, error: r.ok ? undefined : txt.replace(/\s+/g, " ").slice(0, 180) });
        } catch (e) { out.push({ model, status: "error", ms: Date.now() - t, error: String(e.message || e).slice(0, 120) }); }
      }
      return new Response(JSON.stringify({ results: out }), { headers: JSON_H });
    }
    if (path === "/brain/providers" && url.searchParams.get("cerebras")) {
      // Which Cerebras models can these keys use? List them, then try each with one tiny request (status only).
      const k = cerebrasKeys(env)[0];
      if (!k) return new Response(JSON.stringify({ error: "no cerebras key" }), { headers: JSON_H });
      const lr = await fetch("https://api.cerebras.ai/v1/models", { headers: { Authorization: "Bearer " + k }, signal: AbortSignal.timeout(8000) }).catch(() => null);
      const ld = lr && lr.ok ? await lr.json().catch(() => null) : null;
      const ids = ld && ld.data ? ld.data.map((m) => m.id) : [];
      const res = [];
      for (const id of ids.slice(0, 10)) {
        const r = await fetch("https://api.cerebras.ai/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + k }, body: JSON.stringify({ model: id, messages: [{ role: "user", content: "Reply with the single word: ok" }], max_tokens: 40 }), signal: AbortSignal.timeout(10000) }).catch(() => null);
        res.push({ model: id, status: r ? r.status : "no-response" });
      }
      return new Response(JSON.stringify({ listed: ids.length, tried: res }), { headers: JSON_H });
    }
    if (path === "/brain/providers") {
      const ping = async (name, fn) => { const t = Date.now(); try { const r = await fn(); return { name, ok: !!r, ms: Date.now() - t }; } catch (e) { return { name, ok: false, ms: Date.now() - t, error: String(e.message || e).replace(/\s+/g, " ").slice(0, 110) }; } };
      const m = [{ role: "user", content: "Reply with the single word: ok" }], o = { maxTokens: 40, temperature: 0 };
      const jobs = [];
      const g = groqKeys(env)[0]; if (g) jobs.push(ping("groq", () => openaiCompatible("https://api.groq.com/openai/v1/chat/completions", g, groqModels(env), m, o)));
      const mi = mistralKeys(env); if (url.searchParams.get("all")) mi.forEach((k, i) => jobs.push(ping("mistral key " + (i + 1), () => openaiCompatible("https://api.mistral.ai/v1/chat/completions", k, mistralModels(env), m, o)))); else if (mi.length) jobs.push(ping("mistral (key 1 of " + mi.length + ")", () => openaiCompatible("https://api.mistral.ai/v1/chat/completions", mi[0], mistralModels(env), m, o)));
      const ce = cerebrasKeys(env); if (ce.length) jobs.push(ping("cerebras (key 1 of " + ce.length + ")", () => openaiCompatible("https://api.cerebras.ai/v1/chat/completions", ce[0], [env.CEREBRAS_MODEL || "gpt-oss-120b", "llama-3.3-70b"], m, o)));
      const ge = geminiKeys(env)[0]; if (ge) jobs.push(ping("gemini", () => geminiComplete(ge, env, m, o)));
      const orK = openrouterKeys(env)[0];
      if (orK) jobs.push(ping("openrouter", () => openaiCompatible("https://openrouter.ai/api/v1/chat/completions", orK, [env.OPENROUTER_MODEL || "qwen/qwen3.8-27b:free", env.OPENROUTER_FALLBACK_MODEL || "z-ai/glm-5.2:free"], m, o, { "HTTP-Referer": "https://noria.africa", "X-Title": "Noria" })));
      if (env.AI) jobs.push(ping("cloudflare workers ai", () => cfAiComplete(env, m, o)));
      else jobs.push(Promise.resolve({ name: "cloudflare workers ai", ok: false, ms: 0, error: "no AI binding on this project yet" }));
      return new Response(JSON.stringify({ providers: await Promise.all(jobs) }), { headers: JSON_H });
    }
    // ── Health ── (reports how many keys per provider are configured)
    if (path === "/brain/health") {
      const g = groqKeys(env).length, gm = geminiKeys(env).length, o = openrouterKeys(env).length;
      const ok = g || gm || o;
      return new Response(JSON.stringify({ status: ok ? "ok" : "no-key", keys: { cloudflareAI: !!env.AI, groq: g, mistral: mistralKeys(env).length, cerebras: cerebrasKeys(env).length, gemini: gm, openrouter: o } }), { headers: JSON_H });
    }

    // ── Static assets, served by Cloudflare Pages ──
    // Front door = the workspace (served in place at "/", no redirect). Pages serves
    // workspace.html at the clean path "/workspace", so we fetch that for "/".
    // "See Noria" (the figure page) is the site's index.html, which the host would otherwise redirect to "/"
    // (the chat). Serve it explicitly at /figure, and let the old /index.html address reach it too.
    const assetPath = path === "/" ? "/workspace" : (path === "/figure" || path === "/index.html") ? "/" : path;
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
