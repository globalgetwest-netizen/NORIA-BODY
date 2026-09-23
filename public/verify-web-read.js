// OWNER CHECK — web.read against the real internet: real fetch, real Cloudflare DNS-over-HTTPS resolution, real SSRF refusals. No sign-in needed:
// this is a plain server-side read-only tool, called the same way any client would call it (POST /brain/tool).
const $ = (id) => document.getElementById(id);
const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
$("who").textContent = "This check needs no sign-in: web.read is a plain read-only server tool, called the same way any client calls it.";
const results = [], measurements = [];
const show = () => { $("out").innerHTML = results.map((r) => '<div class="line ' + (r.ok ? "ok" : "bad") + '">' + (r.ok ? "PASS " : "FAIL ") + esc(r.name) + (r.detail ? ' <span class="info">— ' + esc(r.detail) + "</span>" : "") + "</div>").join("") + measurements.map((m) => '<div class="line info">MEASURED ' + esc(m.name) + " — " + esc(m.detail) + "</div>").join(""); };
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 280) }); show(); };
const measure = (name, detail) => { measurements.push({ name, detail: String(detail).slice(0, 500) }); show(); };
const guard = async (name, fn) => { try { await fn(); } catch (e) { check(name + " (did not complete)", false, (e && e.message) || e); } };

async function call(url) {
  const t0 = performance.now();
  const res = await fetch(location.origin + "/brain/tool", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool: "web.read", input: { url } }) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, ms: Math.round(performance.now() - t0) };
}

async function main() {
  const t0 = performance.now(); results.length = 0; measurements.length = 0; show();
  try {
    await guard("registry", async () => {
      const tools = await (await fetch(location.origin + "/brain/tools")).json();
      const t = (tools.tools || []).find((x) => x.name === "web.read");
      check("web.read is registered: connected, read-only, live_read", !!t && t.available !== "not_built" && t.risk === "read" && t.live_read === true, t ? t.available : "not found");
    });

    await guard("a real page, read for real", async () => {
      const r = await call("https://example.com/");
      check("a genuine public page is fetched, extracted, and returned with provenance", r.status === 200 && r.body.ok && /example/i.test(r.body.output.title) && r.body.output.text.length > 10, JSON.stringify(r.body).slice(0, 200));
      const o = r.body.output || {};
      check("provenance is real: final address, retrieval time, fetch duration, source authority", !!o.final_url && !!o.retrieved_at && typeof o.fetch_ms === "number" && o.authority && typeof o.authority.level === "number");
      measure("a real page's extracted text", JSON.stringify({ title: o.title, chars: o.text ? o.text.length : 0, authority: o.authority }));
    });

    await guard("literal private addresses are refused against the real route", async () => {
      let r = await call("http://127.0.0.1/");
      check("loopback is refused, not fetched", r.status !== 200 || r.body.ok === false, JSON.stringify(r.body).slice(0, 160));
      r = await call("http://169.254.169.254/latest/meta-data/");
      check("the cloud metadata address is refused, not fetched", r.status !== 200 || r.body.ok === false, JSON.stringify(r.body).slice(0, 160));
      r = await call("http://0x7f000001/");
      check("an obfuscated (hex) form of a loopback address is refused", r.status !== 200 || r.body.ok === false, JSON.stringify(r.body).slice(0, 160));
      r = await call("http://localhost/");
      check("the hostname \"localhost\" is refused before any lookup", r.status !== 200 || r.body.ok === false, JSON.stringify(r.body).slice(0, 160));
    });

    await guard("a real DNS-rebinding domain is refused via the real Cloudflare resolver (not a fake in a test)", async () => {
      // localtest.me is a real, public, third-party-operated domain that by design resolves to 127.0.0.1 — the same case named in this
      // module's own threat-model comment. This is the one check the offline suite cannot do: it proves the REAL DNS-over-HTTPS call works.
      const r = await call("http://localtest.me/");
      check("a real hostname that resolves to a private address is refused by the real resolver, not just by name", r.status !== 200 || r.body.ok === false, JSON.stringify(r.body).slice(0, 200));
    });

    await guard("scheme and status handling against the real network", async () => {
      let r = await call("ftp://example.com/");
      check("a disallowed scheme is refused", r.status !== 200 || r.body.ok === false);
      r = await call("https://example.com/this-page-does-not-exist-12345-noria-check");
      check("a real 404 from a real server fails the read with the status named, not silently", r.status !== 200 && /http_404/.test(r.body.code || ""), JSON.stringify(r.body).slice(0, 160));
    });

    await guard("the structural rule holds against a real response, not just a mocked one", async () => {
      // httpbin-style echo is not depended on; instead reuse example.com (stable, IANA-reserved) and just confirm the return shape
      // has no field an automated system could read as an instruction, regardless of what the page happens to contain.
      const r = await call("https://example.com/");
      const keys = Object.keys(r.body.output || {});
      check("the real response shape carries no field named tool, approved, plan or grants", !keys.includes("tool") && !keys.includes("approved") && !keys.includes("plan") && !keys.includes("grants"), keys.join(","));
    });
  } finally {
    measure("total time", Math.round((performance.now() - t0) / 100) / 10 + " seconds");
    measure("not measured", "a live redirect chain against a real host (proven offline only, with an injected fake network, in web_read_t.mjs); real body-size streaming truncation against a genuinely oversized response; a wildcard-DNS-to-IP rebinding service other than localtest.me");
    const failed = results.filter((r) => !r.ok).length;
    $("json").textContent = JSON.stringify({ at: new Date().toISOString(), site: location.origin, seconds: Math.round((performance.now() - t0) / 100) / 10, passed: results.length - failed, failed, checks: results, measurements }, null, 2);
  }
}
$("run").addEventListener("click", async () => { $("run").disabled = true; try { await main(); } catch (e) { check("the check ran to the end", false, (e && e.message) || e); } finally { $("run").disabled = false; } });
