// NORIA REALITY FEEDS — real data sources, asked in parallel, each answer wrapped in a data passport and resolved into ONE verdict.
// Nothing here imports the network: the caller passes `jget(url, ms)` (returns parsed JSON or null), so the same code runs in the Worker and in tests.
//
//   fx      three independent feeds (an ECB reference, two rate aggregators)  -> daily reference rate
//   crypto  four exchanges and an aggregator, all asked, none "first wins"     -> live spot price
//   weather an official meteorological service and a weather model             -> current temperature
//
// A tool built on these returns a value ONLY when the verdict allows it; otherwise it fails with the verdict's plain statement (the no-answer state).

import { makePassport, resolveFacts, evidenceGraph } from "./reality.js";

const num = (x) => { const n = typeof x === "string" ? parseFloat(x) : x; return typeof n === "number" && isFinite(n) ? n : null; };
const ms = (iso) => { const t = Date.parse(iso); return isFinite(t) ? t : null; };
// Each job is [sourceId, fn]. fn returns a passport, null (the source did not answer: recorded as asked-but-silent) or undefined (not asked at all).
const settle = async (jobs, blank) => (await Promise.all(jobs.map(async ([id, fn]) => { let r; try { r = await fn(); } catch (_) { r = null; } return r === undefined ? null : r || blank(id); }))).filter(Boolean);

// The currencies the European Central Bank publishes a reference rate for (Frankfurter). GHS is not among them: for those pairs the ECB is simply not asked.
const ECB = new Set("AUD BGN BRL CAD CHF CNY CZK DKK EUR GBP HKD HUF IDR ILS INR ISK JPY KRW MXN MYR NOK NZD PHP PLN RON SEK SGD THB TRY USD ZAR".split(" "));

export async function fxVerdict(from, to, { jget, now = Date.now() }) {
  from = String(from).toUpperCase(); to = String(to).toUpperCase();
  const mk = (source, rate, updated, extra = {}) => makePassport({ entity: from + "/" + to, attribute: "exchange rate", value: rate, unit: to + " per 1 " + from, source, domain: "fx", basis: "daily mid-market reference", source_updated_at: updated, retrieved_at: now, ...extra }, now);
  const facts = await settle([
    ["open-er-api", async () => { const j = await jget("https://open.er-api.com/v6/latest/" + from, 6000); const r = num(j && j.rates && j.rates[to]); return r ? mk("open-er-api", r, j.time_last_update_unix ? j.time_last_update_unix * 1000 : ms(j.time_last_update_utc)) : null; }],
    ["currency-api", async () => { const j = await jget("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/" + from.toLowerCase() + ".json", 6000); const r = num(j && j[from.toLowerCase()] && j[from.toLowerCase()][to.toLowerCase()]); return r ? mk("currency-api", r, j.date ? Date.parse(j.date + "T12:00:00Z") : null) : null; }], // a daily feed is dated by day: it is taken as published around midday of that day
    ["ecb", async () => { if (!ECB.has(from) || !ECB.has(to)) return undefined; const j = await jget("https://api.frankfurter.app/latest?from=" + from + "&to=" + to, 6000); const r = num(j && j.rates && j.rates[to]); return r ? mk("ecb", r, j.date ? Date.parse(j.date + "T15:00:00Z") : null) : null; }],
  ], (id) => mk(id, null, null));
  // rate feeds are daily: two published a day apart can differ by real movement, so the tolerance is wider than for a live price
  const verdict = resolveFacts(facts, { domain: "fx", tol: { rel: from === "USD" || to === "USD" || from === "EUR" || to === "EUR" ? 0.012 : 0.02 }, now, entity: from + "/" + to, attribute: "exchange rate", basis: "daily mid-market reference" });
  return finalise(verdict, from + " to " + to + " exchange rate", facts, { note: "Daily mid-market reference rate: not a live trading price, and banks and transfer services add a margin." });
}

