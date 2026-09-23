# Noria capability map

The map (`agent/capability-map.js`, live at `GET /brain/capability-map`) lists the full capability surface of a leading general-purpose AI system as
**targets** for Noria, and measures progress toward each. It measures progress; it does not define Noria's limits.

## How to read an entry
`Target · implemented: <level> · verified: <level> · <what is missing>`, plus: what leading systems do, what it needs (architecture, tools, runtimes,
providers, permissions), whether it is available / connected / authorised, and the next engineering step.

* **Implemented / verified are derived from the capability registry** (`agent/families.js`), never written in the map, so the map cannot claim more than the evidence rules allow. An entry with no registry row is *unassessed*.
* **Kept separate:** target · implemented · verified · available · connected · authorised · blocked-by.
* **Blocked-by** is one of: infrastructure · provider · integration · authorisation · verification · design. Each is an engineering gap to close, **never evidence that a category of work is out of Noria's reach.** Wording lint in `capability_map_t.mjs` enforces this (no "cannot" for a missing subsystem).

## Discovery method
1. List what ChatGPT-class systems do in production (owner's list + discovered extras: tool servers, webhooks, multi-agent orchestration, continuous evaluation, enterprise controls, API access, devices).
2. For each: what it needs (architecture, tools, runtimes, providers, permissions).
3. Build infrastructure, integrate into the task graph, test on real tasks, verify in production, record limits.
4. Add unseen real objectives so generalisation is tested, not memorised benchmarks.

## Build order by leverage (a working plan, revisited as evidence arrives)
1. Code execution: JavaScript sandbox built and isolation-tested (owner sign-off pending) -> Python runtime -> server-side runtime if browser limits bite.
2. A second open-web search provider (removes the degraded web research state).
3. Read-only web browsing/page reading -> forms/actions behind approvals.
4. OAuth connector broker with read-only connectors first (email, calendar, drive, GitHub), each individually authorised.
5. Providers behind the reality layer: routing/maps, delayed market quotes + filings, scholarly indexes, one country's official legislation/immigration source, a business registry, flights.
6. Approval controls on the project screen; notifications; background execution (owner authorisation).
7. Image editing, audio transcription of files, video frame understanding.
8. Rolling evaluation on new real objectives.
