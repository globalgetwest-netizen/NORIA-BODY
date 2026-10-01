// NORIA OFFICEHOLDER LOOKUP — Wikidata's own structured data, not a third-party aggregator or a text summary.
//
// FOUND LIVE 2026-10-01: even after fixing the query that finds the right Wikipedia article for an office-ask
// question ("who is the current president of X"), Wikipedia's own REST summary API returns only the generic
// institutional definition of the office ("The president of the United States (POTUS) is the head of state...")
// — the actual incumbent's name lives in the page's infobox, structured data that a plain-text extract does not
// carry. Explicitly requested by the owner: a real, non-third-party source for exactly this fact. Wikidata (the
// Wikimedia Foundation's own structured-data project, free, keyless, official) carries it directly:
//
//   1. The Wikipedia article already found (e.g. "President of the United States") has an associated Wikidata
//      item (its "wikibase_item" page property).
//   2. That item's P1308 ("officeholder") claim names the item for the CURRENT holder of the office. A claim with
//      a P582 ("end time") qualifier is a former holder; the current one has no end time.
//   3. The holder's own Wikidata item is resolved to a plain name — tried via its English label first, falling
//      back to its English Wikipedia sitelink title, since a label can be missing even for a very prominent
//      person (confirmed live: Q22686's "en" label was empty; its enwiki sitelink title, "Donald Trump", was not).
//
// This is read-only, deterministic given Wikidata's current state, and every fact returned carries its own
// Wikidata and Wikipedia URLs as real, checkable sources — never asserted without them.

const UA = "NoriaBody/1.0 (+https://noria.africa; officeholder lookup)";

async function wdGet(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Api-User-Agent": UA }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) return null;
  try { return await r.json(); } catch (_) { return null; }
}

async function wikidataItemFor(title) {
  const pp = await wdGet("https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&titles=" + encodeURIComponent(title) + "&ppprop=wikibase_item&format=json");
  const pages = pp && pp.query && pp.query.pages, page = pages && Object.values(pages)[0];
  return (page && page.pageprops && page.pageprops.wikibase_item) || null;
}
// Resolves a Wikidata item id to a plain name: English label first, falling back to the English Wikipedia sitelink
// title, since a label can be missing even for a very prominent entity (confirmed live: Q22686, Donald Trump's own
// item, had an empty "en" label; its enwiki sitelink title did not).
async function resolveEntityName(qid) {
  const ent = await wdGet("https://www.wikidata.org/w/api.php?action=wbgetentities&ids=" + qid + "&props=labels%7Csitelinks&languages=en&sitefilter=enwiki&format=json");
  const e = ent && ent.entities && ent.entities[qid];
  if (!e) return null;
  const name = (e.labels && e.labels.en && e.labels.en.value) || (e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title);
  if (!name) return null;
  const wikipediaTitle = (e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title) || name;
  return { name, wikipediaUrl: "https://en.wikipedia.org/wiki/" + encodeURIComponent(wikipediaTitle.replace(/ /g, "_")) };
}

// title: an English Wikipedia article title (e.g. "President of the United States"), as already found by wikiSearch.
// Returns { name, wikidataUrl, wikipediaUrl, since } or null if this office/claim cannot be resolved this way —
// callers must fall back to the existing search-based path on null, never treat it as "office is vacant".
export async function officeholderLookup(title) {
  try {
    const qid = await wikidataItemFor(title);
    if (!qid) return null;
    const claims = await wdGet("https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=" + qid + "&property=P1308&format=json");
    const p1308 = claims && claims.claims && claims.claims.P1308;
    if (!p1308 || !p1308.length) return null;
    // Wikidata's own "rank" field, not the presence/absence of a P582 (end time) qualifier, is the authoritative
    // signal for which claim is current: found live that a fixed-term office's CURRENT holder can still carry a
    // P582 (e.g. a scheduled or expected end of term), so "no end time" alone wrongly excluded the real, correctly
    // rank:"preferred" current claim for "President of the United States" and returned null instead. Wikidata's
    // own convention is that at most one statement per property is marked rank:"preferred" when more than one
    // exists, specifically to mark the best/current value; fall back to "no P582" only for offices where no claim
    // has been explicitly marked preferred.
    const current = p1308.find((c) => c.rank === "preferred") || p1308.find((c) => !(c.qualifiers && c.qualifiers.P582)) || null;
    if (!current || current.mainsnak.snaktype !== "value") return null;
    const holderQid = current.mainsnak.datavalue.value.id;
    const since = current.qualifiers && current.qualifiers.P580 && current.qualifiers.P580[0] && current.qualifiers.P580[0].datavalue && current.qualifiers.P580[0].datavalue.value && current.qualifiers.P580[0].datavalue.value.time;
    const resolved = await resolveEntityName(holderQid);
    if (!resolved) return null;
    return {
      name: resolved.name,
      since: since ? String(since).slice(1, 11) : null, // Wikidata time values are "+YYYY-MM-DDT...": strip the leading sign
      wikidataUrl: "https://www.wikidata.org/wiki/" + holderQid,
      wikipediaUrl: resolved.wikipediaUrl,
    };
  } catch (_) { return null; }
}