const COINS = { bitcoin: ["BTC", "bitcoin", "Bitcoin"], btc: ["BTC", "bitcoin", "Bitcoin"], ethereum: ["ETH", "ethereum", "Ethereum"], eth: ["ETH", "ethereum", "Ethereum"], ether: ["ETH", "ethereum", "Ethereum"], solana: ["SOL", "solana", "Solana"], sol: ["SOL", "solana", "Solana"], xrp: ["XRP", "ripple", "XRP"], ripple: ["XRP", "ripple", "XRP"], cardano: ["ADA", "cardano", "Cardano"], ada: ["ADA", "cardano", "Cardano"], dogecoin: ["DOGE", "dogecoin", "Dogecoin"], doge: ["DOGE", "dogecoin", "Dogecoin"], litecoin: ["LTC", "litecoin", "Litecoin"], ltc: ["LTC", "litecoin", "Litecoin"], bnb: ["BNB", "binancecoin", "BNB"], tron: ["TRX", "tron", "TRON"], polkadot: ["DOT", "polkadot", "Polkadot"], avalanche: ["AVAX", "avalanche-2", "Avalanche"], chainlink: ["LINK", "chainlink", "Chainlink"], toncoin: ["TON", "the-open-network", "Toncoin"] };
export const coinOf = (asset) => COINS[String(asset || "").toLowerCase().trim()] || null;

export async function cryptoVerdict(asset, { jget, now = Date.now() }) {
  const coin = coinOf(asset); if (!coin) return null;
  const [sym, cg, label] = coin, kr = sym === "BTC" ? "XBT" : sym === "DOGE" ? "XDG" : sym;
  const mk = (source, price, updated, extra = {}) => makePassport({ entity: label, attribute: "price", value: price, unit: "USD", source, domain: "crypto", basis: "spot", source_updated_at: updated, retrieved_at: now, ...extra }, now);
  const facts = await settle([
    ["coinbase", async () => { const j = await jget("https://api.coinbase.com/v2/prices/" + sym + "-USD/spot", 5000); const p = num(j && j.data && j.data.amount); return p ? mk("coinbase", p, now) : null; }], // spot endpoints answer "now"; the moment of the answer is their timestamp
    ["kraken", async () => { const j = await jget("https://api.kraken.com/0/public/Ticker?pair=" + kr + "USD", 5000); const t = j && j.result && Object.values(j.result)[0]; const p = num(t && t.c && t.c[0]); return p ? mk("kraken", p, now) : null; }],
    ["binance", async () => { const j = await jget("https://api.binance.com/api/v3/ticker/price?symbol=" + sym + "USDT", 5000); const p = num(j && j.price); return p ? mk("binance", p, now) : null; }],
    ["coingecko", async () => { const j = await jget("https://api.coingecko.com/api/v3/simple/price?vs_currencies=usd&include_last_updated_at=true&ids=" + cg, 5000); const r = j && j[cg]; const p = num(r && r.usd); return p ? mk("coingecko", p, r.last_updated_at ? r.last_updated_at * 1000 : now) : null; }],
  ], (id) => mk(id, null, null));
  const verdict = resolveFacts(facts, { domain: "crypto", tol: { rel: 0.01 }, now, entity: label, attribute: "price", basis: "spot" });
  return finalise(verdict, label + " price in US dollars", facts, { note: "Spot price in US dollars, compared across exchanges at the moment of the request." });
}

