// NORIA WEB READ — a genuine read-only research capability: fetch ONE page, safely, and return its text with provenance.
//
//   request -> validate the address (scheme, literal IP, DNS-resolved IP, port) -> fetch with limits -> validate each redirect the same way ->
//   check content-type and size -> extract text -> STRUCTURAL: the result is DATA, nothing else -> classify source authority -> return with evidence
//
// SSRF / PRIVATE-NETWORK PROTECTION. A URL is attacker-shaped input: the hostname may be a literal IP written in an obfuscated form (decimal, hex,
// octal, IPv4-mapped IPv6), or a PUBLIC domain that resolves to a PRIVATE address (DNS rebinding: e.g. "localtest.me" -> 127.0.0.1, or a
// wildcard-DNS service like nip.io that resolves whatever IP is embedded in the hostname). Blocking the hostname string is not enough. This module
// resolves the address itself (DNS-over-HTTPS, injected so it is testable) and checks the ACTUAL IP before ever connecting, and does the same for
// every redirect hop, not just the first request. Ports outside 80/443 are refused (classic SSRF targets other services: databases, caches, admin panels).
//
// STRUCTURAL RULE (the same one as the code sandbox). A fetched page is UNTRUSTED DATA. There is exactly one channel out of this module ("text",
// alongside "title" and metadata) and it carries no authority: nothing downstream ever reads a field like "tool", "approved", "plan" or "grants" out
// of page text and acts on it, whatever the page says. Instruction-like text is also stripped as an ADDITIONAL, non-load-bearing defence.

const S = 1000, M = 60 * S;
export const LIMITS = { timeoutMs: 12000, maxRedirects: 5, maxBytes: 3 * 1024 * 1024, maxTextChars: 20000, maxTitleChars: 300, dnsTimeoutMs: 3000, freshnessMs: 30 * M };
export const ALLOWED_CONTENT_TYPES = /^(text\/html|text\/plain|application\/xhtml\+xml|application\/json|text\/json)\b/i;
export const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set(["", "80", "443"]);
const HOST_DENYLIST = /(?:^|\.)(?:localhost|local|internal|intranet|corp|home|lan|invalid|onion)$/i;

