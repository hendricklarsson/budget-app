// statement.js — makes the monthly PDF statement, with no library.
//
// A PDF is a text-like file made of numbered "objects" (pages, fonts, drawing
// instructions) plus a table saying where each object starts. This file
// writes one by hand:
//
//   1. LAYOUT: decide what goes where on each A4 page (in points; 72 = 1 inch).
//   2. DRAWING: each page gets a list of drawing instructions ("content stream").
//   3. TAGS: so screen readers can read it in order, every piece of text is
//      marked as part of a heading, paragraph or table cell ("tagged PDF").
//      Lines, boxes and the page footer are marked as decoration ("Artifact").
//   4. FILE: the objects are joined together with the byte positions table.
//
// It uses Helvetica, one of the 14 fonts every PDF reader has built in, so no
// font file is needed. Helvetica only covers Western European letters: any
// other character (Chinese, Tamil, emoji) is shown as "?".
//
// Used by app.js:  SenStatement.build({month, monthLabel, email, entries, generatedAt})
//   → {bytes, pages, fileName}

'use strict';

const SenStatement = (() => {
  const PAGE_W = 595.28;   // A4 width in points
  const PAGE_H = 841.89;   // A4 height in points
  const LEFT = 48;
  const RIGHT = PAGE_W - 48;
  const BOTTOM_LIMIT = PAGE_H - 78; // content stops here; the footer goes below

  const INK = [0.043, 0.051, 0.071];   // #0b0d12
  const MUTED = [0.337, 0.357, 0.4];   // #565b66
  const RULE = [0.82, 0.83, 0.85];

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                  'September', 'October', 'November', 'December'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const CATEGORIES = ['Food', 'Transport', 'Bills', 'Shopping', 'Health', 'Entertainment', 'Other'];

  // -------------------------------------------------------------------------
  // Text: measuring and encoding
  // -------------------------------------------------------------------------

  // Character widths (per 1000 units of font size) for codes 32–126, from
  // Adobe's published font metrics. Needed to right-align amounts and to
  // shorten long notes so they fit their column.
  const WIDTHS = {
    R: [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,
        278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,
        611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,
        556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],
    B: [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,
        333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,
        611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,
        611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584],
  };

  // Characters outside plain ASCII that Helvetica's "WinAnsi" encoding has,
  // with their code. Latin-1 letters (é, ñ, ü...) share their Unicode number.
  const WIN_ANSI = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94,
                     '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };

  /** Turns text into WinAnsi byte codes; anything Helvetica can't show becomes "?". */
  function encode(text) {
    const codes = [];
    for (const ch of String(text)) {
      const u = ch.codePointAt(0);
      if (u >= 32 && u <= 126) codes.push(u);
      else if (u >= 160 && u <= 255) codes.push(u);
      else if (WIN_ANSI[ch]) codes.push(WIN_ANSI[ch]);
      else if (u === 9 || u === 10 || u === 13) codes.push(32);
      else codes.push(63); // "?"
    }
    return codes;
  }

  /** Width of text in points, for font 'R' (regular) or 'B' (bold). */
  function width(text, font, size) {
    let units = 0;
    for (const code of encode(text)) {
      units += code >= 32 && code <= 126 ? WIDTHS[font][code - 32] : code === 0x85 ? 1000 : 556;
    }
    return (units * size) / 1000;
  }

  /** Shortens text with "…" until it fits maxWidth. */
  function fit(text, font, size, maxWidth) {
    if (width(text, font, size) <= maxWidth) return text;
    let s = String(text);
    while (s.length && width(s + '…', font, size) > maxWidth) s = s.slice(0, -1);
    return s.trimEnd() + '…';
  }

  /** Text as a PDF hex string, e.g. "RM" → <524D>. Hex needs no escaping. */
  function hex(text) {
    return '<' + encode(text).map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase() + '>';
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  const number = new Intl.NumberFormat('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rm = (amount) => 'RM ' + number.format(amount);
  const sum = (entries) => entries.reduce((sen, e) => sen + Math.round(e.amount * 100), 0) / 100;
  const pad2 = (n) => String(n).padStart(2, '0');
  function dayLabel(text) {
    const [y, m, d] = text.split('-').map(Number);
    return DAYS[new Date(y, m - 1, d).getDay()] + ', ' + d + ' ' + MONTHS[m - 1].slice(0, 3);
  }
  const f = (n) => (Math.round(n * 100) / 100).toString(); // numbers in drawing instructions
  const color = (c) => c.map(f).join(' ');

  // -------------------------------------------------------------------------
  // The document being built: pages, drawing instructions and tags
  // -------------------------------------------------------------------------

  /**
   * A tag (structure element), e.g. {type: 'H1'} or {type: 'TD'}. Its kids
   * are other tags or pieces of marked page content ({page, mcid}).
   */
  function tag(type, parent, attributes) {
    const el = { type, kids: [], parent, attributes };
    if (parent) parent.kids.push(el);
    return el;
  }

  function newDocument() {
    const doc = { pages: [], root: tag('Document', null) };
    addPage(doc);
    return doc;
  }

  /** Starts a new page. Each page numbers its marked pieces (MCIDs) from 0. */
  function addPage(doc) {
    const page = { ops: [], mcids: [], y: 48 };
    doc.pages.push(page);
    doc.page = page;
    return page;
  }

  /**
   * Draws text at (x, top) — top measured from the top of the page — and
   * marks it as content of the tag `owner` (or as decoration if owner is
   * null). align 'right' makes x the right edge.
   */
  function text(doc, owner, x, top, str, { font = 'R', size = 11, fill = INK, align = 'left' } = {}) {
    const page = doc.page;
    const drawX = align === 'right' ? x - width(str, font, size) : x;
    const draw = 'BT /' + (font === 'B' ? 'F2' : 'F1') + ' ' + f(size) + ' Tf ' + color(fill) + ' rg 1 0 0 1 ' +
      f(drawX) + ' ' + f(PAGE_H - top) + ' Tm ' + hex(str) + ' Tj ET';
    if (owner) {
      const mcid = page.mcids.length;
      page.mcids.push(owner);
      owner.kids.push({ page, mcid });
      page.ops.push('/' + owner.type + ' <</MCID ' + mcid + '>> BDC ' + draw + ' EMC');
    } else {
      page.ops.push('/Artifact BMC ' + draw + ' EMC');
    }
  }

  /** A thin horizontal line (decoration). */
  function rule(doc, top, x1 = LEFT, x2 = RIGHT, weight = 0.6, stroke = RULE) {
    doc.page.ops.push('/Artifact BMC q ' + color(stroke) + ' RG ' + f(weight) + ' w ' +
      f(x1) + ' ' + f(PAGE_H - top) + ' m ' + f(x2) + ' ' + f(PAGE_H - top) + ' l S Q EMC');
  }

  /** A rounded rectangle outline or fill (decoration). */
  function box(doc, x, top, w, h, r, { stroke, fill } = {}) {
    const y = PAGE_H - top - h;
    const k = r * 0.5523; // how far bezier handles reach to draw a quarter circle
    const path = [
      f(x + r) + ' ' + f(y) + ' m',
      f(x + w - r) + ' ' + f(y) + ' l',
      f(x + w - r + k) + ' ' + f(y) + ' ' + f(x + w) + ' ' + f(y + r - k) + ' ' + f(x + w) + ' ' + f(y + r) + ' c',
      f(x + w) + ' ' + f(y + h - r) + ' l',
      f(x + w) + ' ' + f(y + h - r + k) + ' ' + f(x + w - r + k) + ' ' + f(y + h) + ' ' + f(x + w - r) + ' ' + f(y + h) + ' c',
      f(x + r) + ' ' + f(y + h) + ' l',
      f(x + r - k) + ' ' + f(y + h) + ' ' + f(x) + ' ' + f(y + h - r + k) + ' ' + f(x) + ' ' + f(y + h - r) + ' c',
      f(x) + ' ' + f(y + r) + ' l',
      f(x) + ' ' + f(y + r - k) + ' ' + f(x + r - k) + ' ' + f(y) + ' ' + f(x + r) + ' ' + f(y) + ' c h',
    ].join(' ');
    const paint = fill && stroke ? 'B' : fill ? 'f' : 'S';
    doc.page.ops.push('/Artifact BMC q ' + (fill ? color(fill) + ' rg ' : '') + (stroke ? color(stroke) + ' RG 0.8 w ' : '') +
      path + ' ' + paint + ' Q EMC');
  }

  // -------------------------------------------------------------------------
  // 1–3. Layout, drawing and tags
  // -------------------------------------------------------------------------

  /** The "sen" mark and app name at the top of every page (decoration). */
  function brand(doc) {
    box(doc, LEFT, 40, 26, 26, 7, { fill: [1, 0.94, 0.85], stroke: [0.93, 0.86, 0.78] });
    text(doc, null, LEFT + 13 - width('sen', 'B', 9) / 2, 56.5, 'sen', { font: 'B', size: 9 });
    text(doc, null, LEFT + 36, 57, 'Sen Tracker', { font: 'B', size: 12 });
  }

  /** The column positions of the "All Entries" table. */
  const ENTRY_COLS = { date: LEFT, category: LEFT + 92, note: LEFT + 196, amountRight: RIGHT, noteWidth: RIGHT - 90 - (LEFT + 196) };

  /** Draws the header row of "All Entries"; tagged once, decoration when repeated. */
  function entryHeader(doc, table, repeated) {
    const top = doc.page.y;
    const owner = repeated ? null : tag('TR', table);
    const th = (label, x, align) => text(doc, owner ? tag('TH', owner, { Scope: 'Column' }) : null, x, top, label,
      { font: 'B', size: 9, fill: MUTED, align });
    th('Date', ENTRY_COLS.date);
    th('Category', ENTRY_COLS.category);
    th('Note', ENTRY_COLS.note);
    th('Amount', ENTRY_COLS.amountRight, 'right');
    rule(doc, top + 7, LEFT, RIGHT, 0.8, INK);
    doc.page.y = top + 24;
  }

  /** Lays out the whole statement. Returns the document (pages + tags). */
  function layout({ month, monthLabel, email, entries, generatedAt }) {
    const doc = newDocument();
    const root = doc.root;
    const [year, monthNumber] = month.split('-').map(Number);
    const monthName = MONTHS[monthNumber - 1];
    const lastDay = new Date(year, monthNumber, 0).getDate();
    const now = generatedAt;
    const isCurrent = now.getFullYear() === year && now.getMonth() + 1 === monthNumber;
    const daysSoFar = isCurrent ? now.getDate() : lastDay;
    const total = sum(entries);
    const spendingDays = new Set(entries.map((e) => e.date)).size;

    // --- Page 1 header ---
    brand(doc);
    text(doc, tag('H1', root), LEFT, 108, 'Monthly Statement', { font: 'B', size: 26 });
    text(doc, tag('P', root), LEFT, 132, monthLabel, { size: 15, fill: MUTED });

    // Details in two columns: label above value, read as one paragraph each.
    const details = [
      ['Prepared for', email], ['Period', '1 to ' + lastDay + ' ' + monthName.slice(0, 3) + ' ' + year],
      ['Generated', now.getDate() + ' ' + MONTHS[now.getMonth()].slice(0, 3) + ' ' + now.getFullYear() + ', ' + now.getHours() + ':' + pad2(now.getMinutes())],
      ['Currency', 'Malaysian Ringgit (RM)'],
    ];
    details.forEach(([label, value], i) => {
      const x = i % 2 === 0 ? LEFT : LEFT + 260;
      const top = 170 + Math.floor(i / 2) * 36;
      const p = tag('P', root);
      text(doc, p, x, top, label, { size: 9, fill: MUTED });
      text(doc, p, x, top + 15, fit(value, 'B', 11, 240), { font: 'B', size: 11 });
    });

    // Three summary boxes.
    const boxW = (RIGHT - LEFT - 20) / 3;
    [['Total Spent', rm(total)], ['Entries', String(entries.length)], ['Daily Average', rm(total / daysSoFar)]]
      .forEach(([label, value], i) => {
        const x = LEFT + i * (boxW + 10);
        box(doc, x, 250, boxW, 62, 10, { stroke: RULE });
        const p = tag('P', root);
        text(doc, p, x + 14, 272, label, { size: 9, fill: MUTED });
        text(doc, p, x + 14, 296, value, { font: 'B', size: 16 });
      });

    // --- By Category ---
    text(doc, tag('H2', root), LEFT, 350, 'By Category', { font: 'B', size: 14 });
    const catTable = tag('Table', root);
    const catCols = [[LEFT, 'Category', 'left'], [LEFT + 290, 'Entries', 'right'], [LEFT + 400, 'Amount', 'right'], [RIGHT, 'Share', 'right']];
    let top = 376;
    const headRow = tag('TR', catTable);
    catCols.forEach(([x, label, align]) => text(doc, tag('TH', headRow, { Scope: 'Column' }), x, top, label, { font: 'B', size: 9, fill: MUTED, align }));
    rule(doc, top + 7, LEFT, RIGHT, 0.8, INK);
    top += 24;
    const categories = CATEGORIES.map((name) => {
      const list = entries.filter((e) => e.category === name);
      return { name, n: list.length, amount: sum(list) };
    }).filter((c) => c.n > 0).sort((a, b) => b.amount - a.amount);
    for (const c of categories) {
      const row = tag('TR', catTable);
      const cells = [c.name, String(c.n), rm(c.amount), Math.round((c.amount / total) * 100) + '%'];
      cells.forEach((value, i) => text(doc, tag('TD', row), catCols[i][0], top, value, { size: 10.5, align: catCols[i][2] }));
      rule(doc, top + 8);
      top += 22;
    }

    // --- All Entries (continues onto more pages as needed) ---
    top += 22;
    text(doc, tag('H2', root), LEFT, top, 'All Entries', { font: 'B', size: 14 });
    doc.page.y = top + 26;
    const entryTable = tag('Table', root);
    entryHeader(doc, entryTable, false);

    for (const e of entries) {
      if (doc.page.y + 22 > BOTTOM_LIMIT) {
        // New page: repeat the header so each page makes sense on its own.
        // The repeats are decoration: the table is still one table.
        addPage(doc);
        brand(doc);
        text(doc, null, LEFT, 100, 'Monthly Statement', { font: 'B', size: 18 });
        text(doc, null, LEFT, 120, monthLabel + ' · continued', { size: 12, fill: MUTED });
        text(doc, null, LEFT, 156, 'All Entries, continued', { font: 'B', size: 14 });
        doc.page.y = 182;
        entryHeader(doc, entryTable, true);
      }
      const y = doc.page.y;
      const row = tag('TR', entryTable);
      text(doc, tag('TD', row), ENTRY_COLS.date, y, dayLabel(e.date), { size: 10 });
      text(doc, tag('TD', row), ENTRY_COLS.category, y, e.category, { size: 10 });
      text(doc, tag('TD', row), ENTRY_COLS.note, y, fit(e.note || '—', 'R', 10, ENTRY_COLS.noteWidth), { size: 10, fill: e.note ? INK : MUTED });
      text(doc, tag('TD', row), ENTRY_COLS.amountRight, y, rm(e.amount), { size: 10, align: 'right' });
      rule(doc, y + 8);
      doc.page.y = y + 22;
    }

    // --- Totals, closing the statement ---
    if (doc.page.y + 110 > BOTTOM_LIMIT) {
      addPage(doc);
      brand(doc);
      doc.page.y = 100;
    }
    top = doc.page.y + 14;
    rule(doc, top - 4, LEFT, RIGHT, 0.8, INK);
    const totals = [['Entries', String(entries.length)], ['Days with spending', spendingDays + ' of ' + daysSoFar],
                    ['Total for ' + monthName, rm(total)]];
    totals.forEach(([label, value], i) => {
      const p = tag('P', root);
      const bold = i === totals.length - 1;
      text(doc, p, LEFT, top + 16 + i * 20, label, { size: 11, font: bold ? 'B' : 'R', fill: bold ? INK : MUTED });
      text(doc, p, RIGHT, top + 16 + i * 20, value, { size: 11, font: 'B', align: 'right' });
    });
    text(doc, tag('P', root), LEFT, top + 92, 'This statement is for your own records. It is not a bank statement.', { size: 9, fill: MUTED });

    // --- Footer on every page (decoration) ---
    doc.pages.forEach((page, i) => {
      doc.page = page;
      rule(doc, PAGE_H - 48);
      text(doc, null, LEFT, PAGE_H - 32, 'Receipt photos and unsaved entries are not included.', { size: 8.5, fill: MUTED });
      text(doc, null, RIGHT, PAGE_H - 32, 'Page ' + (i + 1) + ' of ' + doc.pages.length, { size: 8.5, fill: MUTED, align: 'right' });
    });
    return doc;
  }

  // -------------------------------------------------------------------------
  // 4. Writing the file
  // -------------------------------------------------------------------------

  /** A PDF text string in (brackets), with \, ( and ) escaped. ASCII only. */
  function literal(textValue) {
    return '(' + String(textValue).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1') + ')';
  }

  /** Joins everything into the bytes of a PDF file. */
  function write(doc, title) {
    const objects = [];                       // objects[n - 1] = text of object n
    const reserve = () => objects.push(null); // get the next object number
    const set = (n, body) => { objects[n - 1] = body; };
    const ref = (n) => n + ' 0 R';

    const catalog = reserve();
    const pagesObj = reserve();
    const fontR = reserve();
    const fontB = reserve();
    const info = reserve();
    const treeRoot = reserve();
    const parentTree = reserve();
    set(fontR, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    set(fontB, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    // Pages and their drawing instructions.
    doc.pages.forEach((page) => {
      page.obj = reserve();
      page.contents = reserve();
    });
    doc.pages.forEach((page, i) => {
      const stream = page.ops.join('\n');
      set(page.contents, '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
      set(page.obj, '<< /Type /Page /Parent ' + ref(pagesObj) + ' /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + ']' +
        ' /Resources << /Font << /F1 ' + ref(fontR) + ' /F2 ' + ref(fontB) + ' >> >>' +
        ' /Contents ' + ref(page.contents) + ' /StructParents ' + i + ' /Tabs /S >>');
    });
    set(pagesObj, '<< /Type /Pages /Kids [' + doc.pages.map((p) => ref(p.obj)).join(' ') + '] /Count ' + doc.pages.length + ' >>');

    // Tags: give every structure element an object number, then write them.
    const all = [];
    (function number(el) {
      el.obj = reserve();
      all.push(el);
      el.kids.forEach((kid) => { if (kid.type) number(kid); });
    })(doc.root);
    for (const el of all) {
      const kids = el.kids.map((kid) => (kid.type ? ref(kid.obj) : '<< /Type /MCR /Pg ' + ref(kid.page.obj) + ' /MCID ' + kid.mcid + ' >>'));
      const attrs = el.attributes && el.attributes.Scope ? ' /A << /O /Table /Scope /' + el.attributes.Scope + ' >>' : '';
      set(el.obj, '<< /Type /StructElem /S /' + el.type + ' /P ' + ref(el.parent ? el.parent.obj : treeRoot) + attrs +
        ' /K [' + kids.join(' ') + '] >>');
    }
    // The parent tree tells a reader which tag owns each marked piece of a page.
    set(parentTree, '<< /Nums [' + doc.pages.map((page, i) => i + ' [' + page.mcids.map((owner) => ref(owner.obj)).join(' ') + ']').join(' ') + '] >>');
    set(treeRoot, '<< /Type /StructTreeRoot /K ' + ref(doc.root.obj) + ' /ParentTree ' + ref(parentTree) +
      ' /ParentTreeNextKey ' + doc.pages.length + ' >>');

    const d = new Date();
    const stamp = 'D:' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    set(info, '<< /Title ' + literal(title) + ' /Creator (Sen Tracker) /Producer (Sen Tracker) /CreationDate (' + stamp + ') >>');
    set(catalog, '<< /Type /Catalog /Pages ' + ref(pagesObj) + ' /StructTreeRoot ' + ref(treeRoot) +
      ' /MarkInfo << /Marked true >> /Lang (en-MY) /ViewerPreferences << /DisplayDocTitle true >> >>');

    // Join, noting where each object starts (all text is ASCII, so
    // characters = bytes), then the table of positions ("xref").
    let out = '%PDF-1.7\n';
    const offsets = [];
    objects.forEach((body, i) => {
      offsets.push(out.length);
      out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
    });
    const xref = out.length;
    out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' +
      offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
      'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + ref(catalog) + ' /Info ' + ref(info) + ' >>\nstartxref\n' + xref + '\n%%EOF\n';
    return new TextEncoder().encode(out);
  }

  /**
   * Builds the statement. entries must be the month's saved entries, oldest
   * first. Returns the file's bytes, its page count and a file name like
   * "sen-tracker-nov-2026.pdf".
   */
  function build(options) {
    const doc = layout(options);
    const [year, monthNumber] = options.month.split('-').map(Number);
    return {
      bytes: write(doc, 'Sen Tracker statement, ' + options.monthLabel),
      pages: doc.pages.length,
      fileName: 'sen-tracker-' + MONTHS[monthNumber - 1].slice(0, 3).toLowerCase() + '-' + year + '.pdf',
    };
  }

  return { build };
})();