// Two genuinely independent, keyless sources, checked live before building on them (2026-09-24):
// Stooq's old free CSV quote endpoint (/q/l/) now returns a 404 and its download endpoint is behind a
// JS bot-challenge — it is dead, not merely reformatted, so it is NOT used here despite being a common
// choice in older write-ups. Yahoo Finance's unofficial chart endpoint and NASDAQ's own public quote API
// both answered with real, current, independently-sourced last-trade prices for both a NASDAQ-listed
// (AAPL) and a NYSE-listed (IBM) ticker in the same live check, so those two are used instead.
export async function stockVerdict(ticker, { jget, now = Date.now() }) {
  const sym = String(ticker || "").toUpperCase().trim();
  if (!/^[A-Z]{1,6}$/.test(sym)) return null;
  const mk = (source, price, updated, extra = {}) => makePassport({ entity: sym, attribute: "price", value: price, unit: "USD", source, domain: "stock", basis: "last trade", source_updated_at: updated, retrieved_at: now, ...extra }, now);
  const facts = await settle([
    ["yahoo", async () => { const j = await jget("https://query1.finance.yahoo.com/v8/finance/chart/" + sym, 6000); const m = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta; const p = num(m && m.regularMarketPrice); return p ? mk("yahoo", p, m.regularMarketTime ? m.regularMarketTime * 1000 : now) : null; }],
    ["nasdaq", async () => { const j = await jget("https://api.nasdaq.com/api/quote/" + sym + "/info?assetclass=stocks", 6000); const d = j && j.data && j.data.primaryData; const p = num(d && String(d.lastSalePrice || "").replace(/[$,]/g, "")); return p ? mk("nasdaq", p, now) : null; }], // NASDAQ's timestamp is a formatted local-time string, not reliably machine-parseable: the moment of the request is used instead
  ], (id) => mk(id, null, null));
  const verdict = resolveFacts(facts, { domain: "stock", tol: { rel: 0.015 }, now, entity: sym, attribute: "price", basis: "last trade" });
  return finalise(verdict, sym + " stock price in US dollars", facts, { note: "Last-trade price in US dollars; outside trading hours this is the most recent session's close, not a currently-moving price." });
}

