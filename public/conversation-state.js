/**
 * NORIA CONVERSATION STATE — structured, per-conversation understanding of what is actually going on, so a long
 * conversation does not collapse into "whatever fit in the last 8 messages" once it grows past that window.
 *
 * Lives entirely on the device, as a field on the SAME conversation object that already syncs to the account as an
 * opaque blob (noria-ai/schema.sql: `payload ... opaque to the server`). This is not a new server table and does
 * not change what the server can read — it is JSON inside the same blob, exactly like the messages already are.
 *
 * HONESTY ABOUT WHAT THIS IS: this is real, mechanical, inspectable tracking of message-derived signals — what was
 * asked, what was produced (a code block, an image, a document), whether a message continues the current thing or
 * starts a new one, whether it looks like a reference back to something ("it", "that", "fix it", "is it done?").
 * It is NOT a natural-language-understanding engine and does not claim to be one. Where a reference is genuinely
 * ambiguous, this module hands the model enough real context to resolve it correctly (or to ask), rather than
 * pretending to resolve it itself with a hand-rolled parser.
 */

// ── the state shape ──────────────────────────────────────────────────────────────────────────────────────────────
// activeObjective: { text, startedAt, msgIndex } | null — the thing currently being worked on.
// objectiveHistory: past activeObjective entries, most recently closed last, capped.
// entities: { id, label, kind, msgIndex, at } — something produced or named that a later message might refer back
//   to (a code block, an image, a named option/choice). kind: "code" | "image" | "document" | "topic".
// decisions: { text, msgIndex, at } — an explicit choice or constraint the user stated ("use Clerk").
// corrections: { text, msgIndex, at } — the user said an earlier answer or memory was wrong.
export function createState() {
  return { v: 1, activeObjective: null, objectiveHistory: [], entities: [], decisions: [], corrections: [] };
}
// Never trust a state object blindly (it round-trips through JSON in localStorage/the sync payload): repair a
// missing or malformed field instead of throwing, the same defensive posture as memory.js's loadMemory().
export function ensureState(s) {
  const d = createState();
  if (!s || typeof s !== "object") return d;
  for (const k of Object.keys(d)) if (!(k in s)) s[k] = d[k];
  if (!Array.isArray(s.objectiveHistory)) s.objectiveHistory = [];
  if (!Array.isArray(s.entities)) s.entities = [];
  if (!Array.isArray(s.decisions)) s.decisions = [];
  if (!Array.isArray(s.corrections)) s.corrections = [];
  return s;
}

const CAP_ENTITIES = 24, CAP_DECISIONS = 16, CAP_CORRECTIONS = 8, CAP_OBJECTIVES = 8;

