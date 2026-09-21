// NORIA RAG — provider-agnostic retrieval-augmented generation pipeline.
//
//   documents -> parsing (by the caller) -> chunking -> embeddings -> vector index
//                                                   \-> keyword index (BM25)
//   query -> hybrid retrieval (reciprocal-rank fusion) -> reranking -> context selection -> grounded generation -> citation check
//
// Nothing here is tied to one vendor. Two small interfaces are the seams:
//   Embedder     { id, dim, async embed(texts: string[]) -> number[][] }
//   VectorIndex  { async upsert(items: [{id, vector, meta}]), async query(vector, k, filter?) -> [{id, score}], async delete(ids), size() }
// Implementations included: a local feature-hashing embedder (no service needed; lexical, not semantic), an in-memory cosine index,
// and a remote embedder adapter (an HTTP endpoint that returns vectors). A hosted index (for example Cloudflare Vectorize) is one more
// object with the same three methods. If no embedder is connected, retrieval runs on keywords alone and says so (mode "keyword").
//
// This module is pure JavaScript with no imports, so it runs in the browser, in a Worker, and in Node tests.

const fold = (t) => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const STOP = new Set("a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those there here which who whom what when where why how do does did not no so than then too very can could should would will shall may might must have has had i you he she we they them his her our your their my me us".split(" "));
function stem(t) { // plural -> singular; numbers, "ss" / "us" / "is" endings untouched
  if (t.length <= 3 || /\d/.test(t)) return t;
  if (/[^aeiou]ies$/.test(t)) return t.slice(0, -3) + "y";
  if (/(?:ss|us|is)$/.test(t)) return t;
  if (/(?:x|z|ch|sh|s)es$/.test(t)) return t.slice(0, -2);
  return /s$/.test(t) ? t.slice(0, -1) : t;
}
export function tokenize(text) {
  const out = [];
  for (const w of fold(text).split(/[^a-z0-9.%]+/)) {
    const t = w.replace(/^\.+|\.+$/g, "");
    if (!t || (t.length < 2 && !/\d/.test(t)) || STOP.has(t)) continue;
    out.push(stem(t));
  }
  return out;
}

// ── chunking: respects the structure of the text instead of cutting at a fixed size ──────────────────────────────────
// Splits on headings and blank lines, keeps a page marker ("[Page 12]", "--- page 12 ---", "Page 12") with every chunk, packs whole
// paragraphs up to maxChars, splits an over-long paragraph at sentence ends, and repeats a short tail (overlap) into the next chunk.
export function chunkDocument(text, opts = {}) {
  const maxChars = opts.maxChars || 1100, overlap = opts.overlap == null ? 140 : opts.overlap, source = opts.source || "document";
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const blocks = []; let cur = [], page = null, heading = "", blockPage = null, blockHeading = "";
  const flush = () => { const t = cur.join("\n").trim(); if (t) blocks.push({ text: t, page: blockPage, heading: blockHeading }); cur = []; };
  for (const line of lines) {
    const pm = /^\s*(?:\[|-{2,}\s*)?page\s+(\d{1,5})(?:\]|\s*-{2,})?\s*$/i.exec(line);
    if (pm) { flush(); page = Number(pm[1]); continue; }
    const hm = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) || (/^[A-Z0-9][A-Z0-9 .,&'-]{3,70}$/.test(line.trim()) && line.trim().length < 80 ? [null, "#", line.trim()] : null);
    if (hm) { flush(); heading = hm[2]; blockHeading = heading; blockPage = page; cur.push(line.trim()); continue; }
    if (!line.trim()) { flush(); blockHeading = heading; blockPage = page; continue; }
    if (!cur.length) { blockPage = page; blockHeading = heading; }
    cur.push(line);
  }
  flush();
  const chunks = []; let buf = "", bufPage = null, bufHeading = "", tail = "";
  const emit = () => { const t = buf.trim(); if (t) { chunks.push({ id: source + "#" + chunks.length, text: t, meta: { source, page: bufPage, heading: bufHeading, index: chunks.length } }); tail = overlap ? t.slice(-overlap).replace(/^\S*\s/, "") : ""; } buf = ""; };
  for (const b of blocks) {
    const pieces = b.text.length <= maxChars ? [b.text] : b.text.split(/(?<=[.!?])\s+/).reduce((acc, sent) => { const last = acc[acc.length - 1]; if (last && (last + " " + sent).length <= maxChars) acc[acc.length - 1] = last + " " + sent; else acc.push(sent); return acc; }, []);
    if (buf && (b.page !== bufPage || (b.heading !== bufHeading && b.heading))) emit(); // new page or new section: start a new chunk
    for (const piece of pieces) {
      if (buf && (buf + "\n\n" + piece).length > maxChars) emit();
      if (!buf) { buf = tail && chunks.length && chunks[chunks.length - 1].meta.page === b.page && chunks[chunks.length - 1].meta.heading === b.heading ? tail + " " : ""; bufPage = b.page; bufHeading = b.heading; }
      buf += (buf && !buf.endsWith(" ") ? "\n\n" : "") + piece;
    }
  }
  emit();
  return chunks;
}

// ── keyword index: BM25 ─────────────────────────────────────────────────────────────────────────────────────────────
export class BM25Index {
  constructor(chunks, opts = {}) {
    this.k1 = opts.k1 || 1.5; this.b = opts.b || 0.75; this.chunks = chunks;
    this.tf = chunks.map((c) => { const m = new Map(); for (const t of tokenize(c.text + " " + (c.meta && c.meta.heading || ""))) m.set(t, (m.get(t) || 0) + 1); return m; });
    this.len = this.tf.map((m) => { let n = 0; for (const v of m.values()) n += v; return n; });
    this.avg = this.len.reduce((a, b) => a + b, 0) / Math.max(1, chunks.length);
    this.df = new Map(); for (const m of this.tf) for (const t of m.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
  }
  search(query, k = 10) {
    const terms = [...new Set(tokenize(query))], N = this.chunks.length, scores = [];
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (const t of terms) { const f = this.tf[i].get(t); if (!f) continue; const idf = Math.log(1 + (N - (this.df.get(t) || 0) + 0.5) / ((this.df.get(t) || 0) + 0.5)); s += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * this.len[i] / (this.avg || 1))); }
      if (s > 0) scores.push({ id: this.chunks[i].id, score: s });
    }
    return scores.sort((a, b) => b.score - a.score).slice(0, k);
  }
}