// A country's real, official, current statistics (population, GDP, life expectancy, literacy) — the exact
// class of fact that was being confidently fabricated (a $13.8bn GDP figure invented for Chad, labelled
// "World Bank estimate", when the real World Bank figure is $21.5bn). World Bank Open Data is free, needs
// no key, and covers every country with one figure per indicator — a single OFFICIAL source of record, the
// same standing already accepted for a single crypto exchange. The name->code table below was generated
// from World Bank's own live country list (2026-09-24), not typed from memory, then given the common
// aliases real people actually use (official statistical names often differ: "Egypt, Arab Rep.", "Congo,
// Dem. Rep.", "Korea, Rep." and so on).
const COUNTRY_ISO3_BASE = {"aruba":"ABW","afghanistan":"AFG","angola":"AGO","albania":"ALB","andorra":"AND","united arab emirates":"ARE","argentina":"ARG","armenia":"ARM","american samoa":"ASM","antigua and barbuda":"ATG","australia":"AUS","austria":"AUT","azerbaijan":"AZE","burundi":"BDI","belgium":"BEL","benin":"BEN","burkina faso":"BFA","bangladesh":"BGD","bulgaria":"BGR","bahrain":"BHR","bahamas, the":"BHS","bosnia and herzegovina":"BIH","belarus":"BLR","belize":"BLZ","bermuda":"BMU","bolivia":"BOL","brazil":"BRA","barbados":"BRB","brunei darussalam":"BRN","bhutan":"BTN","botswana":"BWA","central african republic":"CAF","canada":"CAN","switzerland":"CHE","channel islands":"CHI","chile":"CHL","china":"CHN","cote d'ivoire":"CIV","cameroon":"CMR","congo, dem. rep.":"COD","congo, rep.":"COG","colombia":"COL","comoros":"COM","cabo verde":"CPV","costa rica":"CRI","cuba":"CUB","curacao":"CUW","cayman islands":"CYM","cyprus":"CYP","czechia":"CZE","germany":"DEU","djibouti":"DJI","dominica":"DMA","denmark":"DNK","dominican republic":"DOM","algeria":"DZA","ecuador":"ECU","egypt, arab rep.":"EGY","eritrea":"ERI","spain":"ESP","estonia":"EST","ethiopia":"ETH","finland":"FIN","fiji":"FJI","france":"FRA","faroe islands":"FRO","micronesia, fed. sts.":"FSM","gabon":"GAB","united kingdom":"GBR","georgia":"GEO","ghana":"GHA","gibraltar":"GIB","guinea":"GIN","gambia, the":"GMB","guinea-bissau":"GNB","equatorial guinea":"GNQ","greece":"GRC","grenada":"GRD","greenland":"GRL","guatemala":"GTM","guam":"GUM","guyana":"GUY","hong kong sar, china":"HKG","honduras":"HND","croatia":"HRV","haiti":"HTI","hungary":"HUN","indonesia":"IDN","isle of man":"IMN","india":"IND","ireland":"IRL","iran, islamic rep.":"IRN","iraq":"IRQ","iceland":"ISL","israel":"ISR","italy":"ITA","jamaica":"JAM","jordan":"JOR","japan":"JPN","kazakhstan":"KAZ","kenya":"KEN","kyrgyz republic":"KGZ","cambodia":"KHM","kiribati":"KIR","st. kitts and nevis":"KNA","korea, rep.":"KOR","kuwait":"KWT","lao pdr":"LAO","lebanon":"LBN","liberia":"LBR","libya":"LBY","st. lucia":"LCA","liechtenstein":"LIE","sri lanka":"LKA","lesotho":"LSO","lithuania":"LTU","luxembourg":"LUX","latvia":"LVA","macao sar, china":"MAC","st. martin (french part)":"MAF","morocco":"MAR","monaco":"MCO","moldova":"MDA","madagascar":"MDG","maldives":"MDV","mexico":"MEX","marshall islands":"MHL","north macedonia":"MKD","mali":"MLI","malta":"MLT","myanmar":"MMR","montenegro":"MNE","mongolia":"MNG","northern mariana islands":"MNP","mozambique":"MOZ","mauritania":"MRT","mauritius":"MUS","malawi":"MWI","malaysia":"MYS","namibia":"NAM","new caledonia":"NCL","niger":"NER","nigeria":"NGA","nicaragua":"NIC","netherlands":"NLD","norway":"NOR","nepal":"NPL","naoero":"NRU","new zealand":"NZL","oman":"OMN","pakistan":"PAK","panama":"PAN","peru":"PER","philippines":"PHL","palau":"PLW","papua new guinea":"PNG","poland":"POL","puerto rico (us)":"PRI","korea, dem. people's rep.":"PRK","portugal":"PRT","paraguay":"PRY","west bank and gaza":"PSE","french polynesia":"PYF","qatar":"QAT","romania":"ROU","russian federation":"RUS","rwanda":"RWA","saudi arabia":"SAU","sudan":"SDN","senegal":"SEN","singapore":"SGP","solomon islands":"SLB","sierra leone":"SLE","el salvador":"SLV","san marino":"SMR","somalia, fed. rep.":"SOM","serbia":"SRB","south sudan":"SSD","sao tome and principe":"STP","suriname":"SUR","slovak republic":"SVK","slovenia":"SVN","sweden":"SWE","eswatini":"SWZ","sint maarten (dutch part)":"SXM","seychelles":"SYC","syrian arab republic":"SYR","turks and caicos islands":"TCA","chad":"TCD","togo":"TGO","thailand":"THA","tajikistan":"TJK","turkmenistan":"TKM","timor-leste":"TLS","tonga":"TON","trinidad and tobago":"TTO","tunisia":"TUN","turkiye":"TUR","tuvalu":"TUV","tanzania":"TZA","uganda":"UGA","ukraine":"UKR","uruguay":"URY","united states":"USA","uzbekistan":"UZB","st. vincent and the grenadines":"VCT","venezuela, rb":"VEN","british virgin islands":"VGB","virgin islands (u.s.)":"VIR","viet nam":"VNM","vanuatu":"VUT","samoa":"WSM","kosovo":"XKX","yemen, rep.":"YEM","south africa":"ZAF","zambia":"ZMB","zimbabwe":"ZWE"};
const COUNTRY_ALIASES = {"ivory coast":"CIV","democratic republic of congo":"COD","democratic republic of the congo":"COD","dr congo":"COD","drc":"COD","congo-kinshasa":"COD","republic of congo":"COG","congo-brazzaville":"COG","the gambia":"GMB","gambia":"GMB","the bahamas":"BHS","bahamas":"BHS","czech republic":"CZE","south korea":"KOR","korea":"KOR","north korea":"PRK","russia":"RUS","iran":"IRN","egypt":"EGY","syria":"SYR","venezuela":"VEN","vietnam":"VNM","laos":"LAO","brunei":"BRN","cape verde":"CPV","swaziland":"SWZ","myanmar (burma)":"MMR","burma":"MMR","turkey":"TUR","macedonia":"MKD","usa":"USA","america":"USA","united states of america":"USA","u.s.":"USA","u.s.a.":"USA","uk":"GBR","britain":"GBR","great britain":"GBR","u.k.":"GBR","uae":"ARE","somalia":"SOM","yemen":"YEM","kyrgyzstan":"KGZ","slovakia":"SVK","hong kong":"HKG","macau":"MAC","macao":"MAC","palestine":"PSE","palestinian territories":"PSE","micronesia":"FSM","nauru":"NRU","trinidad":"TTO","ivory coast (cote d'ivoire)":"CIV"};
export const COUNTRY_ISO3 = Object.assign({}, COUNTRY_ISO3_BASE, COUNTRY_ALIASES);
export function countryCodeOf(name) { return COUNTRY_ISO3[String(name || "").toLowerCase().trim()] || null; }

