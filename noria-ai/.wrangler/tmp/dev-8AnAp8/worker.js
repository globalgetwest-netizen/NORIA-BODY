var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
var worker_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/vision" && request.method === "POST") {
        const prompt = url.searchParams.get("prompt") || "Describe this image in detail: any visible text (read it exactly), objects, people, setting, colors, and notable details.";
        const buf = await request.arrayBuffer();
        const out = await env.AI.run("@cf/llava-hf/llava-1.5-7b-hf", {
          image: [...new Uint8Array(buf)],
          prompt,
          max_tokens: 512
        });
        const text = out && (out.description || out.response || out.text) || "";
        return json({ text });
      }
      if (url.pathname === "/image" && (request.method === "POST" || request.method === "GET")) {
        let prompt = url.searchParams.get("prompt") || "";
        if (!prompt && request.method === "POST") {
          try {
            prompt = (await request.json()).prompt || "";
          } catch {
          }
        }
        if (!prompt) return json({ error: "no prompt" }, 400);
        const img = await env.AI.run("@cf/stabilityai/stable-diffusion-xl-base-1.0", { prompt });
        return new Response(img, { headers: { ...CORS, "Content-Type": "image/png", "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/tts" && (request.method === "POST" || request.method === "GET")) {
        let text = url.searchParams.get("text") || "";
        const lang = url.searchParams.get("lang") || "en";
        if (!text && request.method === "POST") {
          try {
            text = (await request.json()).text || "";
          } catch {
          }
        }
        text = (text || "").trim();
        if (!text) return json({ error: "no text" }, 400);
        const speaker = url.searchParams.get("speaker") || "hera";
        let lastErr = "";
        const AUDIO_MP3 = { ...CORS, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" };
        const dgKeys = String(env.DEEPGRAM_KEY || "").split(",").map((s) => s.trim()).filter(Boolean);
        if (dgKeys.length) {
          const model = env.DEEPGRAM_MODEL || (speaker === "orion" ? "aura-orion-en" : "aura-hera-en");
          const start = Math.floor(Math.random() * dgKeys.length);
          for (let n = 0; n < dgKeys.length; n++) {
            const key = dgKeys[(start + n) % dgKeys.length];
            try {
              const dg = await fetch("https://api.deepgram.com/v1/speak?model=" + model + "&encoding=mp3", {
                method: "POST",
                headers: { "Authorization": "Token " + key, "Content-Type": "application/json" },
                body: JSON.stringify({ text: text.slice(0, 1900) })
              });
              if (dg.ok && dg.body) return new Response(dg.body, { headers: AUDIO_MP3 });
              lastErr = "deepgram: " + dg.status + " " + (await dg.text().catch(() => "")).slice(0, 140);
            } catch (e) {
              lastErr = "deepgram: " + (e && e.message ? e.message : String(e));
            }
          }
        }
        try {
          const aura = await env.AI.run("@cf/deepgram/aura-1", { text: text.slice(0, 1800), speaker });
          const AUDIO = { ...CORS, "Content-Type": "audio/mpeg", "Cache-Control": "no-store" };
          if (aura instanceof ReadableStream) return new Response(aura, { headers: AUDIO });
          if (aura && aura.body) return new Response(aura.body, { headers: AUDIO });
          if (aura && aura.audio) {
            const by = Uint8Array.from(atob(aura.audio), (c) => c.charCodeAt(0));
            return new Response(by, { headers: AUDIO });
          }
        } catch (e) {
          lastErr = "aura: " + (e && e.message ? e.message : String(e));
        }
        const input = { prompt: text.slice(0, 900) };
        if (lang) input.lang = lang;
        let out = null;
        for (let i = 0; i < 4; i++) {
          try {
            out = await env.AI.run("@cf/myshell-ai/melotts", input);
            if (out && out.audio) break;
          } catch (e) {
            lastErr = "melo: " + (e && e.message ? e.message : String(e));
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        const b64 = out && out.audio || "";
        if (!b64) return json({ error: "tts failed: " + (lastErr || "no audio") }, 502);
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const isWav = bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70;
        return new Response(bytes, { headers: { ...CORS, "Content-Type": isWav ? "audio/wav" : "audio/mpeg", "Cache-Control": "no-store" } });
      }
      if (url.pathname === "/stt" && request.method === "POST") {
        const buf = await request.arrayBuffer();
        if (!buf.byteLength) return json({ error: "no audio" }, 400);
        if (buf.byteLength > 4 * 1024 * 1024) return json({ error: "audio too large" }, 413);
        const out = await env.AI.run("@cf/openai/whisper-large-v3-turbo", { audio: bytesToBase64(buf) });
        return json({ text: String(out && out.text || "").trim() });
      }
      if (url.pathname === "/auth/request" && request.method === "POST") {
        let b;
        try {
          b = await request.json();
        } catch {
          return json({ error: "bad request" }, 400);
        }
        const email = (b.email || "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Please enter a valid email." }, 400);
        const eh = await sha256("noria-user:" + email);
        if (await env.SYNC.get("rl:" + eh)) return json({ error: "Please wait a few seconds before requesting another code." }, 429);
        const code = String(Math.floor(1e5 + Math.random() * 9e5));
        await env.SYNC.put("code:" + eh, JSON.stringify({ code, tries: 0 }), { expirationTtl: 600 });
        await env.SYNC.put("rl:" + eh, "1", { expirationTtl: 60 });
        const sent = await sendLoginEmail(env, email, code);
        return json({ ok: true, sent, ...sent ? {} : { devCode: code } });
      }
      if (url.pathname === "/auth/verify" && request.method === "POST") {
        let b;
        try {
          b = await request.json();
        } catch {
          return json({ error: "bad request" }, 400);
        }
        const email = (b.email || "").trim().toLowerCase(), code = (b.code || "").trim();
        const eh = await sha256("noria-user:" + email);
        const rec = await env.SYNC.get("code:" + eh);
        if (!rec) return json({ error: "That code expired \u2014 request a new one." }, 400);
        const c = JSON.parse(rec);
        if (c.tries >= 5) {
          await env.SYNC.delete("code:" + eh);
          return json({ error: "Too many attempts \u2014 request a new code." }, 400);
        }
        if (c.code !== code) {
          c.tries++;
          await env.SYNC.put("code:" + eh, JSON.stringify(c), { expirationTtl: 600 });
          return json({ error: "Incorrect code." }, 400);
        }
        await env.SYNC.delete("code:" + eh);
        const tok = [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, "0")).join("");
        await env.SYNC.put("sess:" + tok, JSON.stringify({ email, eh }), { expirationTtl: 60 * 60 * 24 * 60 });
        let ur = await env.SYNC.get("user:" + eh);
        if (!ur) {
          ur = JSON.stringify({ email, pro: false, created: Date.now() });
          await env.SYNC.put("user:" + eh, ur);
        }
        return json({ ok: true, token: tok, email, pro: !!JSON.parse(ur).pro });
      }
      if (url.pathname === "/auth/me") {
        const t = url.searchParams.get("token") || "";
        const s = t && await env.SYNC.get("sess:" + t);
        if (!s) return json({ signedIn: false });
        const { email, eh } = JSON.parse(s);
        const ur = JSON.parse(await env.SYNC.get("user:" + eh) || '{"pro":false}');
        return json({ signedIn: true, email, pro: !!ur.pro });
      }
      if (url.pathname === "/auth/logout" && request.method === "POST") {
        let b;
        try {
          b = await request.json();
        } catch {
          b = {};
        }
        if (b.token) await env.SYNC.delete("sess:" + b.token);
        return json({ ok: true });
      }
      if (url.pathname === "/sync/get" && request.method === "GET") {
        const key = (url.searchParams.get("key") || "").trim();
        if (!/^[a-f0-9]{64}$/.test(key)) return json({ error: "bad key" }, 400);
        const v = await env.SYNC.get("u:" + key);
        return v ? new Response(v, { headers: { ...CORS, "Content-Type": "application/json" } }) : json({ found: false });
      }
      if (url.pathname === "/sync/put" && request.method === "POST") {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: "bad body" }, 400);
        }
        const key = (body.key || "").trim();
        if (!/^[a-f0-9]{64}$/.test(key)) return json({ error: "bad key" }, 400);
        if (typeof body.blob !== "string" || body.blob.length > 6e6) return json({ error: "bad blob" }, 400);
        await env.SYNC.put("u:" + key, JSON.stringify({ blob: body.blob, iv: body.iv || "", salt: body.salt || "", ts: Date.now(), v: 1 }));
        return json({ ok: true });
      }
      if (url.pathname === "/pro/check") {
        const code = (url.searchParams.get("code") || "").trim().toUpperCase();
        return json({ pro: await validCode(code, env.PRO_KEY) });
      }
      return new Response("Noria AI capability worker", { headers: CORS });
    } catch (e) {
      return json({ error: e && e.message ? e.message : String(e) }, 500);
    }
  },
  // Keep-warm: ping the Noria Body every 10 min so Render's free tier never
  // cold-starts (which is what made replies slow after idle).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetch("https://noria-body.onrender.com/brain/health").catch(() => {
    }));
  }
};
function bytesToBase64(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode.apply(null, b.subarray(i, i + 32768));
  return btoa(s);
}
__name(bytesToBase64, "bytesToBase64");
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
__name(json, "json");
async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
__name(sha256, "sha256");
async function sendLoginEmail(env, to, code) {
  const from = env.MAIL_FROM || "Noria <noria@skyglobegroup.com>";
  const subject = "Your Noria sign-in code";
  const text = `Your Noria sign-in code is ${code}. It expires in 10 minutes. If you didn't request this, ignore this email.`;
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:440px;margin:0 auto;padding:24px;color:#1A1712">
    <div style="font-weight:700;font-size:20px;margin-bottom:14px">\u2726 Noria</div>
    <p style="margin:0 0 8px;color:#7A7264">Your sign-in code:</p>
    <div style="font-size:30px;font-weight:800;letter-spacing:6px;color:#0B1F3A">${code}</div>
    <p style="margin:16px 0 0;color:#A79E8D;font-size:13px">It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
  </div>`;
  try {
    if (env.RESEND_KEY) {
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + env.RESEND_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ from, to, subject, text, html }) });
      return r.ok;
    }
    if (env.BREVO_KEY) {
      const m = from.match(/^(.*)<(.+)>$/);
      const sender = m ? { name: m[1].trim() || "Noria", email: m[2].trim() } : { name: "Noria", email: from };
      const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": env.BREVO_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text, htmlContent: html }) });
      return r.ok;
    }
  } catch {
  }
  return false;
}
__name(sendLoginEmail, "sendLoginEmail");
async function hmacHex(key, msg) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(hmacHex, "hmacHex");
async function validCode(code, key) {
  if (!key) return false;
  const m = code.match(/^NORIA-([A-Z0-9]{4,16})-([A-F0-9]{6})$/);
  if (!m) return false;
  const sig = await hmacHex(key, "NORIA-" + m[1]);
  return sig.slice(0, 6).toUpperCase() === m[2];
}
__name(validCode, "validCode");

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// .wrangler/tmp/bundle-Pp4x28/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default
];
var middleware_insertion_facade_default = worker_default;

// ../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-Pp4x28/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