// ── IPv4 / IPv6 literal parsing, including obfuscated forms an attacker might use to hide a private address in plain sight ──────────────────────────
// "127.0.0.1", "2130706433" (decimal), "0x7f000001" (hex), "017700000001" (octal), "127.1" (short form) all mean the same address.
export function parseIPv4Literal(host) {
  if (/^(?:0|[1-9]\d*)$/.test(host)) { const n = Number(host); if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null; return [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255]; } // decimal only: a LEADING ZERO on a multi-digit token is octal (inet_aton semantics), handled below
  if (/^0x[0-9a-f]+$/i.test(host)) { const n = Number(host); if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null; return [n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255]; }
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4 || !parts.every((p) => /^(?:0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(p))) return null;
  const nums = parts.map((p) => (/^0x/i.test(p) ? parseInt(p, 16) : /^0[0-7]+$/.test(p) ? parseInt(p, 8) : parseInt(p, 10)));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (nums.length === 4) return nums.every((n) => n <= 255) ? nums : null;
  if (nums.length === 1) return nums[0] <= 0xffffffff ? [nums[0] >>> 24 & 255, nums[0] >>> 16 & 255, nums[0] >>> 8 & 255, nums[0] & 255] : null;
  const last = nums[nums.length - 1], head = nums.slice(0, -1);
  if (!head.every((n) => n <= 255)) return null;
  const bits = 32 - head.length * 8; if (last < 0 || last > (2 ** bits - 1)) return null;
  const out = [...head]; // fill the remaining bytes big-endian from `last` (e.g. "127.1" -> [127, 0, 0, 1]; "10.0.1" -> [10, 0, 0, 1])
  for (let i = head.length; i < 4; i++) { const shift = (3 - i) * 8; out[i] = (last >>> shift) & 255; }
  return out;
}
export function isPrivateIPv4(bytes) {
  const [a, b] = bytes;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared address space
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, INCLUDES the cloud metadata address 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && bytes[2] === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && bytes[2] === 2) return true; // documentation (TEST-NET-1)
  if (a === 192 && b === 88 && bytes[2] === 99) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && bytes[2] === 100) return true; // documentation (TEST-NET-2)
  if (a === 203 && b === 0 && bytes[2] === 113) return true; // documentation (TEST-NET-3)
  if (a >= 224) return true; // multicast (224+) and reserved (240+), including 255.255.255.255
  return false;
}
export function parseIPv6Literal(host) {
  let h = host.replace(/^\[|\]$/g, ""); if (!/^[0-9a-f:.]+$/i.test(h) || h.indexOf(":") === -1) return null;
  const zone = h.indexOf("%"); if (zone !== -1) h = h.slice(0, zone);
  let head = h, tail = "";
  const dbl = h.indexOf("::");
  if (dbl !== -1) { head = h.slice(0, dbl); tail = h.slice(dbl + 2); }
  const expand = (side) => side === "" ? [] : side.split(":");
  let headParts = expand(head), tailParts = expand(tail);
  // an embedded IPv4 tail ("::ffff:192.168.0.1")
  const v4 = (arr) => arr.length && arr[arr.length - 1].includes(".") ? { rest: arr.slice(0, -1), v4: parseIPv4Literal(arr[arr.length - 1]) } : { rest: arr, v4: null };
  const ht = v4(headParts), tt = v4(tailParts);
  headParts = ht.rest; tailParts = tt.rest; const embedded = ht.v4 || tt.v4;
  const toWords = (arr) => arr.map((p) => { if (!/^[0-9a-f]{1,4}$/i.test(p)) return null; return parseInt(p, 16); });
  const hw = toWords(headParts), tw = toWords(tailParts);
  if (hw.some((x) => x === null) || tw.some((x) => x === null)) return null;
  let words;
  if (dbl !== -1) { const fill = 8 - hw.length - tw.length - (embedded ? 2 : 0); if (fill < 0) return null; words = [...hw, ...Array(fill).fill(0), ...tw]; }
  else { words = hw; if (words.length !== 8 - (embedded ? 2 : 0)) return null; }
  if (embedded) words = [...words, (embedded[0] << 8) | embedded[1], (embedded[2] << 8) | embedded[3]];
  return words.length === 8 ? words : null;
}
export function isPrivateIPv6(words) {
  if (words.every((w) => w === 0)) return true; // ::
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true; // ::1 loopback
  if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((words[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (words[0] === 0x64 && words[1] === 0xff9b) return true; // NAT64 well-known prefix (often fronts private v4 space)
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): check the embedded address too
  if (words.slice(0, 5).every((w) => w === 0) && (words[5] === 0xffff || words[5] === 0)) { const b = [(words[6] >> 8) & 255, words[6] & 255, (words[7] >> 8) & 255, words[7] & 255]; return isPrivateIPv4(b); }
  return false;
}
// Is this literal address (v4 or v6, however written) private/reserved? Returns null if the string is not a literal IP at all (i.e. a real hostname).
export function literalIsPrivate(host) {
  const v6 = parseIPv6Literal(host); if (v6) return isPrivateIPv6(v6);
  const v4 = parseIPv4Literal(host); if (v4) return isPrivateIPv4(v4);
  return null;
}

// ── validating a URL and its port, before anything is fetched ──────────────────────────────────────────────────────────────────────────────────────
export function checkAddress(urlStr) {
  let u; try { u = new URL(urlStr); } catch (_) { return { ok: false, reason: "not a valid address" }; }
  if (!ALLOWED_SCHEMES.has(u.protocol)) return { ok: false, reason: "only http and https addresses can be read" };
  if (!ALLOWED_PORTS.has(u.port)) return { ok: false, reason: "only the standard web ports (80, 443) can be read" };
  if (u.username || u.password) return { ok: false, reason: "an address with a login embedded in it is refused" };
  const host = u.hostname.toLowerCase();
  if (HOST_DENYLIST.test(host)) return { ok: false, reason: "that address names a local or internal network, not the open web" };
  const lit = literalIsPrivate(host);
  if (lit === true) return { ok: false, reason: "that address is a private or reserved network address, not the open web" };
  return { ok: true, url: u, host, literal: lit === false };
}

// ── DNS-over-HTTPS pre-resolution: catches a PUBLIC hostname that resolves to a PRIVATE address (rebinding, wildcard-DNS-to-IP services) ────────────
// resolveDns(hostname, type) -> array of IP strings (injected so this is testable without the network; the real one queries Cloudflare's resolver).
export async function checkResolvedAddress(host, resolveDns, timeoutMs = LIMITS.dnsTimeoutMs) {
  const [a, aaaa] = await Promise.all([
    Promise.race([resolveDns(host, "A"), new Promise((_, rej) => setTimeout(() => rej(new Error("dns timeout")), timeoutMs))]).catch(() => null),
    Promise.race([resolveDns(host, "AAAA"), new Promise((_, rej) => setTimeout(() => rej(new Error("dns timeout")), timeoutMs))]).catch(() => null),
  ]);
  const ips = [...(a || []), ...(aaaa || [])];
  if (!ips.length) return { ok: false, reason: "the address did not resolve to anything" };
  for (const ip of ips) { const priv = literalIsPrivate(ip); if (priv) return { ok: false, reason: "that address resolves to a private or reserved network address (" + ip + "), not the open web" }; }
  return { ok: true, ips };
}

// ── HTML -> readable text (no script execution, ever: this only ever looks at text) ───────────────────────────────────────────────────────────────
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };
function decodeEntities(s) { return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z0-9]+);/gi, (m, e) => { if (e[0] === "#") { const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(cp) ? String.fromCodePoint(cp) : m; } return ENTITIES[e.toLowerCase()] || m; }); }
export function extractText(html, maxChars = LIMITS.maxTextChars) {
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleM ? decodeEntities(titleM[1].replace(/\s+/g, " ").trim()).slice(0, LIMITS.maxTitleChars) : "";
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  body = decodeEntities(body).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").replace(/[ \t]*\n[ \t]*/g, "\n").trim();
  const truncated = body.length > maxChars;
  return { title, text: truncated ? body.slice(0, maxChars) : body, truncated };
}