// Each indicator carries its OWN realistic reporting cadence, not one shared window: population/GDP are
// compiled annually, but literacy is measured by infrequent household surveys — World Bank's own live figure
// for Chad's literacy rate, checked 2026-09-24, was still dated 2019. A single "country_fact" window generous
// enough for GDP (a few years) would be too strict for literacy and wrongly withhold the actual best-available
// figure most of the time; a window generous enough for literacy would let genuinely outdated GDP data through
// as if current. Each indicator names its own domain (see FRESHNESS in reality.js) for exactly this reason.
const WB_INDICATORS = {
  population: { code: "SP.POP.TOTL", unit: "people", label: "population", domain: "country_fact" },
  gdp: { code: "NY.GDP.MKTP.CD", unit: "USD", label: "GDP (current US$)", domain: "country_fact" },
  gdp_per_capita: { code: "NY.GDP.PCAP.CD", unit: "USD", label: "GDP per capita (current US$)", domain: "country_fact" },
  life_expectancy: { code: "SP.DYN.LE00.IN", unit: "years", label: "life expectancy at birth", domain: "country_fact" },
  literacy_rate: { code: "SE.ADT.LITR.ZS", unit: "%", label: "adult literacy rate", domain: "country_fact_survey" },
};
export const COUNTRY_FACT_ATTRIBUTES = Object.keys(WB_INDICATORS);

