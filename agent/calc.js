// NORIA SAFE CALCULATOR — arithmetic without eval.
// A small recursive-descent parser for numbers, + - * / × ÷ ^ **, parentheses, unary minus, sqrt(...) and a postfix
// % (15% = 0.15). Anything else (letters other than the literal "sqrt", calls, property access, assignment) is
// rejected, so no input can run code. Exact decimal display, division by zero refused.
//
// sqrt ADDED (2026-10-01), Stage 4 of the owner's architecture direction: found while building the chat<->Executor
// bridge for calc.math that _worker.js's own mathBlock() used a SEPARATE, hand-rolled expression evaluator
// (calcEval) instead of this shared, registered, already-tested tool — because this one could not parse "square
// root of X" and that one could. Rather than keep two parallel implementations (exactly the duplication the owner
// asked to stop building), the capability gap is closed HERE, in the one shared tool, so both chat and any future
// agentic caller of calc.math get it for free. The only new grammar allowed is the exact literal token "sqrt"
// (case-insensitive) immediately followed by "(" — no other letters are ever accepted, so this adds no injection
// surface: "sqrt" alone does nothing without an eval, which this file has never had.

const MAX_LEN = 160, MAX_DEPTH = 24;

export function safeCalc(input) {
  let s = String(input == null ? "" : input).trim();
  if (!s || s.length > MAX_LEN) return null;
  s = s.replace(/[×✕]/g, "*").replace(/[÷⁄]/g, "/").replace(/[−–—]/g, "-").replace(/\s+/g, "").replace(/\*\*/g, "^");
  s = s.replace(/(\d),(?=\d{3}(?!\d))/g, "$1"); // thousands separators: 2,480 -> 2480
  if (!/^(?:[0-9+\-*/^().%]|sqrt)+$/i.test(s)) return null;
  let i = 0, depth = 0;
  const peek = () => s[i];
  const fail = () => { throw new Error("bad"); };
  function number() {
    const m = /^(?:\d+\.?\d*|\.\d+)/.exec(s.slice(i)); if (!m) fail();
    i += m[0].length; return parseFloat(m[0]);
  }
  function primary() {
    if (++depth > MAX_DEPTH) fail();
    let v;
    if (s.slice(i, i + 4).toLowerCase() === "sqrt" && s[i + 4] === "(") {
      i += 5; v = expr(); if (peek() !== ")") fail(); i++;
      if (v < 0) fail(); // no complex numbers
      v = Math.sqrt(v);
    }
    else if (peek() === "(") { i++; v = expr(); if (peek() !== ")") fail(); i++; }
    else if (peek() === "-") { i++; v = -power(); }
    else if (peek() === "+") { i++; v = power(); }
    else v = number();
    while (peek() === "%") { i++; v = v / 100; }
    depth--; return v;
  }
  function power() { const base = primary(); if (peek() === "^") { i++; const e = power(); const r = Math.pow(base, e); if (!isFinite(r)) fail(); return r; } return base; }
  function term() { let v = power(); while (peek() === "*" || peek() === "/") { const op = s[i++]; const r = power(); if (op === "/") { if (r === 0) throw new Error("division by zero"); v /= r; } else v *= r; } return v; }
  function expr() { let v = term(); while (peek() === "+" || peek() === "-") { const op = s[i++]; const r = term(); v = op === "+" ? v + r : v - r; } return v; }
  try {
    const v = expr();
    if (i !== s.length || !isFinite(v)) return null;
    const value = Math.round(v * 1e10) / 1e10;
    return { value, text: String(input).trim().replace(/\s+/g, " ") + " = " + value.toLocaleString("en-US", { maximumFractionDigits: 10 }) };
  } catch (e) { return e.message === "division by zero" ? { error: "division by zero" } : null; }
}
