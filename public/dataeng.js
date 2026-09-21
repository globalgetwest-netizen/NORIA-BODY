/**
 * NORIA DATA ENGINE — exact statistics on the person's own spreadsheet, computed on their device.
 *
 * A model asked to add up a column guesses; this engine reads every row and computes. It parses CSV / TSV / Excel tables, works
 * out each column's type, and answers questions such as "average of revenue by region", "how many rows where units > 10", "top 5
 * products by revenue", "correlation between price and units" straight from the data. Nothing is sent anywhere, and no model is
 * involved in the arithmetic. When a question is beyond it, the exact profile is handed to Noria as ground truth instead.
 */

// ── parsing ────────────────────────────────────────────────────────────────────────────────────────────────────────
export function parseDelimited(text) {
  let s = String(text || '').replace(/^﻿/, '')
  const first = s.split(/\r?\n/, 1)[0] || ''
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 }
  let q = false
  for (const ch of first) { if (ch === '"') q = !q; else if (!q && ch in counts) counts[ch]++ }
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0 ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] : ','
  const rows = []; let row = [], cell = '', inQ = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else inQ = false } else cell += c
    } else if (c === '"') inQ = true
    else if (c === delim) { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x !== '')) rows.push(row); row = [] }
    else cell += c
  }
  row.push(cell); if (row.some((x) => x !== '')) rows.push(row)
  return rows
}

const CURRENCY = /^[\s(]*[-+]?\s*(?:GH[₵S]|GHS|₵|NGN|₦|KES|KSh|UGX|TZS|ZAR|R|USD|US\$|\$|€|£|¥|CFA|XOF)?\s*/i
export function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  let s = String(v == null ? '' : v).trim()
  if (!s || /^(n\/?a|na|null|none|-|--|nan|#n\/a)$/i.test(s)) return null
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  s = s.replace(CURRENCY, (m) => { if (/-/.test(m)) neg = !neg; return '' }).replace(/\s+/g, '')
  let pct = false
  if (s.endsWith('%')) { pct = true; s = s.slice(0, -1) }
  if (!/^[\d.,]+$/.test(s)) return null
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',')
  if (lastDot >= 0 && lastComma >= 0) s = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.')
  else if (lastComma >= 0) s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.')
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '')
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return (neg ? -n : n) / (pct ? 1 : 1) // a percentage keeps its face value (12% → 12)
}
export function parseDate(v) {
  if (v instanceof Date) return v.getTime()
  const s = String(v == null ? '' : v).trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s)
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3])
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(s) // day first (the usual reading in Africa and Europe)
  if (m && +m[2] <= 12) return Date.UTC(+m[3], +m[2] - 1, +m[1])
  return null
}

// ── table ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export function buildTable(rawRows, name) {
  if (!rawRows || rawRows.length < 2) return null
  const width = Math.max(...rawRows.slice(0, 50).map((r) => r.length))
  let headers = rawRows[0].map((h, i) => String(h == null ? '' : h).trim() || 'Column ' + (i + 1))
  while (headers.length < width) headers.push('Column ' + (headers.length + 1))
  const seen = {}; headers = headers.map((h) => { seen[h] = (seen[h] || 0) + 1; return seen[h] > 1 ? h + ' (' + seen[h] + ')' : h })
  const body = rawRows.slice(1).map((r) => headers.map((_, i) => (r[i] == null ? '' : r[i])))
  const cols = headers.map((h, i) => {
    const vals = body.map((r) => r[i]), filled = vals.filter((v) => !(v === '' || v == null || /^\s*$/.test(String(v))))
    let nums = 0, dates = 0
    for (const v of filled) { if (parseNum(v) !== null) nums++; else if (parseDate(v) !== null) dates++ }
    const n = filled.length || 1
    const type = filled.length && nums / n >= 0.9 ? 'number' : filled.length && (dates + nums) / n >= 0.9 && dates > nums ? 'date' : 'text'
    return { name: h, type }
  })
  const data = body.map((r) => r.map((v, i) => (cols[i].type === 'number' ? parseNum(v) : cols[i].type === 'date' ? parseDate(v) : (v === '' || v == null ? null : String(v).trim()))))
  return { name: name || 'data', cols, rows: data }
}