export async function countryFactVerdict(country, attribute, { jget, now = Date.now() }) {
  const iso3 = countryCodeOf(country); if (!iso3) return null;
  const ind = WB_INDICATORS[attribute]; if (!ind) return null;
  const j = await jget("https://api.worldbank.org/v2/country/" + iso3 + "/indicator/" + ind.code + "?format=json&mrnev=1", 8000);
  const row = j && Array.isArray(j) && Array.isArray(j[1]) && j[1][0];
  const v = row ? num(row.value) : null;
  const name = (row && row.country && row.country.value) || country;
  const mk = (value, updated) => makePassport({ entity: name, attribute: ind.label, value, unit: ind.unit, source: "worldbank", domain: ind.domain, basis: "official statistic", source_updated_at: updated, retrieved_at: now }, now);
  // World Bank reports a bare year ("2025"), not a date: taken as mid-year, since the true within-year moment is not published.
  const fact = v != null ? mk(v, row.date ? Date.parse(row.date + "-06-30T00:00:00Z") : now) : mk(null, null);
  const verdict = resolveFacts([fact], { domain: ind.domain, now, entity: name, attribute: ind.label, basis: "official statistic" });
  return finalise(verdict, ind.label + " of " + name, [fact], { note: "Official World Bank statistic" + (row && row.date ? ", most recently reported for " + row.date : "") + (ind.domain === "country_fact_survey" ? "; measured by periodic household surveys, so the most recent figure can genuinely be several years old — that is the real reporting cadence, not stale data being overlooked." : "; national statistics are annual and can lag real time by a year or more.") });
}

export async function weatherVerdict(place, { jget, now = Date.now() }) {
  // `place` may be a name to geocode, or an already-resolved { name, latitude, longitude, country }
  // so a caller that geocoded once reuses the exact coordinates — no second lookup, no ambiguity,
  // no geocoder 404. Backward compatible: a string still geocodes.
  let loc;
  if (place && typeof place === "object" && place.latitude != null && place.longitude != null) {
    loc = { name: place.name || "the location", latitude: place.latitude, longitude: place.longitude, country: place.country || "" };
  } else {
    const g = await jget("https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=" + encodeURIComponent(place), 5000);
    loc = g && g.results && g.results[0];
    if (!loc) { if (g !== null) return null; const none = makePassport({ entity: place, attribute: "temperature", value: null, source: "open-meteo", domain: "weather" }, now); return finalise(resolveFacts([none], { domain: "weather", now, entity: place, attribute: "temperature" }), "current temperature in " + place, [none], {}); } // the geocoder did not answer
  }
  const name = loc.name + (loc.country ? ", " + loc.country : "");
  const mk = (source, t, updated) => makePassport({ entity: name, attribute: "temperature", value: t, unit: "°C", source, domain: "weather", basis: "air temperature at 2 m", source_updated_at: updated, retrieved_at: now, location: { lat: loc.latitude, lon: loc.longitude } }, now);
  const facts = await settle([
    ["open-meteo", async () => { const j = await jget("https://api.open-meteo.com/v1/forecast?latitude=" + loc.latitude + "&longitude=" + loc.longitude + "&current=temperature_2m&timezone=UTC", 6000); const c = j && j.current; const t = num(c && c.temperature_2m); return t == null ? null : mk("open-meteo", t, c.time ? Date.parse(c.time + "Z") : null); }],
    ["met-no", async () => { const j = await jget("https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=" + loc.latitude.toFixed(4) + "&lon=" + loc.longitude.toFixed(4), 6000); const series = (j && j.properties && j.properties.timeseries) || []; const s = series.slice().sort((x, y) => Math.abs(ms(x.time) - now) - Math.abs(ms(y.time) - now))[0]; const t = num(s && s.data && s.data.instant && s.data.instant.details && s.data.instant.details.air_temperature); return t == null ? null : mk("met-no", t, Math.min(now, ms(s.time))); }], // the entry for the hour nearest to now; its own time is the moment the value is valid for (the model run time is not)
  ], (id) => mk(id, null, null));
  const verdict = resolveFacts(facts, { domain: "weather", tol: { abs: 3 }, now, entity: name, attribute: "temperature", basis: "air temperature at 2 m" });
  return finalise(verdict, "current temperature in " + name, facts, { location: name });
}

// Adds the evidence graph and the fields a tool returns; a verdict that may not be stated as fact has no value in it.
function finalise(v, claim, facts, extra = {}) {
  const graph = evidenceGraph(claim, v);
  return { verdict: v, graph, claim, passports: facts, ...extra };
}
