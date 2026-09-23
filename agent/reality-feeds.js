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

export async function weatherVerdict(place, { jget, now = Date.now() }) {
  const g = await jget("https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=" + encodeURIComponent(place), 5000);
  const loc = g && g.results && g.results[0];
  if (!loc) { if (g !== null) return null; const none = makePassport({ entity: place, attribute: "temperature", value: null, source: "open-meteo", domain: "weather" }, now); return finalise(resolveFacts([none], { domain: "weather", now, entity: place, attribute: "temperature" }), "current temperature in " + place, [none], {}); } // the geocoder did not answer
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