// ── statistics (exact, with compensated summation) ────────────────────────────────────────────────────────────────
function ksum(a) { let s = 0, c = 0; for (const x of a) { const y = x - c, t = s + y; c = (t - s) - y; s = t } return s }
export function numStats(values) {
  const a = values.filter((x) => x !== null && x !== undefined && Number.isFinite(x)).sort((x, y) => x - y)
  const n = a.length
  if (!n) return { count: 0 }
  const sum = ksum(a), mean = sum / n
  const q = (p) => { const i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo) }
  const sd = n > 1 ? Math.sqrt(ksum(a.map((x) => (x - mean) ** 2)) / (n - 1)) : 0
  return { count: n, sum, mean, median: q(0.5), min: a[0], max: a[n - 1], q1: q(0.25), q3: q(0.75), sd }
}
export function correlation(xs, ys) {
  const p = []; for (let i = 0; i < xs.length; i++) if (Number.isFinite(xs[i]) && Number.isFinite(ys[i]) && xs[i] !== null && ys[i] !== null) p.push([xs[i], ys[i]])
  if (p.length < 3) return null
  const mx = ksum(p.map((r) => r[0])) / p.length, my = ksum(p.map((r) => r[1])) / p.length
  const sxy = ksum(p.map((r) => (r[0] - mx) * (r[1] - my))), sxx = ksum(p.map((r) => (r[0] - mx) ** 2)), syy = ksum(p.map((r) => (r[1] - my) ** 2))
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null
}
export const fmt = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Number(v.toFixed(d)).toLocaleString('en-US', { maximumFractionDigits: d }))
const fmtDate = (t) => new Date(t).toISOString().slice(0, 10)

// The exact profile handed to the model (and shown to the person): every column, every figure computed from every row.
export function profileMarkdown(t, sampleRows = 8) {
  const out = ['**' + t.name + '** — ' + t.rows.length.toLocaleString('en-US') + ' rows × ' + t.cols.length + ' columns', '']
  const numRows = [], textRows = []
  t.cols.forEach((c, i) => {
    const vals = t.rows.map((r) => r[i]), missing = vals.filter((v) => v === null).length
    if (c.type === 'number') { const s = numStats(vals); numRows.push('| ' + [c.name, fmt(s.count, 0), fmt(missing, 0), fmt(s.sum), fmt(s.mean), fmt(s.median), fmt(s.min), fmt(s.max), fmt(s.sd)].join(' | ') + ' |') }
    else if (c.type === 'date') { const d = vals.filter((v) => v !== null); textRows.push('| ' + [c.name, 'date', fmt(missing, 0), d.length ? fmtDate(Math.min(...d)) + ' to ' + fmtDate(Math.max(...d)) : '—'].join(' | ') + ' |') }
    else { const cnt = {}; for (const v of vals) if (v !== null) cnt[v] = (cnt[v] || 0) + 1; const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => k + ' (' + n + ')').join(', '); textRows.push('| ' + [c.name, 'text, ' + Object.keys(cnt).length + ' distinct', fmt(missing, 0), top || '—'].join(' | ') + ' |') }
  })
  if (numRows.length) out.push('**Numeric columns**', '', '| Column | Count | Missing | Sum | Mean | Median | Min | Max | Std dev |', '|---|---|---|---|---|---|---|---|---|', ...numRows, '')
  if (textRows.length) out.push('**Other columns**', '', '| Column | Type | Missing | Most common / range |', '|---|---|---|---|', ...textRows, '')
  if (sampleRows > 0) {
    out.push('**First rows**', '', '| ' + t.cols.map((c) => c.name).join(' | ') + ' |', '|' + t.cols.map(() => '---').join('|') + '|')
    for (const r of t.rows.slice(0, sampleRows)) out.push('| ' + r.map((v, i) => (v === null ? '' : t.cols[i].type === 'date' ? fmtDate(v) : String(v))).join(' | ') + ' |')
  }
  return out.join('\n')
}

