// NORIA AUDIT LOG — append-only and tamper-evident.
// Every record carries the hash of the record before it (SHA-256 over the previous hash plus this record), so changing, removing or
// reordering any record breaks the chain and verify() says exactly where.

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class AuditLog {
  constructor() { this.records = []; this.last = "genesis"; this.queue = Promise.resolve(); }
  // ev: { event, plan, task, tool, decision, detail } (anything JSON-serialisable; never put secrets here)
  // Appends are queued one at a time: tasks running in parallel must not read the same "previous hash" before either finishes.
  append(ev) { const run = this.queue.then(() => this.write(ev)); this.queue = run.catch(() => {}); return run; }
  async write(ev) {
    const rec = Object.assign({ seq: this.records.length + 1, ts: new Date().toISOString() }, ev);
    rec.prev = this.last;
    rec.hash = await sha256(this.last + JSON.stringify(Object.assign({}, rec, { hash: undefined })));
    this.records.push(rec); this.last = rec.hash;
    return rec;
  }
  async verify(records = this.records) {
    let prev = "genesis";
    for (const r of records) {
      const want = await sha256(prev + JSON.stringify(Object.assign({}, r, { hash: undefined })));
      if (r.prev !== prev || r.hash !== want) return { ok: false, brokenAt: r.seq, records: records.length };
      prev = r.hash;
    }
    return { ok: true, records: records.length };
  }
  export() { return JSON.parse(JSON.stringify(this.records)); }
}
