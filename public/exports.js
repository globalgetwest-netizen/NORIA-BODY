/**
 * NORIA EXPORTS — turns a finished document (Markdown) into real Word, Excel and PowerPoint files.
 *
 * Everything runs on the person's device: no server, no cost, and the document never leaves the browser. The three
 * builders take the file libraries as an argument (docx, ExcelJS, PptxGenJS), so the very same code is tested in Node
 * against independent readers (python-docx, openpyxl, python-pptx) before it is used in the app.
 *
 * mdToBlocks() reads the Markdown once; every builder works from those blocks:
 *   { type: 'h', level, runs } | { type: 'p', runs } | { type: 'list', ordered, items: [{ level, runs }] }
 *   { type: 'table', header: [runs], rows: [[runs]] } | { type: 'code', text } | { type: 'hr' }
 * runs = [{ text, bold?, italic?, code?, link? }]
 */

// ── Markdown → blocks ──────────────────────────────────────────────────────────────────────────────────────────────
export function parseInline(src) {
  const runs = []
  let s = String(src == null ? '' : src)
  const push = (text, fmt) => { if (text) runs.push(Object.assign({ text }, fmt || {})) }
  // tokens: `code`, [text](url), **bold**, __bold__, *italic*, _italic_
  const rx = /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*\n]+?\*\*)|(__[^_\n]+?__)|(\*[^*\s][^*\n]*?\*)|(_[^_\s][^_\n]*?_)/g
  let last = 0, m
  while ((m = rx.exec(s))) {
    if (m.index > last) push(s.slice(last, m.index))
    const t = m[0]
    if (m[1]) push(t.slice(1, -1), { code: true })
    else if (m[2]) { const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t); push(mm[1], { link: mm[2] }) }
    else if (m[3] || m[4]) { for (const r of parseInline(t.slice(2, -2))) runs.push(Object.assign({}, r, { bold: true })) }
    else { for (const r of parseInline(t.slice(1, -1))) runs.push(Object.assign({}, r, { italic: true })) }
    last = m.index + t.length
  }
  if (last < s.length) push(s.slice(last))
  return runs
}
const plain = (runs) => runs.map((r) => r.text).join('')

