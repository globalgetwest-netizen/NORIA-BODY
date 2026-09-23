// NORIA REALITY ROUTER — the step BEFORE the reality layer: does this request need external verification, of what kind, and from which sources?
//
//   USER REQUEST -> understand intent -> does it need current / factual / externally verifiable information?
//                -> which domain, which tools -> REALITY LAYER (authority, freshness, cross-check) -> verdict -> reasoning -> answer with evidence
//
// This module is domain-general on purpose. It knows about MANY domains (finance, travel, law, immigration, company information, science…), and for
// each one it says plainly whether a real source is connected. A domain with no connected source never produces an answer here: the decision is
// "say that it cannot be verified", not a guess. Adding a domain later means adding an adapter (a tool that returns passports); this router,
// the reality layer and the answer contract do not change.
//
// It is PURE (no network, no model) and it is NOT wired into the chat: connecting the conversational interface to it needs the owner's decision
// and its own testing. It exists so that connection is a small, tested step, and so the same routing serves agent tools and, later, chat.
//
// The layers stay separate: general intelligence and reasoning (the model), access to external information (tools and sources), verification
// (this router + reality.js), execution of actions (the executor) and authorisation to act (the gate and the person). A verdict never authorises an action.

import { DOMAINS, LOCKS, detectLockDomain } from "./reality.js";

