// NORIA SAFE CALCULATOR — arithmetic without eval.
// A small recursive-descent parser for numbers, + - * / × ÷ ^ **, parentheses, unary minus and a postfix % (15% = 0.15). Anything else
// (letters, calls, property access, assignment) is rejected, so no input can run code. Exact decimal display, division by zero refused.

const MAX_LEN = 160, MAX_DEPTH = 24;

export function safeCalc(input) {
  let s = String(input == null ? "" : input).trim();
  if (!s || s.length > MAX_LEN) return null;
  s = s.replace(/[×✕]/g, "*").replace(/[÷⁄]/g, "/").replace(/[−–—]/g, "-").replace(/\s+/g, "").replace(/\*\*/g, "^");
  s = s.replace(/(\d),(?=\d{3}(?!\d))/g, "$1"); // thousands separators: 2,480 -> 2480
  if (!/^[0-9+\-*/^().%]+$/.test(s)) return null;
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
    if (peek() === "(") { i++; v = expr(); if (peek() !== ")") fail(); i++; }
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