// ── embedders ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Feature hashing of words and word pairs into a fixed-size vector: works with no service and no quota. It matches on shared
// vocabulary (it is NOT a semantic model), so it is the offline fallback, not the goal.
export function hashingEmbedder(dim = 384) {
  const h = (s) => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; };
  return { id: "hashing-" + dim, dim, async embed(texts) {
    return texts.map((t) => { const v = new Float32Array(dim), w = tokenize(t); const add = (f, wt) => { const x = h(f); v[x % dim] += (x & 0x10000 ? 1 : -1) * wt; }; w.forEach((tok, i) => { add(tok, 1); if (i) add(w[i - 1] + "_" + tok, 0.5); }); return norm(v); });
  } };
}
// A remote embedder: POSTs {texts} to an endpoint that answers {vectors: number[][]}. Failure throws, so the caller can fall back.
export function remoteEmbedder(url, dim, headers = {}, id = "remote") {
  return { id, dim, async embed(texts) { const r = await fetch(url, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers), body: JSON.stringify({ texts }) }); if (!r.ok) throw Object.assign(new Error("embedder " + r.status), { status: r.status }); const j = await r.json(); if (!Array.isArray(j.vectors) || j.vectors.length !== texts.length) throw new Error("embedder returned the wrong shape"); return j.vectors.map((v) => norm(Float32Array.from(v))); } };
}
function norm(v) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; s = Math.sqrt(s) || 1; for (let i = 0; i < v.length; i++) v[i] /= s; return v; }
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// ── vector index (in memory; a hosted index implements the same four methods) ──────────────────────────────────────
export class MemoryVectorIndex {
  constructor() { this.items = new Map(); }
  async upsert(items) { for (const it of items) this.items.set(it.id, { vector: it.vector, meta: it.meta || {} }); }
  async query(vector, k = 10, filter = null) { const out = []; for (const [id, it] of this.items) { if (filter && !filter(it.meta, id)) continue; out.push({ id, score: dot(vector, it.vector) }); } return out.sort((a, b) => b.score - a.score).slice(0, k); }
  async delete(ids) { for (const id of ids) this.items.delete(id); }
  size() { return this.items.size; }
}