// ── reading one page, safely ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// deps: { fetchRaw(url, opts) -> Response-like (status, headers.get, body reader or text()), resolveDns(host, type) -> [ip,...], now }
// A refused or failed read throws (the tool layer turns this into a failed step); nothing here ever returns a value shaped like an instruction.
// Every code gets an honest 4xx status. NEVER 502/503/504 here: Cloudflare's edge intercepts those and replaces the body with its own generic
// error page, silently swallowing the real reason — verified empirically (a clean local JSON response for the same refusal came back as
// Cloudflare's bare "error code: 502" text in production once a real edge sat in front of it). A refused or failed read is a normal, expected
// outcome for a tool call, never a server crash, so it is reported as a 4xx the caller can actually read.
const WEB_READ_STATUS = { bad_request: 400, too_many_redirects: 400, address_refused: 403, unsupported_content_type: 415, too_large: 413, timeout: 424, fetch_failed: 424 };
export class WebReadError extends Error { constructor(code, message) { super(message); this.code = code; this.status = WEB_READ_STATUS[code] || (/^http_\d+$/.test(code) ? 424 : 400); } }
export async function readPage(rawUrl, deps, opts = {}) {
  const limits = { ...LIMITS, ...opts.limits };
  let target = String(rawUrl || "").trim();
  if (!target) throw new WebReadError("bad_request", "there is no address to read");
  if (target.length > 2000) throw new WebReadError("bad_request", "that address is too long");
  const redirectChain = [];
  for (let hop = 0; ; hop++) {
    if (hop > limits.maxRedirects) throw new WebReadError("too_many_redirects", "that address redirected more than " + limits.maxRedirects + " times");
    const check = checkAddress(target);
    if (!check.ok) throw new WebReadError("address_refused", check.reason);
    if (!check.literal) { const dns = await checkResolvedAddress(check.host, deps.resolveDns, limits.dnsTimeoutMs); if (!dns.ok) throw new WebReadError("address_refused", dns.reason); }
    redirectChain.push(target);
    const t0 = deps.now ? deps.now() : Date.now();
    const controller = deps.abortController ? deps.abortController() : (typeof AbortController !== "undefined" ? new AbortController() : null);
    const timer = controller ? setTimeout(() => controller.abort(), limits.timeoutMs) : null;
    let res;
    try { res = await deps.fetchRaw(check.url.href, { redirect: "manual", signal: controller && controller.signal, headers: { "User-Agent": deps.userAgent || "NoriaBot/1.0 (+https://noria.africa; read-only research; respects robots.txt)", "Accept": "text/html,application/xhtml+xml,text/plain,application/json;q=0.8" } }); }
    catch (e) { if (timer) clearTimeout(timer); if (e && e.name === "AbortError") throw new WebReadError("timeout", "the page did not answer within " + limits.timeoutMs + " ms"); throw new WebReadError("fetch_failed", "could not reach that address: " + String((e && e.message) || e).slice(0, 160)); }
    if (timer) clearTimeout(timer);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location"); if (!loc) throw new WebReadError("fetch_failed", "that address redirected without saying where to");
      target = new URL(loc, check.url).href; continue; // the NEXT loop iteration re-validates this new target from scratch, including DNS
    }
    if (res.status < 200 || res.status >= 300) throw new WebReadError("http_" + res.status, "the page answered with status " + res.status);
    const ct = String(res.headers.get("content-type") || "").split(";")[0].trim();
    if (!ALLOWED_CONTENT_TYPES.test(ct)) throw new WebReadError("unsupported_content_type", "that address is not a readable page (content type: " + (ct || "unknown") + ")");
    const lenHeader = Number(res.headers.get("content-length"));
    if (Number.isFinite(lenHeader) && lenHeader > limits.maxBytes) throw new WebReadError("too_large", "that page is larger than " + Math.round(limits.maxBytes / 1024 / 1024) + " MB");
    const raw = await deps.readBody(res, limits.maxBytes);
    const t1 = deps.now ? deps.now() : Date.now();
    const isJson = /json/i.test(ct);
    const parsed = isJson ? extractText("<pre>" + raw.text.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c])) + "</pre>", limits.maxTextChars) : extractText(raw.text, limits.maxTextChars);
    return {
      requested_url: rawUrl, final_url: check.url.href, redirects: redirectChain.length - 1, redirect_chain: redirectChain.slice(0, -1),
      title: parsed.title, text: parsed.text, truncated: parsed.truncated || raw.truncated, content_type: ct, bytes: raw.bytes,
      host: check.host, fetch_ms: t1 - t0, retrieved_at: t1,
    };
  }
}

// The tool handler: classifies the source's authority (reuses the reality layer, never a second classifier), runs the additional injection
// defence on the extracted text, and returns a plain-data shape with no field anything downstream would read as an instruction.
export function makeWebReadTool({ fetchRaw, resolveDns, readBody, sanitize, classifyUrl, now = () => Date.now(), userAgent } = {}) {
  return async function webRead(input) {
    const r = await readPage(input && input.url, { fetchRaw, resolveDns, readBody, now, userAgent });
    const cls = classifyUrl(r.final_url);
    const found = [];
    const text = sanitize ? sanitize(r.text, found) : r.text;
    const title = sanitize ? sanitize(r.title, found) : r.title;
    return {
      url: r.requested_url, final_url: r.final_url, redirects: r.redirects, title, text, truncated: r.truncated,
      content_type: r.content_type, bytes: r.bytes, retrieved_at: new Date(r.retrieved_at).toISOString(), fetch_ms: r.fetch_ms,
      authority: { level: cls.level, official: cls.official, host: cls.host }, injection_found: found.length,
      evidence: { source: r.host, url: r.final_url, retrieved_at: new Date(r.retrieved_at).toISOString(), authority_level: cls.level, redirected: r.redirects > 0 },
    };
  };
}