// NORIA RECURRING-EVENT WINNER LOOKUP — same real-source principle as officeholderLookup, for "who won the last
// X" (a World Cup, an election, a championship) instead of "who currently holds office X".
//
// FOUND LIVE 2026-10-01: "who won the last FIFA World Cup" fails for a DIFFERENT reason than the officeholder bug
// — Wikipedia's own full-text search ranks the tournament's many sub-pages (a group stage, the knockout bracket,
// the squads list) above the single main tournament article, even with the query already cleaned, because the
// sub-pages mention "FIFA World Cup" just as densely. The main article ("2026 FIFA World Cup") itself carries a
// clean P1346 ("winner") claim pointing to the actual winning team/person — confirmed live (Q5020214 -> Q42267,
// "Spain national football team") — the search ranking is the only obstacle, not the data.
//
// Rather than trying every ranked hit in turn (an officeholder's office article is unique; a tournament's OWN main
// article competes directly against its own, near-identical-looking sub-pages, so "try the next hit" risks landing
// on a sub-page that happens to carry some unrelated claim), the main article's title is reconstructed directly:
// most of a recurring event's sub-pages share one obvious "YYYY <Event Name>" prefix (confirmed live: 7 of 8
// year-prefixed hits for the FIFA World Cup query shared the 4-word prefix "2026 FIFA World Cup"). The DOMINANT
// year among the hits is found first — this is what keeps a same-week but UNRELATED competition (confirmed live:
// "2027 FIFA Women's World Cup", a real hit for the identical search, is a different year and a different
// competition entirely) from ever being treated as a match: it is outnumbered by the real edition's own sub-pages
// and is correctly never counted as part of the majority group.
// FOUND LIVE 2026-10-01, in a capability battery re-run once Tavily's search quota recovered: "who won the most
// recent US presidential election" surfaced a confusing mix including "2028 United States presidential election" —
// a real hit, but a SCHEDULED FUTURE election that by definition has no winner yet — alongside several 2020 hits,
// with zero 2024 hits in the actual search results. Two related fixes: (1) a future-dated edition (year greater
// than the real current year) can never be the answer to a "who WON" question and is now excluded from candidacy
// entirely, regardless of how many sub-pages it has; (2) selection switched from "the year with the MOST
// corroborating hits" to "the MOST RECENT year that still has at least two corroborating hits" — "most hits" suits
// a single sports tournament (one edition generates dozens of sub-pages, vastly outnumbering any other year's
// mention, the original FIFA World Cup case this function was built for), but is a noisy signal for an event type
// like an election where each year typically has only a handful of pages; "most recent, sufficiently corroborated"
// more directly matches what "most recent/last X" actually asks for, in both cases. The >=2-corroborating-hits
// safety requirement is unchanged: a lone, unconfirmed year is still never treated as a match.
function dominantEventTitle(hits) {
  const yearStart = /^(\d{4})\s+(.+)$/;
  const currentYear = new Date().getUTCFullYear();
  const byYear = new Map(); // year -> [ [word,word,...], ... ]
  for (const h of hits || []) {
    if (/^list of\b/i.test(h.title)) continue;
    const m = yearStart.exec(h.title);
    if (!m) continue;
    if (Number(m[1]) > currentYear) continue; // a scheduled future edition cannot have a winner yet
    const words = h.title.split(/\s+/);
    if (!byYear.has(m[1])) byYear.set(m[1], []);
    byYear.get(m[1]).push(words);
  }
  let bestYear = null, bestGroup = null;
  for (const [year, group] of byYear) {
    if (group.length < 2) continue; // need at least two sub-pages agreeing, never a lone, unconfirmed guess
    if (!bestYear || year > bestYear) { bestYear = year; bestGroup = group; }
  }
  if (!bestGroup) return null;
  let lcp = bestGroup[0];
  for (const words of bestGroup.slice(1)) {
    let i = 0; while (i < lcp.length && i < words.length && lcp[i].toLowerCase() === words[i].toLowerCase()) i++;
    lcp = lcp.slice(0, i);
  }
  return lcp.length >= 2 ? lcp.join(" ") : null; // at minimum "YYYY <Name>" — a bare year alone is not a usable title
}
// hits: the raw Wikipedia search-hit array for the event question. Returns { name, wikidataUrl, wikipediaUrl,
// eventTitle } or null — callers must fall back to the existing search-based path on null.
export async function eventWinnerLookup(hits) {
  try {
    const title = dominantEventTitle(hits);
    if (!title) return null;
    const qid = await wikidataItemFor(title);
    if (!qid) return null;
    const claims = await wdGet("https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=" + qid + "&property=P1346&format=json");
    const p1346 = claims && claims.claims && claims.claims.P1346;
    if (!p1346 || !p1346.length) return null;
    const claim = p1346.find((c) => c.mainsnak && c.mainsnak.snaktype === "value");
    if (!claim) return null;
    const winnerQid = claim.mainsnak.datavalue.value.id;
    const resolved = await resolveEntityName(winnerQid);
    if (!resolved) return null;
    return { name: resolved.name, eventTitle: title, wikidataUrl: "https://www.wikidata.org/wiki/" + winnerQid, wikipediaUrl: resolved.wikipediaUrl };
  } catch (_) { return null; }
}