// ── questions ──────────────────────────────────────────────────────────────────────────────────────────────────────
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
function findCol(t, phrase, want) {
  const p = norm(phrase).replace(/^(the|a|an|of|all|each|every)\s+/, '').replace(/\s+(column|field)$/, '')
  if (!p) return null
  const cands = t.cols.map((c, i) => ({ c, i, n: norm(c.name) })).filter((x) => !want || x.c.type === want || (want === 'group' && x.c.type !== 'date'))
  let hit = cands.find((x) => x.n === p) || cands.find((x) => x.n === p.replace(/s$/, '') || x.n.replace(/s$/, '') === p)
  if (hit) return hit
  const inc = cands.filter((x) => x.n.includes(p) || p.includes(x.n))
  if (inc.length === 1) return inc[0]
  if (inc.length > 1) return inc.sort((a, b) => a.n.length - b.n.length)[0]
  return null
}
const AGG = { average: 'mean', avg: 'mean', mean: 'mean', sum: 'sum', total: 'sum', maximum: 'max', max: 'max', highest: 'max', largest: 'max', biggest: 'max', minimum: 'min', min: 'min', lowest: 'min', smallest: 'min', median: 'median', count: 'count', 'standard deviation': 'sd', stdev: 'sd', 'std dev': 'sd' }
const AGGNAME = { mean: 'Average', sum: 'Total', max: 'Highest', min: 'Lowest', median: 'Median', count: 'Count', sd: 'Standard deviation' }
function passes(v, op, rhs) {
  if (v === null) return false
  if (typeof v === 'number') { const n = parseNum(rhs); if (n === null) return false; return op === '>' ? v > n : op === '<' ? v < n : op === '>=' ? v >= n : op === '<=' ? v <= n : op === '!=' ? v !== n : v === n }
  const a = String(v).toLowerCase(), b = String(rhs).toLowerCase().replace(/^["']|["']$/g, '')
  return op === '!=' ? a !== b : op === 'contains' ? a.includes(b) : a === b
}
function filterRows(t, cond) {
  if (!cond) return { rows: t.rows, note: '' }
  const m = /^(.+?)\s*(>=|<=|!=|>|<|=|==|is not|is|equals|contains|greater than|more than|above|over|less than|below|under|at least|at most)\s*(.+)$/i.exec(cond.trim())
  if (!m) return { error: true }
  const col = findCol(t, m[1]); if (!col) return { error: true }
  const opw = m[2].toLowerCase(), op = { '>=': '>=', '<=': '<=', '!=': '!=', '>': '>', '<': '<', '=': '=', '==': '=', 'is not': '!=', is: '=', equals: '=', contains: 'contains', 'greater than': '>', 'more than': '>', above: '>', over: '>', 'less than': '<', below: '<', under: '<', 'at least': '>=', 'at most': '<=' }[opw]
  return { rows: t.rows.filter((r) => passes(r[col.i], op, m[3])), note: ' where ' + col.c.name + ' ' + op + ' ' + m[3].trim() }
}
function mdTable(head, rows) { return '| ' + head.join(' | ') + ' |\n|' + head.map(() => '---').join('|') + '|\n' + rows.map((r) => '| ' + r.join(' | ') + ' |').join('\n') }

export function answerDataQuestion(q, tables) {
  const t = tables && tables[tables.length - 1]
  if (!t) return null
  const s = String(q || '').trim().replace(/[?!.]+$/, '')
  const low = s.toLowerCase()
  if (s.length > 200) return null
  let m
  if (/^(how many|what is the number of|number of|count (of )?the) (rows|records|entries|lines)(?: (?:are )?(?:there|in (?:the|this) (?:data|file|table|spreadsheet|dataset|sheet))|(?: does| do)? (?:it|the (?:data|file|table)) (?:have|has|contain)s?)?$|^how (big|large) is (the|this) (data|file|table|spreadsheet)$/.test(low)) return 'The table **' + t.name + '** has **' + t.rows.length.toLocaleString('en-US') + ' rows** and **' + t.cols.length + ' columns**.'
  if (/^(what|which|list( the)?|show( me)?( the)?) (are the )?(columns|fields|headers|column names)\b/.test(low)) return 'The columns in **' + t.name + '** are:\n\n' + t.cols.map((c) => '- **' + c.name + '** (' + c.type + ')').join('\n')
  if (/^(summari[sz]e|describe|profile|analy[sz]e|give me an overview of|overview of)\b.*\b(data|file|table|spreadsheet|dataset|csv|sheet)\b|^(summary|profile) of (the )?(data|file|table)/.test(low)) return profileMarkdown(t)
  if ((m = /^(?:how many )?(?:unique|distinct) (?:values )?(?:in|of|for) (.+)$/.exec(low)) || (m = /^how many (?:unique|distinct) (.+)$/.exec(low))) {
    const c = findCol(t, m[1]); if (!c) return null
    return 'The column **' + c.c.name + '** has **' + new Set(t.rows.map((r) => r[c.i]).filter((v) => v !== null)).size.toLocaleString('en-US') + '** distinct values.'
  }
  if ((m = /^(?:what is )?(?:the )?correlation (?:between|of) (.+?) and (.+)$/.exec(low))) {
    const a = findCol(t, m[1], 'number'), b = findCol(t, m[2], 'number'); if (!a || !b) return null
    const r = correlation(t.rows.map((x) => x[a.i]), t.rows.map((x) => x[b.i]))
    return r === null ? 'There are not enough rows with both **' + a.c.name + '** and **' + b.c.name + '** to compute a correlation.' : 'The correlation (Pearson r) between **' + a.c.name + '** and **' + b.c.name + '** is **' + fmt(r, 4) + '**' + (Math.abs(r) >= 0.7 ? ' (strong)' : Math.abs(r) >= 0.4 ? ' (moderate)' : ' (weak)') + '.'
  }
  if ((m = /^(?:show (?:me )?|list |what are )?(?:the )?top (\d+) (.+?) by (.+?)(?: where (.+))?$/.exec(low))) {
    const cat = findCol(t, m[2], 'group'), num = findCol(t, m[3], 'number'); if (!cat || !num) return null
    const f = filterRows(t, m[4]); if (f.error) return null
    const g = {}; for (const r of f.rows) { const k = r[cat.i]; if (k === null || r[num.i] === null) continue; g[k] = (g[k] || 0) + r[num.i] }
    const rows = Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, +m[1])
    return rows.length ? '**Top ' + rows.length + ' ' + cat.c.name + ' by total ' + num.c.name + f.note + '**\n\n' + mdTable([cat.c.name, 'Total ' + num.c.name], rows.map(([k, v]) => [k, fmt(v, 2)])) : null
  }
  if ((m = /^how many (?:rows|records|entries|customers|items|orders|people|products)?\s*(?:have|has|are|with|where)\s+(.+)$/.exec(low))) {
    const f = filterRows(t, m[1].replace(/^(a |an )?/, '')); if (f.error) return null
    return '**' + f.rows.length.toLocaleString('en-US') + '** of the ' + t.rows.length.toLocaleString('en-US') + ' rows match' + f.note + '.'
  }
  m = /^(?:what is |what's |what was |show |give me |calculate |compute |find )?(?:the )?(average|avg|mean|sum|total|maximum|max|highest|largest|biggest|minimum|min|lowest|smallest|median|standard deviation|std dev|stdev|count)(?: of| for| in)? (.+?)(?: (?:by|per|for each|grouped by|for every) (.+?))?(?: where (.+))?$/.exec(low)
  if (m) {
    const agg = AGG[m[1]]; const num = agg === 'count' ? (findCol(t, m[2]) || null) : findCol(t, m[2], 'number')
    if (!num) return null
    const f = filterRows(t, m[4]); if (f.error) return null
    const calc = (vals) => { const st = numStats(vals.filter((v) => v !== null)); return agg === 'count' ? st.count || vals.filter((v) => v !== null).length : st[agg] }
    if (m[3]) {
      const grp = findCol(t, m[3], 'group'); if (!grp) return null
      const g = {}; for (const r of f.rows) { const k = r[grp.i]; if (k === null) continue; (g[k] = g[k] || []).push(r[num.i]) }
      const rows = Object.entries(g).map(([k, vals]) => [k, calc(vals)]).sort((a, b) => (b[1] ?? -Infinity) - (a[1] ?? -Infinity))
      if (!rows.length) return null
      return '**' + AGGNAME[agg] + ' ' + num.c.name + ' by ' + grp.c.name + f.note + '**\n\n' + mdTable([grp.c.name, AGGNAME[agg] + ' ' + num.c.name], rows.slice(0, 40).map(([k, v]) => [k, fmt(v, agg === 'count' ? 0 : 2)])) + (rows.length > 40 ? '\n\n*(showing the first 40 of ' + rows.length + ' groups)*' : '')
    }
    const v = calc(f.rows.map((r) => r[num.i]))
    if (v === undefined || v === null) return null
    return '**' + AGGNAME[agg] + ' of ' + num.c.name + f.note + ':** **' + fmt(v, agg === 'count' ? 0 : 4) + '**' + (agg === 'mean' ? ' (from ' + numStats(f.rows.map((r) => r[num.i])).count.toLocaleString('en-US') + ' values)' : '')
  }
  return null
}

// ── files ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export function tableFromCSV(text, name) { return buildTable(parseDelimited(text), name) }
export async function tableFromXLSX(arrayBuffer, name, ExcelJS) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(arrayBuffer)
  const ws = wb.worksheets.find((w) => w.rowCount > 1) || wb.worksheets[0]
  if (!ws) return null
  const rows = []
  ws.eachRow({ includeEmpty: false }, (row) => {
    const vals = []; row.eachCell({ includeEmpty: true }, (cell, i) => {
      let v = cell.value
      if (v && typeof v === 'object' && !(v instanceof Date)) v = v.result !== undefined ? v.result : (v.text !== undefined ? v.text : (v.richText ? v.richText.map((x) => x.text).join('') : ''))
      vals[i - 1] = v instanceof Date ? v.toISOString().slice(0, 10) : v
    })
    rows.push(Array.from(vals, (v) => (v === undefined ? '' : v)))
  })
  return buildTable(rows, name + (wb.worksheets.length > 1 ? ' — ' + ws.name : ''))
}
