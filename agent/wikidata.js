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

// title: an English Wikipedia article title (e.g. "President of the United States"), as already found by wikiSearch.
// Returns { name, wikidataUrl, wikipediaUrl, since } or null if this office/claim cannot be resolved this way —
// callers must fall back to the existing search-based path on null, never treat it as "office is vacant".
export async function officeholderLookup(title) {
  try {
    const pp = await wdGet("https://en.wikipedia.org/w/api.php?action=query&prop=pageprops&titles=" + encodeURIComponent(title) + "&ppprop=wikibase_item&format=json");
    const pages = pp && pp.query && pp.query.pages, page = pages && Object.values(pages)[0];
    const qid = page && page.pageprops && page.pageprops.wikibase_item;
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
    const ent = await wdGet("https://www.wikidata.org/w/api.php?action=wbgetentities&ids=" + holderQid + "&props=labels%7Csitelinks&languages=en&sitefilter=enwiki&format=json");
    const e = ent && ent.entities && ent.entities[holderQid];
    if (!e) return null;
    const name = (e.labels && e.labels.en && e.labels.en.value) || (e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title);
    if (!name) return null;
    const wikipediaTitle = (e.sitelinks && e.sitelinks.enwiki && e.sitelinks.enwiki.title) || name;
    return {
      name,
      since: since ? String(since).slice(1, 11) : null, // Wikidata time values are "+YYYY-MM-DDT...": strip the leading sign
      wikidataUrl: "https://www.wikidata.org/wiki/" + holderQid,
      wikipediaUrl: "https://en.wikipedia.org/wiki/" + encodeURIComponent(wikipediaTitle.replace(/ /g, "_")),
    };
  } catch (_) { return null; }
}
