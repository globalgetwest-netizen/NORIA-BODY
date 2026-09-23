# Noria Reality Architecture

Noria is AI + reality data + a verification engine. The language model reasons and communicates; it is **not** the source of truth.
"Zero errors" cannot honestly be promised for arbitrary real-world data (official sources are delayed, corrected, unavailable or wrong).
What this layer guarantees is narrower and checkable: **Noria does not knowingly present unverified or conflicting information as fact,
and every value it does state can be traced to its sources, their authority and the time they were observed.**

Code: `agent/reality.js` (engine), `agent/reality-feeds.js` (live adapters), routes `/brain/reality` and the tools `fx.rate`, `crypto.price`,
`weather.get`, `web.search` through `/brain/tool`. Tests: `reality_t.mjs` (57), `reality_feeds_t.mjs`, `worker_int_t.mjs`, live `feeds_t.mjs`.

## Pipeline
retrieve → authenticate (who says so) → compare (independent agreement) → validate (fresh?) → timestamp → reason → answer, or **refuse**.

## Parts (all built in `reality.js`)
| Part | What it does |
|---|---|
| Source authority | 5 levels: official · licensed provider · established secondary · general web · user claim. `classifyUrl` ranks web addresses; look-alike hosts (`gov.evil.com`) are not official. |
| Data passport | Every fact: entity, attribute, value, unit, source (id, level, family), basis, published / source-updated / retrieved time, validity window, expiry, freshness, deterministic fact id. |
| Freshness | 12 kinds of information with their own windows (flight 5 min … historical permanent). Age is measured from the **source's** timestamp, not when Noria fetched it. |
| Verdict states | VERIFIED · PARTIALLY_VERIFIED · CONFLICTING · STALE · UNAVAILABLE · UNVERIFIED · UNKNOWN. Only the first two allow a value to be stated (the second with a caveat). |
| Conflict resolution | Different bases (retail vs market) are excluded, not compared. Values cluster within a tolerance. **Authority outranks numbers:** an equal-standing disagreement is CONFLICTING (no value); a lower-authority outlier is overruled and recorded. Two answers from one provider are not independent. |
| Source lock | immigration / law: official only; medical / finance: official or approved. A blog cannot answer however confident it sounds. |
| Entities | Airports (codes, names, nicknames) and organisations (legal suffixes, abbreviations). A city with several airports is **ambiguous**, never guessed. Seed tables, not a global registry. |
| Time model | Entity + attribute + value + validity interval: "current" and "historical" are different questions; a record no one re-checked is STALE; overlapping records that disagree are CONFLICTING. |
| Guard | `guardAnswer` checks a drafted answer against the verdict: a number the verdict withheld (conflict / stale) or contradicts replaces the draft with the safe statement. |
| Evidence graph | claim → evidence (each source, level, value, time, role: supports / excluded) → verification → answer. |
| Three systems | knowledge (stable), live data, and the person's private data are never mixed in one verification. |

## What is connected for real
| Domain | Sources compared | Notes |
|---|---|---|
| Exchange rates | ECB reference (where covered), open.er-api, currency-api | **Daily reference rates**, not trading prices; labelled so. |
| Crypto | Coinbase, Kraken, Binance, CoinGecko | All asked; none "first wins". |
| Weather | MET Norway (official), Open-Meteo | Current temperature. |
| Date, time, arithmetic | computed | Exact. |
| Web search | marks each source's authority; source-locked questions flag admissible sources | |

## Not connected (Noria says it cannot check these)
Flight status, traffic, real-time stock prices, visa / immigration / appointment systems, legislation and courts, company registries. The source
lock and freshness windows for them exist; **no data source does** (most need paid or partnered feeds). `GET /brain/reality` lists every domain and its state.

## Not yet done (honest)
* The chat answers (`/brain/ask`) do not use verdicts yet: that path is unchanged by rule. The verdict layer serves the agent tools first.
* `guardAnswer` is built and tested, not wired into an answer path.
* Fresh production checks: run `feeds_t.mjs` after deploy.
* Permissions per connector (READ / WRITE / EXECUTE / DELETE / ADMIN) already exist in the tool registry (`risk`, `permissions`, `auth`), enforced by the executor and gate; acting tools remain not authorised.

## The final flow (owner-approved direction, preserved)
The Reality Layer must NOT stay permanently isolated to agent tools. Keeping it out of the chat during development is deliberate (the chat pipeline is
not modified without proper testing), but the architecture is built so the conversational interface can invoke the same system:

    USER REQUEST -> understand intent -> does it need current / factual / externally verifiable information?
      -> select tools and sources -> REALITY LAYER (authority, freshness, cross-check) -> VERDICT -> reasoning -> answer with evidence and uncertainty

* `agent/reality-router.js` is the "does it need verification, and from which sources" step. It is pure and domain-general; it covers many domains and
  says plainly, per domain, whether a source is connected. A domain with no connected source never produces an answer: the decision is `cannot_verify`.
* `answerContract(decision)` states what an answer must carry (evidence, uncertainty) and must never do (state a conflict or stale value as fact, answer from memory).
* `POST /brain/reality/route { text }` shows how any phrase would be routed (pure computation, `connected_to_chat: false`), so routing can be tested on real
  phrasings in production before any connection to the chat is considered.
* Connecting the chat is a separate, tested step that needs the owner's decision. Nothing here claims it exists.

## Separate layers (never conflated)
| Layer | What it is | Holds authority to act? |
|---|---|---|
| General intelligence and reasoning | the model: understanding, planning, language, judgement | no |
| Access to external information | tools and sources: search, feeds, documents, connectors | no |
| Verification | source authority, freshness, cross-checking, verdicts (router + `reality.js`) | no |
| Execution of actions | the executor: gates, timeouts, retries, audit | no |
| Authorisation to act | the read-only gate and the person's approval | **only this layer** |
A verdict never authorises an action; a tool's access never implies permission; reasoning never overrides a verdict.

## Domains: target vs implemented
Research, documents, business, government, legislation, immigration, company, finance, travel and science are TARGET domains. The architecture supports them
(authority levels, freshness, source locks, entities, time model); none is claimed implemented until an authoritative source is connected and verified.
Connected today: exchange rates, crypto, weather, computed date and arithmetic, web search (degraded).