// ── the knowledge base: index once, retrieve many times ────────────────────────────────────────────────────────────
export class KnowledgeBase {
  constructor({ embedder = null, vectorIndex = null, chunkOpts = {} } = {}) { this.embedder = embedder; this.vectors = vectorIndex || (embedder ? new MemoryVectorIndex() : null); this.chunkOpts = chunkOpts; this.chunks = []; this.byId = new Map(); this.bm25 = null; this.vectorReady = false; this.vectorError = ""; }
  // docs: [{ source, text }]
  async add(docs) {
    for (const d of docs) for (const c of chunkDocument(d.text, Object.assign({ source: d.source }, this.chunkOpts))) { c.id = d.source + "#" + this.chunks.length; c.meta.index = this.chunks.length; this.chunks.push(c); this.byId.set(c.id, c); }
    this.bm25 = new BM25Index(this.chunks);
    this.vectorReady = false; this.vectorError = "";
    if (this.embedder && this.vectors) {
      try {
        for (let i = 0; i < this.chunks.length; i += 32) { const part = this.chunks.slice(i, i + 32); const vecs = await this.embedder.embed(part.map((c) => c.text)); await this.vectors.upsert(part.map((c, j) => ({ id: c.id, vector: vecs[j], meta: c.meta }))); }
        this.vectorReady = true;
      } catch (e) { this.vectorError = String((e && e.message) || e).slice(0, 120); } // embeddings are unavailable: keyword retrieval carries on, and says so
    }
    return { chunks: this.chunks.length, vectors: this.vectorReady, vectorError: this.vectorError };
  }
  // Hybrid retrieval: keyword ranks and vector ranks are merged by reciprocal-rank fusion, then reranked.
  async retrieve(query, opts = {}) {
    const k = opts.k || 8, pool = opts.pool || Math.max(24, k * 3), rrf = opts.rrfK || 60, wk = opts.keywordWeight == null ? 1 : opts.keywordWeight, wv = opts.vectorWeight == null ? 1 : opts.vectorWeight;
    const kw = this.bm25 ? this.bm25.search(query, pool) : [];
    let vec = [], mode = "keyword";
    if (this.vectorReady) { try { const [qv] = await this.embedder.embed([query]); vec = await this.vectors.query(qv, pool, opts.filter || null); mode = "hybrid"; } catch (e) { mode = "keyword"; this.vectorError = String((e && e.message) || e).slice(0, 120); } }
    const fused = new Map();
    kw.forEach((r, i) => fused.set(r.id, (fused.get(r.id) || 0) + wk / (rrf + i + 1)));
    vec.forEach((r, i) => { if (r.score > 0) fused.set(r.id, (fused.get(r.id) || 0) + wv / (rrf + i + 1)); });
    let cands = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, pool).map(([id, score]) => ({ chunk: this.byId.get(id), score }));
    cands = (opts.reranker || overlapReranker)(query, cands);
    return { mode, passages: cands.slice(0, k).map((c, i) => ({ n: i + 1, id: c.chunk.id, text: c.chunk.text, meta: c.chunk.meta, score: c.score })) };
  }
}

// ── reranking ─────────────────────────────────────────────────────────────────────────────────────────────────────
// A second, sharper look at the candidates: how much of the question each passage covers (rare words count more), whether the
// question's words appear close together, and a penalty for a near-copy of a better passage. A cross-encoder can replace this
// function: it takes (query, candidates) and returns the candidates reordered with a new .score.
// The smallest run of tokens that contains every distinct query term this passage has (two-pointer sliding window).
function minWindow(toks, qset) {
  const idx = []; toks.forEach((t, i) => { if (qset.has(t)) idx.push([i, t]); });
  const need = new Set(idx.map((x) => x[1])).size;
  if (need < 2) return { matched: need, span: 1 };
  const counts = new Map(); let have = 0, best = Infinity, l = 0;
  for (let r = 0; r < idx.length; r++) {
    const t = idx[r][1]; counts.set(t, (counts.get(t) || 0) + 1); if (counts.get(t) === 1) have++;
    while (have === need) { best = Math.min(best, idx[r][0] - idx[l][0] + 1); const lt = idx[l][1]; counts.set(lt, counts.get(lt) - 1); if (counts.get(lt) === 0) have--; l++; }
  }
  return { matched: need, span: best };
}
export function overlapReranker(query, cands) {
  const q = [...new Set(tokenize(query))]; if (!q.length) return cands;
  const df = new Map(); for (const c of cands) for (const t of new Set(tokenize(c.chunk.text))) df.set(t, (df.get(t) || 0) + 1);
  const weight = (t) => 1 + Math.log(1 + cands.length / (df.get(t) || 0.5));
  const total = q.reduce((a, t) => a + weight(t), 0);
  const scored = cands.map((c) => {
    const toks = tokenize(c.chunk.text), set = new Set(toks); let cover = 0; for (const t of q) if (set.has(t)) cover += weight(t);
    const w = minWindow(toks, new Set(q)); const prox = w.matched > 1 ? w.matched / Math.max(w.matched, w.span / 2.5) : 0.4; // how tightly the question's words sit together
    return { chunk: c.chunk, score: c.score * (0.6 + cover / total) * (0.7 + 0.6 * prox) };
  }).sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of scored) { const words = new Set(tokenize(c.chunk.text)); const dup = kept.some((k) => { const kw = new Set(tokenize(k.chunk.text)); let inter = 0; for (const w of words) if (kw.has(w)) inter++; return inter / Math.max(1, Math.min(words.size, kw.size)) > 0.9; }); kept.push(dup ? Object.assign({}, c, { score: c.score * 0.5 }) : c); }
  return kept.sort((a, b) => b.score - a.score);
}