// ── signal detectors (plain regex, deliberately transparent and inspectable — not a black box) ────────────────────
// Leading filler ("Now, ", "OK so ", "Well, ") carries no topic signal on its own — strip it before classifying,
// so "Now let's build X" is judged on "let's build X", not wrongly caught by "now" looking like a continuation word.
const LEADING_FILLER_RX = /^(?:now|ok|okay|so|well|alright|right)[,\s]+/i;
const stripFiller = (text) => { let t = text; for (let i = 0; i < 3; i++) { const s = t.replace(LEADING_FILLER_RX, ""); if (s === t) break; t = s; } return t; };
// A short message that is clearly a continuation instruction, not a fresh topic ("use Clerk.", "make it production
// ready.", "fix it.", "continue.") — the sole cue that decides whether the active objective carries over.
const CONTINUATION_RX = /^(use|make|change|fix|update|continue|do|try|go with|switch to|add|remove|also|then|and|ok|okay|yes|no|sure|please|actually)\b/i;
// A message that clearly opens something new, overriding continuation even if it is short.
const NEW_TOPIC_RX = /^(build|create|write|design|plan|start|let'?s (?:build|make|start|create|write)|new (?:project|task|objective))\b/i;
// Pronoun / back-reference cues: when a message matches this, the context addendum should include recent entities
// and the active objective explicitly, because "it"/"that" cannot be resolved from the message text alone.
const REFERENCE_RX = /\b(it|that|this|the (?:previous|last|first|second|other|same)\s+\w+|the new version|continue|fix it|do the same|make it better|change that|what about|is it done|are we done|did (?:you|it) (?:work|finish|complete))\b/i;
// An explicit correction of something Noria said or remembered.
const CORRECTION_RX = /\b(that'?s not what i (?:said|meant|asked)|i did(?:n'?t| not) say that|that'?s wrong|you'?re wrong|no,? that'?s not (?:it|right|correct)|correction:|actually,? i meant)\b/i;
export const looksLikeReference = (text) => REFERENCE_RX.test(String(text || "").trim());
export const looksLikeCorrection = (text) => CORRECTION_RX.test(String(text || "").trim());

function summarize(text, n = 140) { return String(text || "").replace(/\s+/g, " ").trim().slice(0, n); }

// Call once per completed exchange (a user message and, once it exists, the assistant's reply to it). msgIndex is
// this user message's position in the conversation's message array — entities/decisions/objective all record it,
// so later retrieval can find the ORIGINAL message a reference points back to, not just a paraphrase.
export function updateStateAfterUser(state, userText, msgIndex) {
  const s = ensureState(state);
  const text = String(userText || "").trim();
  if (!text) return s;
  if (looksLikeCorrection(text)) s.corrections = [...s.corrections, { text: summarize(text, 200), msgIndex, at: Date.now() }].slice(-CAP_CORRECTIONS);
  const cls = stripFiller(text); // classification runs on the filler-stripped text; storage keeps the original wording
  const isNew = NEW_TOPIC_RX.test(cls) || (!CONTINUATION_RX.test(cls) && !REFERENCE_RX.test(cls) && text.split(/\s+/).length >= 4 && !s.activeObjective);
  const isContinuation = !!s.activeObjective && (CONTINUATION_RX.test(cls) || REFERENCE_RX.test(cls) || text.split(/\s+/).length <= 6) && !NEW_TOPIC_RX.test(cls);
  if (isNew && !isContinuation) {
    if (s.activeObjective) s.objectiveHistory = [...s.objectiveHistory, s.activeObjective].slice(-CAP_OBJECTIVES);
    s.activeObjective = { text: summarize(text, 200), startedAt: Date.now(), msgIndex };
  } else if (s.activeObjective && CONTINUATION_RX.test(cls) && !REFERENCE_RX.test(cls)) {
    // a continuation that adds a real constraint ("Use Clerk.") is folded into the objective's own text, so the
    // objective summary itself stays current without needing every past turn re-read
    s.activeObjective = { ...s.activeObjective, text: summarize(s.activeObjective.text + "; " + text, 300) };
  }
  return s;
}
// Call after the assistant's reply is final. meta: { code: [{language}], image: bool, document: bool } — real,
// mechanical signals already available where the reply is rendered (renderMd already knows if it built a code
// block or an image), not inferred by re-parsing prose.
export function updateStateAfterAssistant(state, assistantText, msgIndex, meta = {}) {
  const s = ensureState(state);
  const push = (label, kind) => { s.entities = [...s.entities, { id: "e" + msgIndex + "_" + s.entities.length, label: summarize(label, 100), kind, msgIndex, at: Date.now() }].slice(-CAP_ENTITIES); };
  for (const c of meta.code || []) push((c.language ? c.language + " code" : "code") + (s.activeObjective ? " for " + summarize(s.activeObjective.text, 60) : ""), "code");
  if (meta.image) push("the generated image" + (s.activeObjective ? " for " + summarize(s.activeObjective.text, 60) : ""), "image");
  if (meta.document) push("the document" + (s.activeObjective ? " (" + summarize(s.activeObjective.text, 60) + ")" : ""), "document");
  return s;
}
// A decision is recorded only when the caller has already identified a real one (kept separate from guessing at
// free text — see how this is called from workspace.js for the actual, narrow trigger used today).
export function recordDecision(state, text, msgIndex) {
  const s = ensureState(state);
  s.decisions = [...s.decisions, { text: summarize(text, 200), msgIndex, at: Date.now() }].slice(-CAP_DECISIONS);
  return s;
}

// ── context retrieval: replaces "blindly send the last N messages" ─────────────────────────────────────────────
// messages: the conversation's full { role, text }[] (workspace.js's convo.messages shape). currentText: the new
// user message about to be sent. recentN: how many trailing messages are always included regardless (recency).
// Returns { history: {role, content}[], addendum: string }. `history` is what would have been the blind slice,
// widened with any older message a detected reference plausibly needs. `addendum` is a short, explicit summary
// (active objective, relevant entities/decisions) appended to the system prompt — the same mechanism memory.js's
// memoryContext() already uses for long-term facts, now doing it for THIS conversation's own state.
export function buildContext(state, messages, currentText, recentN = 8) {
  const s = ensureState(state);
  const msgs = Array.isArray(messages) ? messages : [];
  const recent = msgs.slice(-recentN);
  const recentIdx = new Set(recent.map((_, i) => msgs.length - recent.length + i));
  const isRef = looksLikeReference(currentText);
  const extra = [];
  if (isRef) {
    // pull in the ORIGINAL message that introduced the most relevant still-active entity/objective, even if it
    // fell out of the recency window — this is the concrete fix for "message 12 of 20 gets forgotten"
    const wantIdx = new Set();
    if (s.activeObjective && !recentIdx.has(s.activeObjective.msgIndex)) wantIdx.add(s.activeObjective.msgIndex);
    for (const e of s.entities.slice(-3)) if (!recentIdx.has(e.msgIndex)) wantIdx.add(e.msgIndex);
    for (const i of [...wantIdx].sort((a, b) => a - b)) if (msgs[i]) extra.push(msgs[i]); // strict chronological order, never assumed from insertion order
  }
  const history = [...extra, ...recent].map((m) => ({ role: m.role === "err" ? "assistant" : m.role, content: String(m.text || "").slice(0, 4000) })).filter((m) => m.content);
  const bits = [];
  if (s.activeObjective) bits.push("Current objective: " + s.activeObjective.text);
  if (isRef && s.entities.length) bits.push("Recently produced: " + s.entities.slice(-3).map((e) => e.label).join("; "));
  if (s.decisions.length) bits.push("Decisions made so far: " + s.decisions.slice(-5).map((d) => d.text).join("; "));
  if (s.corrections.length) bits.push("The person has corrected: " + s.corrections.slice(-3).map((c) => c.text).join("; "));
  const addendum = bits.length ? "\n\n[CONVERSATION STATE — what is actually going on in this conversation, tracked automatically. Use it to understand references like \"it\"/\"that\"/\"continue\" correctly; do not recite it back verbatim]:\n- " + bits.join("\n- ") : "";
  return { history, addendum };
}