// domain -> the words that signal it, and the connected tool (if any). "state" is taken from reality.js DOMAINS so there is ONE source of truth.
const RULES = [
  { domain: "fx", tool: "fx.rate", re: /\b(exchange rate|forex|convert(?:ed|ing)?\b.*\b(?:usd|eur|gbp|ghs|cedis?|dollars?|euros?|pounds?|naira|rand)|(?:usd|eur|gbp|ghs)\s*(?:\/|to|in)\s*(?:usd|eur|gbp|ghs)|how much is \d*\s*(?:dollars?|euros?|pounds?|cedis?)\b)/i },
  { domain: "crypto", tool: "crypto.price", re: /\b(bitcoin|btc|ethereum|eth|solana|dogecoin|xrp|cardano|litecoin|crypto(?:currency)?)\b.*\b(price|worth|value|trading|cost)|\b(price|worth|value) of (?:bitcoin|btc|ethereum|eth|solana|dogecoin|xrp|cardano|litecoin)\b/i },
  { domain: "weather", tool: "weather.get", re: /\b(weather|temperature|forecast|raining|will it rain|how (?:hot|cold|warm)|humid)\b/i },
  { domain: "time", tool: "clock.now", re: /\b(what (?:time|day|date|year)|current (?:time|date)|days? (?:until|since|between)|how many days|what day of the week)\b/i, computed: true },
  { domain: "flight_status", tool: null, re: /\b(flight|flights)\b.*\b(delay|delayed|status|on time|cancel|landed|arriv|depart|gate)|\b(is|has) flight\b|\bflight\s+[a-z]{2}\s?\d{1,4}\b/i },
  { domain: "traffic", tool: null, re: /\b(traffic|road (?:closure|conditions)|how long (?:will|does) it take to drive|congestion)\b/i },
  { domain: "stock_price", tool: null, re: /\b(stock|share)s? price|\b(?:stock|shares?)\b.*\b(?:trading|price|worth|at)\b|\b(nasdaq|nyse|s&p|dow jones|ftse)\b|\b(shares? of|stock of)\b.*\b(trading|price|worth)/i },
  { domain: "medical_guidance", tool: null, lock: "medical", re: /\b(dosage|dose|how much (?:paracetamol|ibuprofen|aspirin|amoxicillin|medication|medicine)|drug interaction|side effects? of|treatment for|what should i take for|is it safe to (?:take|give)|symptoms? of|can i take .* with)\b/i },
  { domain: "time", tool: "calc.math", computed: true, re: /\b\d[\d,.]*\s*%\s*of\s*\d|\b(?:what is|calculate|compute)\s+\(?\d[\d,.]*\s*[+\-*/x×÷^]\s*\(?\d/i },
  { domain: "appointment_availability", tool: null, lock: "immigration", re: /\b(visa|embassy|consulate|consular|residence permit|work permit|schengen|type d|appointment (?:system|slots?|booking|availability)|immigration)\b/i },
  { domain: "government_announcement", tool: null, lock: "legal", re: /\b(law|legislation|statute|regulation|court|ruling|judgement|judgment|bill|act of parliament|tax (?:rate|law)|is it (?:legal|illegal))\b/i },
  { domain: "company_registration", tool: null, re: /\b(company registration|registered company|business register|who owns|ownership of|ceo of|director of|is .+ (?:registered|licensed|a legitimate company))\b/i },
  { domain: "news", tool: "web.search", re: /\b(latest|breaking|news|headlines?|what happened|just (?:announced|happened)|this (?:week|morning)|yesterday)\b/i },
  { domain: "general", tool: "web.search", re: /\b(who is the (?:current|new|present)|current (?:president|prime minister|ceo|minister|governor|champion|leader)|who (?:won|wins) the (?:latest|last|most recent)|latest .*(?:winner|champion)|is .* still (?:the|a))\b/i },
];
// things that are about the PERSON's own material: verified against their documents, never against the outside world
const PRIVATE = /\b(my (?:document|file|contract|notes?|spreadsheet|pdf|report)|this (?:document|file|pdf|contract)|the (?:attached|uploaded))\b/i;
// wording that makes a question about the present or the future: it needs a current source even when the topic is otherwise stable
const NOW_WORDS = /\b(now|today|tonight|currently|current|latest|right now|at the moment|this (?:week|month|year)|as of|recent|most recent|up to date|still)\b/i;
const HISTORICAL = /\b(?:in|during|back in|as of)\s+(1[0-9]{3}|20[0-2][0-9])\b|\b(?:was|were|did|had)\b.*\b(?:in|during)\s+(?:1[0-9]{3}|20[0-2][0-9])\b/i;
const YEAR_NOW = new Date().getUTCFullYear();

const state = (domain) => (DOMAINS.find((d) => d.domain === domain) || { state: "none", note: "no source is connected for this kind of question" });

// Returns what to do with a request. decision:
//   answer_from_knowledge   stable knowledge or reasoning: no external verification needed
//   use_own_documents       the question is about the person's own material (retrieval from their documents, not the outside world)
//   verify_then_answer      a connected source can verify it: run the listed steps through the reality layer, then answer from the verdict
//   verify_partial          sources exist but are partial (for example degraded web search): answer with the uncertainty stated
//   cannot_verify           the question needs current or authoritative evidence and NO source is connected: say so plainly
//   ask_clarification       the question cannot be routed without more detail (which flight, which airport, which date)
export function routeRequest(text, opts = {}) {
  const q = String(text || "").trim(), now = opts.now || Date.now(), year = new Date(now).getUTCFullYear();
  const base = { input: q.slice(0, 200), domains: [], steps: [], lock_domain: null, temporal: "stable", needs_verification: false, decision: "answer_from_knowledge", reasons: [], clarify: [] };
  if (!q) return { ...base, decision: "ask_clarification", reasons: ["empty request"], clarify: ["what would you like to know?"] };
  if (PRIVATE.test(q)) return { ...base, decision: "use_own_documents", reasons: ["the question is about the person's own material: it is answered from their documents, never from the outside world"], steps: [{ tool: "knowledge.search", why: "search the person's own documents" }] };
  const hits = RULES.filter((r) => r.re.test(q));
  const historical = HISTORICAL.test(q) && !/\b(latest|current|now|today)\b/i.test(q), wantsNow = NOW_WORDS.test(q);
  base.temporal = historical ? "historical" : hits.length || wantsNow ? "current" : "stable";
  base.lock_domain = detectLockDomain(q) || (hits.find((h) => h.lock) || {}).lock || null;
  for (const h of hits) { const st = state(h.domain); base.domains.push({ domain: h.domain, tool: h.tool, state: st.state, note: st.note, computed: !!h.computed }); }
  // a historical question about a fixed past needs dated evidence, not a live feed
  if (historical && !hits.some((h) => h.computed)) { base.needs_verification = true; base.reasons.push("a question about a past date: needs dated evidence, not today's value"); }
  if (!hits.length) {
    if (wantsNow && /\b(who|what|which|is|are|how many|how much)\b/i.test(q) && !/\b(explain|write|draft|summari[sz]e|translate|poem|story|code|essay)\b/i.test(q)) {
      base.needs_verification = true; base.domains.push({ domain: "general", tool: "web.search", state: state("general").state, note: state("general").note }); base.reasons.push("phrased about the present (\"" + (NOW_WORDS.exec(q) || [""])[0] + "\") but no specific domain: treated as a current general fact");
    } else if (!base.needs_verification) { base.reasons.push("stable knowledge or a task that needs reasoning, not outside evidence"); return base; }
  } else base.needs_verification = true;
  // flight questions need identity before anything else: the airline, the flight, the date
  const missing = [];
  if (base.domains.some((d) => d.domain === "flight_status")) { if (!/\b[a-z]{2}\s?\d{1,4}\b/i.test(q) && !/\bflight (?:number|no)\b/i.test(q)) missing.push("which flight (airline and number)"); if (!/\b(today|tomorrow|tonight|yesterday|\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}|[a-z]{3,9}\s+\d{1,2}|\d{4}-\d{2}-\d{2})\b/i.test(q)) missing.push("which date"); }
  if (base.domains.some((d) => d.domain === "weather") && !/\b(in|at|for|near)\s+[A-Za-z]/.test(q)) missing.push("which place");
  if (base.domains.some((d) => d.domain === "appointment_availability") && !/\b(hungary|germany|france|uk|united kingdom|usa|united states|canada|netherlands|italy|spain|poland|china|dubai|uae|schengen|[A-Z][a-z]+ (?:embassy|consulate))\b/i.test(q)) missing.push("which country or authority");
  if (missing.length) return { ...base, decision: "ask_clarification", clarify: missing, reasons: [...base.reasons, "the question cannot be checked without: " + missing.join(", ")] };
  const connected = base.domains.filter((d) => d.tool && (d.state === "connected" || d.computed)), partial = base.domains.filter((d) => d.tool && d.state === "partial"), none = base.domains.filter((d) => d.state === "none" || !d.tool);
  for (const d of [...connected, ...partial]) if (!base.steps.some((x) => x.tool === d.tool)) base.steps.push({ tool: d.tool, domain: d.domain, why: d.computed ? "computed exactly" : "verified across independent sources" });
  if (historical && !base.steps.some((x) => x.tool === "web.search") && !connected.some((d) => d.computed)) base.steps.push({ tool: "web.search", domain: "general", why: "dated evidence for a past date (not today's value)" });
  if (base.lock_domain) base.reasons.push("source lock: " + LOCKS[base.lock_domain].why);
  if (none.length && !connected.length && !partial.length) return { ...base, decision: "cannot_verify", steps: [], reasons: [...base.reasons, ...none.map((d) => d.domain + ": " + d.note)], state_label: "Target · infrastructure required · not yet implemented", statement: "This needs current or authoritative evidence, and the source for it is not connected yet (" + none.map((d) => d.note).join("; ") + "). I can't verify it yet, and I won't answer it from memory or guess." };
  if (none.length) base.reasons.push("part of this cannot be verified: " + none.map((d) => d.domain).join(", "));
  base.decision = connected.length && !partial.length && !none.length ? "verify_then_answer" : "verify_partial";
  // a source-locked question needs the lock applied to whatever the search returns
  if (base.lock_domain && base.steps.some((s) => s.tool === "web.search")) base.steps.find((s) => s.tool === "web.search").why = "official sources only (source lock: " + base.lock_domain + ")";
  return base;
}

// What the answer must carry, by decision: the contract the conversational layer would follow once connected.
export function answerContract(decision) {
  return {
    answer_from_knowledge: { evidence: "none required", uncertainty: "state it if the model is unsure", forbidden: [] },
    use_own_documents: { evidence: "cite the person's own passages", uncertainty: "say when the documents do not contain the answer", forbidden: ["adding facts from outside the documents without saying so"] },
    verify_then_answer: { evidence: "the verdict's value, its sources, authority and time", uncertainty: "state PARTIALLY_VERIFIED caveats and any dissent", forbidden: ["a number the verdict does not support", "presenting CONFLICTING / STALE / UNAVAILABLE / UNVERIFIED as fact"] },
    verify_partial: { evidence: "what was verified, and what could not be", uncertainty: "say which part is unverified", forbidden: ["stating the unverified part as fact"] },
    cannot_verify: { evidence: "none exists", uncertainty: "say plainly that it cannot be verified YET, what is missing, and never answer from memory", forbidden: ["answering from memory", "guessing"] },
    ask_clarification: { evidence: "n/a", uncertainty: "ask only for what is missing", forbidden: ["guessing the missing detail"] },
  }[decision];
}

// The separate layers of Noria, stated in one place so no layer is mistaken for another. Used by /brain/reality and the docs.
export const LAYERS = [
  { id: "intelligence", name: "General intelligence and reasoning", what: "understanding, planning, language, judgement (the model)", holds_authority: false },
  { id: "access", name: "Access to external information", what: "tools and sources: search, feeds, documents, connectors", holds_authority: false },
  { id: "verification", name: "Verification", what: "source authority, freshness, cross-checking, conflict handling, verdicts (this router + reality.js)", holds_authority: false },
  { id: "execution", name: "Execution of actions", what: "the executor: gates, timeouts, retries, audit", holds_authority: false },
  { id: "authorisation", name: "Authorisation to act", what: "the read-only gate and the person's approval: the ONLY layer that can allow an action", holds_authority: true },
];