// ── context selection ─────────────────────────────────────────────────────────────────────────────────────────────
// Takes the best passages until the character budget is used, at most maxPerSource from one source, and labels each with its
// number, source and page so the answer can cite it.
export function selectContext(passages, opts = {}) {
  const budget = opts.budgetChars || 9000, maxPer = opts.maxPerSource || 6, per = new Map(), out = []; let used = 0;
  for (const p of passages) {
    const s = p.meta && p.meta.source || "document"; if ((per.get(s) || 0) >= maxPer) continue;
    const label = "[" + (out.length + 1) + "] (" + s + (p.meta && p.meta.page ? ", page " + p.meta.page : "") + ")";
    const body = p.text.length > budget - used ? p.text.slice(0, Math.max(0, budget - used)) : p.text;
    if (!body.trim() || used + body.length > budget) break;
    out.push({ n: out.length + 1, id: p.id, label, text: body, meta: p.meta }); used += body.length + label.length; per.set(s, (per.get(s) || 0) + 1);
  }
  return { passages: out, text: out.map((p) => p.label + "\n" + p.text).join("\n\n"), chars: used };
}
export const RAG_ANSWER_RULES = "Answer ONLY from the numbered passages below. After every factual sentence put the number of the passage it came from, like [2]. If the passages do not contain the answer, say so plainly and do not guess. Quote figures, dates and names exactly as written.";

// ── citation verification ─────────────────────────────────────────────────────────────────────────────────────────
// Every [n] must point at a real passage, and the sentence carrying it must be supported by that passage: its numbers must appear
// there and most of its distinctive words must too. Sentences with figures but no citation are reported.
export function verifyCitations(answer, passages) {
  const problems = [], byN = new Map(passages.map((p) => [p.n, p]));
  const sentences = String(answer || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).filter(Boolean);
  let cited = 0, supported = 0;
  for (const s of sentences) {
    const refs = [...s.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1]));
    const plain = s.replace(/\[\d+\]/g, " ");
    const nums = (plain.replace(/(\d),(?=\d{3})/g, "$1").match(/\d+(?:\.\d+)?/g) || []).filter((n) => n.replace(".", "").length >= 2);
    if (!refs.length) { if (nums.length) problems.push({ sentence: s.slice(0, 120), reason: "a figure is stated without a citation" }); continue; }
    for (const n of refs) {
      cited++;
      const p = byN.get(n); if (!p) { problems.push({ sentence: s.slice(0, 120), cite: n, reason: "cites a passage that does not exist" }); continue; }
      const hay = fold(p.text).replace(/(\d),(?=\d{3})/g, "$1"), hayTok = new Set(tokenize(p.text));
      const missingNums = nums.filter((x) => !hay.includes(x));
      const words = [...new Set(tokenize(plain))].filter((w) => w.length > 3 && !/^\d/.test(w)); const hit = words.filter((w) => hayTok.has(w)).length;
      if (missingNums.length) problems.push({ sentence: s.slice(0, 120), cite: n, reason: "figure " + missingNums[0] + " is not in passage [" + n + "]" });
      else if (words.length >= 3 && hit / words.length < 0.4) problems.push({ sentence: s.slice(0, 120), cite: n, reason: "the sentence does not match passage [" + n + "]" });
      else supported++;
    }
  }
  return { ok: problems.length === 0, cited, supported, problems };
}