export function mdToBlocks(md) {
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-') && l.includes('|')
  const splitRow = (l) => {
    let t = l.trim(); if (t.startsWith('|')) t = t.slice(1); if (t.endsWith('|')) t = t.slice(0, -1)
    return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
  }
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    let m
    if ((m = /^```/.exec(line))) { // fenced code
      const code = []; i++
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++])
      i++; blocks.push({ type: 'code', text: code.join('\n') }); continue
    }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) { blocks.push({ type: 'h', level: Math.min(m[1].length, 4), runs: parseInline(m[2]) }); i++; continue }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { blocks.push({ type: 'hr' }); i++; continue }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) { // GFM table
      const header = splitRow(line).map(parseInline); i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i]).map(parseInline)); i++ }
      const n = header.length
      blocks.push({ type: 'table', header, rows: rows.map((r) => { const o = r.slice(0, n); while (o.length < n) o.push([]); return o }) }); continue
    }
    if (/^\s*([-*+•]|\d+[.)])\s+/.test(line)) { // list (one block per consecutive run of items)
      const ordered = /^\s*\d+[.)]\s+/.test(line), items = []
      while (i < lines.length && /^\s*([-*+•]|\d+[.)])\s+/.test(lines[i])) {
        const mm = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(lines[i])
        items.push({ level: Math.min(2, Math.floor(mm[1].replace(/\t/g, '  ').length / 2)), runs: parseInline(mm[3]) }); i++
      }
      blocks.push({ type: 'list', ordered, items }); continue
    }
    if (/^>\s?/.test(line)) { // quote → paragraph (italic)
      const q = []; while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''))
      blocks.push({ type: 'p', quote: true, runs: parseInline(q.join(' ')) }); continue
    }
    const para = [line.trim()]; i++
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>\s?|\s*([-*+•]|\d+[.)])\s+)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) para.push(lines[i++].trim())
    blocks.push({ type: 'p', runs: parseInline(para.join(' ')) })
  }
  return blocks
}
export const hasTables = (blocks) => blocks.some((b) => b.type === 'table')

const NAVY = '0B1F3A', GOLD = 'B0812A', INK = '222222', GREY = '6B7280', LIGHT = 'F3F1EA'

// ── Word (.docx) ───────────────────────────────────────────────────────────────────────────────────────────────────
export async function buildDocx(blocks, title, lib, opts = {}) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
    AlignmentType, LevelFormat, Footer, PageNumber, ExternalHyperlink } = lib
  const run = (r, base = {}) => {
    const o = Object.assign({ font: 'Calibri', size: 22, color: INK }, base, r.bold ? { bold: true } : {}, r.italic ? { italics: true } : {})
    if (r.code) Object.assign(o, { font: 'Consolas', size: 20, shading: { type: ShadingType.CLEAR, fill: 'EEEEEE', color: 'auto' } })
    if (r.link && /^https?:\/\//i.test(r.link)) return new ExternalHyperlink({ link: r.link, children: [new TextRun(Object.assign(o, { color: '1D4ED8', underline: {} }, { text: r.text }))] })
    return new TextRun(Object.assign(o, { text: r.text }))
  }
  const runs = (rs, base) => (rs.length ? rs.map((r) => run(r, base)) : [new TextRun({ text: '', font: 'Calibri', size: 22 })])
  const HL = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4]
  const HSIZE = [40, 30, 26, 23], HCOLOR = [NAVY, '12325A', GOLD, INK]
  const children = []
  const firstIsTitle = blocks[0] && blocks[0].type === 'h' && blocks[0].level === 1 && plain(blocks[0].runs).trim().toLowerCase() === String(title || '').trim().toLowerCase()
  if (title && !firstIsTitle) children.push(new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 240 }, children: [new TextRun({ text: title, font: 'Calibri', size: 52, bold: true, color: NAVY })] }))
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC' }
  const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border }
  for (const b of blocks) {
    if (b.type === 'h') {
      children.push(new Paragraph({ heading: HL[b.level - 1], keepNext: true, spacing: { before: b.level === 1 ? 360 : 260, after: 120 },
        children: runs(b.runs, { size: HSIZE[b.level - 1], bold: true, color: HCOLOR[b.level - 1] }) }))
    } else if (b.type === 'p') {
      children.push(new Paragraph({ spacing: { after: 140, line: 300 }, indent: b.quote ? { left: 480 } : undefined,
        children: runs(b.runs, b.quote ? { italics: true, color: GREY } : {}) }))
    } else if (b.type === 'list') {
      for (const it of b.items) children.push(new Paragraph({ numbering: { reference: b.ordered ? 'noria-num' : 'noria-bul', level: it.level }, spacing: { after: 80, line: 280 }, children: runs(it.runs) }))
      children.push(new Paragraph({ spacing: { after: 60 }, children: [] }))
    } else if (b.type === 'code') {
      for (const ln of b.text.split('\n')) children.push(new Paragraph({ spacing: { after: 0 }, shading: { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' }, children: [new TextRun({ text: ln || ' ', font: 'Consolas', size: 19 })] }))
      children.push(new Paragraph({ spacing: { after: 140 }, children: [] }))
    } else if (b.type === 'hr') {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } }, spacing: { after: 160 }, children: [] }))
    } else if (b.type === 'table') {
      const n = b.header.length, total = 9026, w = Math.floor(total / n)
      const cell = (rs, head) => new TableCell({
        width: { size: w, type: WidthType.DXA },
        margins: { top: 70, bottom: 70, left: 110, right: 110 },
        shading: head ? { type: ShadingType.CLEAR, fill: NAVY, color: 'auto' } : undefined,
        children: [new Paragraph({ children: runs(rs, head ? { bold: true, color: 'FFFFFF', size: 20 } : { size: 20 }) })],
      })
      children.push(new Table({ width: { size: total, type: WidthType.DXA }, columnWidths: Array(n).fill(w), borders,
        rows: [new TableRow({ tableHeader: true, cantSplit: true, children: b.header.map((h) => cell(h, true)) })]
          .concat(b.rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((c) => { const tc = cell(c, false); return tc }) }))) }))
      children.push(new Paragraph({ spacing: { after: 160 }, children: [] }))
    }
  }
  const bullets = [0, 1, 2].map((lv) => ({ level: lv, format: LevelFormat.BULLET, text: ['•', '–', '·'][lv], alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540 + lv * 360, hanging: 270 } } } }))
  const numbers = [0, 1, 2].map((lv) => ({ level: lv, format: LevelFormat.DECIMAL, text: '%' + (lv + 1) + '.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540 + lv * 360, hanging: 360 } } } }))
  const doc = new Document({
    creator: 'Noria', title: title || 'Document',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: { config: [{ reference: 'noria-bul', levels: bullets }, { reference: 'noria-num', levels: numbers }] },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1300, bottom: 1200, left: 1440, right: 1440 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], font: 'Calibri', size: 18, color: GREY })] })] }) },
      children,
    }],
  })
  return opts.buffer ? Packer.toBuffer(doc) : Packer.toBlob(doc)
}

// ── Excel (.xlsx) ──────────────────────────────────────────────────────────────────────────────────────────────────
// Numbers stay numbers (so sums, charts and sorting work): "1,250.50" → 1250.5, "12%" → 0.12 with a percent format.
function cellValue(text) {
  const t = String(text).trim()
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) || /^-?\d+(\.\d+)?$/.test(t)) return { v: Number(t.replace(/,/g, '')), fmt: /\./.test(t) ? '#,##0.00' : '#,##0' }
  if (/^-?\d+(\.\d+)?\s?%$/.test(t)) return { v: Number(t.replace(/\s?%/, '')) / 100, fmt: '0.0%' }
  return { v: t }
}
export async function buildXlsx(blocks, title, lib, opts = {}) {
  const ExcelJS = lib
  const wb = new ExcelJS.Workbook(); wb.creator = 'Noria'; wb.created = new Date()
  const used = new Set()
  let heading = ''
  const name = (h, k) => {
    let n = String(h || 'Table ' + k).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Table ' + k
    let base = n, c = 2; while (used.has(n.toLowerCase())) n = base.slice(0, 26) + ' ' + c++
    used.add(n.toLowerCase()); return n
  }
  let k = 0
  for (const b of blocks) {
    if (b.type === 'h') { heading = plain(b.runs); continue }
    if (b.type !== 'table') continue
    k++
    const ws = wb.addWorksheet(name(heading, k), { views: [{ state: 'frozen', ySplit: 1 }] })
    const head = b.header.map(plain)
    ws.addRow(head)
    const hr = ws.getRow(1)
    hr.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri' }
    hr.alignment = { vertical: 'middle', wrapText: true }
    hr.height = 22
    hr.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + NAVY } } })
    const widths = head.map((h) => Math.min(60, Math.max(10, h.length + 4)))
    for (const r of b.rows) {
      const vals = r.map((c) => cellValue(plain(c)))
      const row = ws.addRow(vals.map((x) => x.v))
      vals.forEach((x, ci) => {
        const c = row.getCell(ci + 1)
        if (x.fmt) { c.numFmt = x.fmt; c.alignment = { horizontal: 'right' } } else c.alignment = { wrapText: true, vertical: 'top' }
        widths[ci] = Math.min(60, Math.max(widths[ci], String(x.v).length + 3))
      })
    }
    widths.forEach((w, ci) => { ws.getColumn(ci + 1).width = w })
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: head.length } }
  }
  if (!k) { const ws = wb.addWorksheet('Document'); ws.getColumn(1).width = 100; for (const b of blocks) if (b.runs) ws.addRow([plain(b.runs)]) }
  return opts.buffer ? wb.xlsx.writeBuffer() : new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

// ── PowerPoint (.pptx) ─────────────────────────────────────────────────────────────────────────────────────────────
// One idea per slide, sized so nothing overflows: long sections continue on a following slide instead of shrinking.
export async function buildPptx(blocks, title, lib, opts = {}) {
  const PptxGenJS = lib
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE' // 13.33 x 7.5 in
  pptx.author = 'Noria'; pptx.title = title || 'Presentation'
  const F = 'Calibri'
  const MAX_BUL = 6, MAX_CHARS = 620, TABLE_ROWS = 7
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  // title slide
  const s0 = pptx.addSlide(); s0.background = { color: NAVY }
  s0.addShape(pptx.ShapeType.rect, { x: 0.7, y: 3.55, w: 1.4, h: 0.06, fill: { color: GOLD }, line: { color: GOLD } })
  s0.addText(title || 'Presentation', { x: 0.7, y: 1.5, w: 11.9, h: 2, fontFace: F, fontSize: 40, bold: true, color: 'FFFFFF', valign: 'bottom', fit: 'shrink' })
  s0.addText(today, { x: 0.7, y: 3.8, w: 8, h: 0.5, fontFace: F, fontSize: 16, color: 'D8D2C0' })
  // sections
  const sections = []
  let cur = null
  for (const b of blocks) {
    if (b.type === 'h' && b.level <= 2) { cur = { title: plain(b.runs), items: [] }; sections.push(cur); continue }
    if (!cur) { cur = { title: title || 'Overview', items: [] }; sections.push(cur) }
    cur.items.push(b)
  }
  const bulletsOf = (items) => {
    const out = []
    for (const b of items) {
      if (b.type === 'h') out.push({ text: plain(b.runs), head: true })
      else if (b.type === 'list') for (const it of b.items) out.push({ text: plain(it.runs), level: it.level })
      else if (b.type === 'p') { // a paragraph becomes sentence bullets
        const sents = plain(b.runs).match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [plain(b.runs)]
        for (const t of sents) if (t.trim()) out.push({ text: t.trim(), level: 0 })
      }
    }
    return out
  }
  const frame = (slide, heading, cont) => {
    slide.background = { color: 'FFFFFF' }
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.14, fill: { color: NAVY }, line: { color: NAVY } })
    slide.addText(heading + (cont ? (cont === 'table' ? ' — table' : ' (continued)') : ''), { x: 0.6, y: 0.4, w: 12.1, h: 0.9, fontFace: F, fontSize: 30, bold: true, color: NAVY, valign: 'middle', fit: 'shrink' })
    slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: 1.3, w: 1.1, h: 0.05, fill: { color: GOLD }, line: { color: GOLD } })
  }
  let n = 1
  const number = (slide) => { n++; slide.addText(String(n), { x: 12.2, y: 7.0, w: 0.6, h: 0.3, fontFace: F, fontSize: 11, color: GREY, align: 'right' }) }
  for (const sec of sections) {
    const tables = sec.items.filter((x) => x.type === 'table'), rest = sec.items.filter((x) => x.type !== 'table' && x.type !== 'code' && x.type !== 'hr')
    const bl = bulletsOf(rest)
    // bullet slides
    let chunk = [], chars = 0, first = true
    const flush = () => {
      if (!chunk.length) return
      const s = pptx.addSlide(); frame(s, sec.title, !first); first = false
      s.addText(chunk.map((c) => ({ text: c.text, options: c.head
        ? { bold: true, color: GOLD, fontSize: 20, breakLine: true, paraSpaceBefore: 8 }
        : { bullet: c.level ? { indent: 22 } : { indent: 20 }, indentLevel: c.level || 0, breakLine: true, paraSpaceAfter: 8, fontSize: c.level ? 18 : 20, color: INK } })),
      { x: 0.7, y: 1.6, w: 11.9, h: 5.2, fontFace: F, valign: 'top', fit: 'shrink' })
      number(s); chunk = []; chars = 0
    }
    for (const b of bl) {
      if (chunk.length >= MAX_BUL || chars + b.text.length > MAX_CHARS) flush()
      chunk.push(b); chars += b.text.length
    }
    flush()
    // table slides
    for (const t of tables) {
      const cols = t.header.length
      for (let at = 0; at < Math.max(1, t.rows.length); at += TABLE_ROWS) {
        const s = pptx.addSlide(); frame(s, sec.title, first ? false : (at === 0 ? 'table' : true)); first = false
        const rows = [t.header.map((h) => ({ text: plain(h), options: { bold: true, color: 'FFFFFF', fill: { color: NAVY }, fontFace: F, fontSize: 15 } }))]
        for (const r of t.rows.slice(at, at + TABLE_ROWS)) rows.push(r.map((c) => ({ text: plain(c), options: { color: INK, fontFace: F, fontSize: 14, fill: { color: (rows.length % 2) ? 'FFFFFF' : LIGHT } } })))
        s.addTable(rows, { x: 0.7, y: 1.7, w: 11.9, colW: Array(cols).fill(11.9 / cols), border: { type: 'solid', pt: 0.5, color: 'CCCCCC' }, valign: 'middle', margin: [0.06, 0.1, 0.06, 0.1] })
        number(s)
      }
    }
  }
  if (sections.length === 0) { const s = pptx.addSlide(); frame(s, title || 'Overview'); number(s) }
  if (opts.buffer) return pptx.write({ outputType: 'nodebuffer' })
  const blob = await pptx.write({ outputType: 'blob' })
  return new Blob([blob], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
}
