// statement.js — makes the monthly PDF statement, with no library.
//
// A PDF is a file made of numbered "objects" (pages, fonts, images, drawing
// instructions) plus a table saying where each object starts. This file
// writes one by hand:
//
//   1. FONTS: reads the Geist font files (TrueType) and embeds only the
//      letters the statement uses, so the PDF looks like the app and stays small.
//   2. LAYOUT: decides what goes where on each A4 page (in points; 72 = 1 inch).
//   3. DRAWING: each page gets a list of drawing instructions ("content stream").
//   4. TAGS: so screen readers can read it in order, every piece of text is
//      marked as part of a heading, paragraph or table cell ("tagged PDF").
//      Lines, boxes, dots, the logo and the page footer are "Artifact" (decoration).
//   5. FILE: the objects are joined with the table of byte positions.
//
// Used by app.js:
//   const resources = await SenStatement.load();     // fonts + logo, once
//   SenStatement.build({month, monthLabel, email, entries, generatedAt}, resources)
//     → {bytes, pages, fileName}

'use strict';

const SenStatement = (() => {
  const PAGE_W = 595.28;   // A4 width in points
  const PAGE_H = 841.89;   // A4 height in points
  const LEFT = 44;
  const RIGHT = PAGE_W - 44;
  const BOTTOM_LIMIT = PAGE_H - 84; // content stops here; the footer goes below

  const INK = [0.043, 0.051, 0.071];   // #0b0d12
  const MUTED = [0.337, 0.357, 0.4];   // #565b66
  const RULE = [0.86, 0.87, 0.89];
  const CATEGORY_COLORS = {            // the app's category colours
    Food: [0.851, 0.329, 0.118], Transport: [0.169, 0.541, 0.275], Bills: [0.384, 0.278, 0.847],
    Shopping: [0.812, 0.216, 0.518], Health: [0.043, 0.525, 0.596], Entertainment: [0.612, 0.435, 0],
    Other: [0.365, 0.392, 0.447],
  };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
                  'September', 'October', 'November', 'December'];
  const CATEGORIES = Object.keys(CATEGORY_COLORS);

  // -------------------------------------------------------------------------
  // 1. Fonts: reading a TrueType file
  // -------------------------------------------------------------------------
  //
  // A TrueType font is a set of tables, each with a 4-letter name:
  //   cmap — which glyph (shape) number draws each character
  //   hmtx — how wide each glyph is
  //   glyf — the shapes themselves; loca — where each shape starts in glyf
  //   head, hhea, maxp — sizes and counts

  /** Reads the parts of a TrueType font we need. bytes: Uint8Array. */
  function readFont(bytes, name) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tables = {};
    for (let i = 0; i < dv.getUint16(4); i++) {
      const at = 12 + i * 16;
      const tagName = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
      tables[tagName] = { offset: dv.getUint32(at + 8), length: dv.getUint32(at + 12) };
    }
    const head = tables.head.offset;
    const hhea = tables.hhea.offset;
    const numGlyphs = dv.getUint16(tables.maxp.offset + 4);
    const numHMetrics = dv.getUint16(hhea + 34);
    const os2 = tables['OS/2'] ? tables['OS/2'].offset : null;

    const font = {
      name, bytes, dv, tables, numGlyphs,
      unitsPerEm: dv.getUint16(head + 18),
      bbox: [dv.getInt16(head + 36), dv.getInt16(head + 38), dv.getInt16(head + 40), dv.getInt16(head + 42)],
      ascent: dv.getInt16(hhea + 4),
      descent: dv.getInt16(hhea + 6),
      capHeight: os2 && dv.getUint16(os2) >= 2 ? dv.getInt16(os2 + 88) : dv.getInt16(hhea + 4),
      advances: [],
      glyphFor: new Map(),   // character code → glyph number
      used: new Map(),       // glyph number → character, for this statement
    };
    for (let g = 0; g < numGlyphs; g++) {
      font.advances.push(dv.getUint16(tables.hmtx.offset + Math.min(g, numHMetrics - 1) * 4));
    }

    // Where each glyph's shape starts and ends in the glyf table.
    const longLoca = dv.getInt16(head + 50) === 1;
    font.loca = [];
    for (let g = 0; g <= numGlyphs; g++) {
      font.loca.push(longLoca ? dv.getUint32(tables.loca.offset + g * 4) : dv.getUint16(tables.loca.offset + g * 2) * 2);
    }

    // The character map: prefer the full-Unicode table (format 12), else format 4.
    const cmap = tables.cmap.offset;
    let best = null;
    for (let i = 0; i < dv.getUint16(cmap + 2); i++) {
      const platform = dv.getUint16(cmap + 4 + i * 8);
      const encoding = dv.getUint16(cmap + 6 + i * 8);
      const sub = cmap + dv.getUint32(cmap + 8 + i * 8);
      const format = dv.getUint16(sub);
      if (platform === 3 && encoding === 10 && format === 12) best = { sub, format };
      else if (platform === 3 && encoding === 1 && format === 4 && !best) best = { sub, format };
    }
    if (best.format === 12) {
      const groups = dv.getUint32(best.sub + 12);
      for (let i = 0; i < groups; i++) {
        const at = best.sub + 16 + i * 12;
        const start = dv.getUint32(at);
        const end = dv.getUint32(at + 4);
        const first = dv.getUint32(at + 8);
        for (let c = start; c <= end && c <= 0x2ffff; c++) font.glyphFor.set(c, first + c - start);
      }
    } else {
      const segX2 = dv.getUint16(best.sub + 6);
      const ends = best.sub + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let i = 0; i < segX2 / 2; i++) {
        const start = dv.getUint16(starts + i * 2);
        const end = dv.getUint16(ends + i * 2);
        const delta = dv.getInt16(deltas + i * 2);
        const range = dv.getUint16(ranges + i * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let g = range === 0 ? c + delta : dv.getUint16(ranges + i * 2 + range + (c - start) * 2);
          if (range !== 0 && g !== 0) g += delta;
          g &= 0xffff;
          if (g) font.glyphFor.set(c, g);
        }
      }
    }
    font.question = font.glyphFor.get(63); // "?" for characters Geist doesn't have
    return font;
  }

  /** The glyph numbers for a piece of text (unknown characters become "?"). */
  function glyphs(font, textValue) {
    const out = [];
    for (const ch of String(textValue).replace(/[\t\r\n]/g, ' ')) {
      const code = ch.codePointAt(0);
      const g = font.glyphFor.get(code);
      out.push(g ? { g, ch } : { g: font.question, ch: '?' });
    }
    return out;
  }

  /** Width of text in points at a font size. */
  function width(font, textValue, size) {
    return glyphs(font, textValue).reduce((w, { g }) => w + font.advances[g], 0) * size / font.unitsPerEm;
  }

  /** Shortens text with "…" until it fits maxWidth. */
  function fit(font, textValue, size, maxWidth) {
    if (width(font, textValue, size) <= maxWidth) return textValue;
    let s = String(textValue);
    while (s.length && width(font, s + '…', size) > maxWidth) s = s.slice(0, -1);
    return s.trimEnd() + '…';
  }

  /**
   * Makes a small copy of the font with only the glyphs this statement uses
   * (the rest are left empty), so a 125 KB font adds only ~15 KB to the PDF.
   * Glyph numbers stay the same, so text can refer to them directly.
   */
  function subsetFont(font) {
    const { dv, bytes, tables } = font;
    const keep = new Set([0, ...font.used.keys()]);
    // Some glyphs (like "é") are built from others ("e" + accent): keep those too.
    const queue = [...keep];
    while (queue.length) {
      const g = queue.pop();
      const start = tables.glyf.offset + font.loca[g];
      if (font.loca[g + 1] === font.loca[g] || dv.getInt16(start) >= 0) continue;
      let at = start + 10;
      for (;;) {
        const flags = dv.getUint16(at);
        const part = dv.getUint16(at + 2);
        if (!keep.has(part)) { keep.add(part); queue.push(part); }
        at += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
        if (!(flags & 0x20)) break;
      }
    }

    // New glyf and loca tables (long offsets).
    const pieces = [];
    const loca = new DataView(new ArrayBuffer((font.numGlyphs + 1) * 4));
    let size = 0;
    for (let g = 0; g < font.numGlyphs; g++) {
      loca.setUint32(g * 4, size);
      if (keep.has(g) && font.loca[g + 1] > font.loca[g]) {
        const piece = bytes.subarray(tables.glyf.offset + font.loca[g], tables.glyf.offset + font.loca[g + 1]);
        pieces.push(piece);
        size += piece.length;
        const padding = (4 - (piece.length % 4)) % 4;
        if (padding) { pieces.push(new Uint8Array(padding)); size += padding; }
      }
    }
    loca.setUint32(font.numGlyphs * 4, size);
    const glyf = joinBytes(pieces);

    // head: say loca uses long offsets, and clear the whole-file checksum.
    const head = bytes.slice(tables.head.offset, tables.head.offset + tables.head.length);
    new DataView(head.buffer).setInt16(50, 1);
    new DataView(head.buffer).setUint32(8, 0);

    const copy = (t) => (tables[t] ? bytes.slice(tables[t].offset, tables[t].offset + tables[t].length) : null);
    const out = { 'cvt ': copy('cvt '), fpgm: copy('fpgm'), glyf, head, hhea: copy('hhea'), hmtx: copy('hmtx'),
                  loca: new Uint8Array(loca.buffer), maxp: copy('maxp'), prep: copy('prep') };
    const names = Object.keys(out).filter((t) => out[t]).sort();

    // Write the font file: a header, a directory of tables, then the tables.
    const headerSize = 12 + names.length * 16;
    let offset = headerSize;
    const directory = new DataView(new ArrayBuffer(headerSize));
    directory.setUint32(0, 0x00010000);
    directory.setUint16(4, names.length);
    let power = 1;
    while (power * 2 <= names.length) power *= 2;
    directory.setUint16(6, power * 16);
    directory.setUint16(8, Math.log2(power));
    directory.setUint16(10, names.length * 16 - power * 16);
    const body = [];
    names.forEach((t, i) => {
      const data = out[t];
      const at = 12 + i * 16;
      for (let k = 0; k < 4; k++) directory.setUint8(at + k, t.charCodeAt(k));
      directory.setUint32(at + 4, checksum(data));
      directory.setUint32(at + 8, offset);
      directory.setUint32(at + 12, data.length);
      const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
      padded.set(data);
      body.push(padded);
      offset += padded.length;
    });
    return joinBytes([new Uint8Array(directory.buffer), ...body]);
  }

  /** TrueType table checksum: the sum of its 4-byte numbers. */
  function checksum(data) {
    const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
    padded.set(data);
    const dv = new DataView(padded.buffer);
    let sum = 0;
    for (let i = 0; i < padded.length; i += 4) sum = (sum + dv.getUint32(i)) >>> 0;
    return sum;
  }

  /** Joins byte arrays into one. */
  function joinBytes(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  const number = new Intl.NumberFormat('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rm = (amount) => 'RM ' + number.format(amount);
  const sum = (entries) => entries.reduce((sen, e) => sen + Math.round(e.amount * 100), 0) / 100;
  const pad2 = (n) => String(n).padStart(2, '0');
  const shortDate = (textValue) => Number(textValue.slice(8)) + ' ' + MONTHS[Number(textValue.slice(5, 7)) - 1].slice(0, 3);
  const f = (n) => (Math.round(n * 100) / 100).toString(); // numbers in drawing instructions
  const color = (c) => c.map(f).join(' ');

  // -------------------------------------------------------------------------
  // 2–4. Layout, drawing and tags
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

  /** Starts a new page. Each page numbers its marked pieces (MCIDs) from 0. */
  function addPage(doc) {
    const page = { ops: [], mcids: [], y: 0 };
    doc.pages.push(page);
    doc.page = page;
    return page;
  }

  /**
   * Draws text with its baseline at `y` (measured from the top of the page)
   * and marks it as content of the tag `owner`, or as decoration if owner is
   * null. Font 'R' is Geist Medium, 'B' is Geist SemiBold. align 'right'
   * makes x the right edge.
   */
  function text(doc, owner, x, y, str, { font = 'R', size = 11, fill = INK, align = 'left' } = {}) {
    const page = doc.page;
    const face = doc.fonts[font];
    const drawX = align === 'right' ? x - width(face, str, size) : x;
    const codes = glyphs(face, str).map(({ g, ch }) => {
      if (!face.used.has(g)) face.used.set(g, ch);
      return g.toString(16).padStart(4, '0');
    }).join('').toUpperCase();
    const draw = 'BT /' + (font === 'B' ? 'F2' : 'F1') + ' ' + f(size) + ' Tf ' + color(fill) + ' rg 1 0 0 1 ' +
      f(drawX) + ' ' + f(PAGE_H - y) + ' Tm <' + codes + '> Tj ET';
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
  function rule(doc, y, x1 = LEFT, x2 = RIGHT, weight = 0.6, stroke = RULE) {
    doc.page.ops.push('/Artifact BMC q ' + color(stroke) + ' RG ' + f(weight) + ' w ' +
      f(x1) + ' ' + f(PAGE_H - y) + ' m ' + f(x2) + ' ' + f(PAGE_H - y) + ' l S Q EMC');
  }

  /** The path of a rounded rectangle (top-left at x, top). */
  function roundedPath(x, top, w, h, r) {
    const y = PAGE_H - top - h;
    const k = r * 0.5523; // how far bezier handles reach to draw a quarter circle
    return [
      f(x + r) + ' ' + f(y) + ' m', f(x + w - r) + ' ' + f(y) + ' l',
      f(x + w - r + k) + ' ' + f(y) + ' ' + f(x + w) + ' ' + f(y + r - k) + ' ' + f(x + w) + ' ' + f(y + r) + ' c',
      f(x + w) + ' ' + f(y + h - r) + ' l',
      f(x + w) + ' ' + f(y + h - r + k) + ' ' + f(x + w - r + k) + ' ' + f(y + h) + ' ' + f(x + w - r) + ' ' + f(y + h) + ' c',
      f(x + r) + ' ' + f(y + h) + ' l',
      f(x + r - k) + ' ' + f(y + h) + ' ' + f(x) + ' ' + f(y + h - r + k) + ' ' + f(x) + ' ' + f(y + h - r) + ' c',
      f(x) + ' ' + f(y + r) + ' l',
      f(x) + ' ' + f(y + r - k) + ' ' + f(x + r - k) + ' ' + f(y) + ' ' + f(x + r) + ' ' + f(y) + ' c h',
    ].join(' ');
  }

  /** A rounded rectangle outline (decoration). */
  function box(doc, x, top, w, h, r) {
    doc.page.ops.push('/Artifact BMC q ' + color(RULE) + ' RG 0.8 w ' + roundedPath(x, top, w, h, r) + ' S Q EMC');
  }

  /** A category colour dot centred at (x, y) (decoration: the name is beside it). */
  function dot(doc, x, y, category) {
    const r = 3.2;
    doc.page.ops.push('/Artifact BMC q ' + color(CATEGORY_COLORS[category] || MUTED) + ' rg ' +
      roundedPath(x - r, y - r, r * 2, r * 2, r) + ' f Q EMC');
  }

  /** The "sen" logo and app name, top left of every page (decoration). */
  function brand(doc) {
    if (doc.logo) {
      doc.page.ops.push('/Artifact BMC q ' + roundedPath(LEFT, 42, 30, 30, 8.4) + ' W n 30 0 0 30 ' + f(LEFT) + ' ' +
        f(PAGE_H - 72) + ' cm /Logo Do Q EMC');
    }
    text(doc, null, LEFT + 40, 62, 'Sen Tracker', { font: 'B', size: 15 });
  }

  /** The column positions of the "All Entries" table. */
  const COLS = { date: LEFT, dot: LEFT + 70, category: LEFT + 78, note: LEFT + 174, amount: RIGHT };
  const NOTE_WIDTH = RIGHT - 84 - COLS.note;
  const ROW = 25; // row height

  /** Draws the header row of "All Entries"; tagged once, decoration when repeated. */
  function entryHeader(doc, table, repeated) {
    const y = doc.page.y;
    const owner = repeated ? null : tag('TR', table);
    const th = (label, x, align) => text(doc, owner ? tag('TH', owner, { Scope: 'Column' }) : null, x, y, label,
      { font: 'B', size: 11, align });
    th('Date', COLS.date);
    th('Category', COLS.category - 8);
    th('Note', COLS.note);
    th('Amount', COLS.amount, 'right');
    rule(doc, y + 9, LEFT, RIGHT, 0.9, INK);
    doc.page.y = y + 9 + 17;
  }

  /** Lays out the whole statement. Returns the document (pages + tags). */
  function layout(options, resources) {
    const { month, monthLabel, email, entries, generatedAt: now } = options;
    const doc = { pages: [], root: tag('Document', null), fonts: resources.fonts, logo: resources.logo };
    for (const face of Object.values(doc.fonts)) face.used = new Map();
    addPage(doc);
    const root = doc.root;
    const [year, monthNumber] = month.split('-').map(Number);
    const monthName = MONTHS[monthNumber - 1];
    const lastDay = new Date(year, monthNumber, 0).getDate();
    const isCurrent = now.getFullYear() === year && now.getMonth() + 1 === monthNumber;
    const daysSoFar = isCurrent ? now.getDate() : lastDay;
    const total = sum(entries);
    const spendingDays = new Set(entries.map((e) => e.date)).size;

    // --- Header: brand on the left, title on the right ---
    brand(doc);
    text(doc, tag('H1', root), RIGHT, 64, 'Monthly Statement', { font: 'B', size: 21, align: 'right' });
    text(doc, tag('P', root), RIGHT, 84, monthLabel, { size: 12.5, fill: MUTED, align: 'right' });
    rule(doc, 100);

    // --- Details: label above value, read as one paragraph each ---
    const details = [
      ['Prepared For', email], ['Period', '1 to ' + lastDay + ' ' + monthName.slice(0, 3) + ' ' + year],
      ['Generated', now.getDate() + ' ' + MONTHS[now.getMonth()].slice(0, 3) + ' ' + now.getFullYear() + ', ' + now.getHours() + ':' + pad2(now.getMinutes())],
      ['Currency', 'Malaysian Ringgit (RM)'],
    ];
    details.forEach(([label, value], i) => {
      const x = i % 2 === 0 ? LEFT : LEFT + 268;
      const y = 122 + Math.floor(i / 2) * 40;
      const p = tag('P', root);
      text(doc, p, x, y, label, { size: 11, fill: MUTED });
      text(doc, p, x, y + 16, fit(doc.fonts.B, value, 11.5, 250), { font: 'B', size: 11.5 });
    });
    rule(doc, 194);

    // --- Three summary boxes ---
    const boxW = (RIGHT - LEFT - 20) / 3;
    [['Total Spent', rm(total)], ['Entries', String(entries.length)], ['Daily Average', rm(total / spendingDays)]]
      .forEach(([label, value], i) => {
        const x = LEFT + i * (boxW + 10);
        box(doc, x, 208, boxW, 60, 12);
        const p = tag('P', root);
        text(doc, p, x + 14, 228, label, { size: 10, fill: MUTED });
        text(doc, p, x + 14, 254, value, { font: 'B', size: 18 });
      });

    // --- By Category ---
    text(doc, tag('H2', root), LEFT, 302, 'By Category', { font: 'B', size: 13 });
    const catTable = tag('Table', root);
    const catCols = [[LEFT, 'Category', 'left'], [LEFT + 350, 'Entries', 'right'], [LEFT + 446, 'Amount', 'right'], [RIGHT, 'Share', 'right']];
    let y = 328;
    const headRow = tag('TR', catTable);
    catCols.forEach(([x, label, align]) => text(doc, tag('TH', headRow, { Scope: 'Column' }), x, y, label, { font: 'B', size: 11, align }));
    rule(doc, y + 9, LEFT, RIGHT, 0.9, INK);
    y += 9 + 17;
    const categories = CATEGORIES.map((name) => {
      const list = entries.filter((e) => e.category === name);
      return { name, n: list.length, amount: sum(list) };
    }).filter((c) => c.n > 0).sort((a, b) => b.amount - a.amount);
    for (const c of categories) {
      const row = tag('TR', catTable);
      dot(doc, LEFT + 4, y - 3.8, c.name);
      text(doc, tag('TD', row), LEFT + 14, y, c.name, { size: 11 });
      text(doc, tag('TD', row), catCols[1][0], y, String(c.n), { size: 11, align: 'right' });
      text(doc, tag('TD', row), catCols[2][0], y, rm(c.amount), { size: 11, align: 'right' });
      text(doc, tag('TD', row), RIGHT, y, Math.round((c.amount / total) * 100) + '%', { size: 11, align: 'right' });
      rule(doc, y + 10);
      y += ROW;
    }

    // --- All Entries (newest first; continues onto more pages as needed) ---
    y += 14;
    text(doc, tag('H2', root), LEFT, y, 'All Entries', { font: 'B', size: 13 });
    doc.page.y = y + 26;
    const entryTable = tag('Table', root);
    entryHeader(doc, entryTable, false);

    for (const e of entries) {
      if (doc.page.y + 12 > BOTTOM_LIMIT) {
        // New page: repeat the header so each page makes sense on its own.
        // The repeats are decoration: the table is still one table.
        addPage(doc);
        brand(doc);
        text(doc, null, RIGHT, 64, 'Monthly Statement', { font: 'B', size: 21, align: 'right' });
        text(doc, null, RIGHT, 84, monthLabel + ' · Continued', { size: 12.5, fill: MUTED, align: 'right' });
        text(doc, null, LEFT, 126, 'All Entries, Continued', { font: 'B', size: 13 });
        doc.page.y = 152;
        entryHeader(doc, entryTable, true);
      }
      const rowY = doc.page.y;
      const row = tag('TR', entryTable);
      text(doc, tag('TD', row), COLS.date, rowY, shortDate(e.date), { size: 11, fill: MUTED });
      dot(doc, COLS.dot, rowY - 3.8, e.category);
      text(doc, tag('TD', row), COLS.category, rowY, e.category, { size: 11 });
      text(doc, tag('TD', row), COLS.note, rowY, fit(doc.fonts.R, e.note || '—', 11, NOTE_WIDTH), { size: 11, fill: e.note ? INK : MUTED });
      text(doc, tag('TD', row), COLS.amount, rowY, rm(e.amount), { size: 11, align: 'right' });
      rule(doc, rowY + 10);
      doc.page.y = rowY + ROW;
    }

    // --- Totals on the right, closing the statement ---
    if (doc.page.y + 120 > BOTTOM_LIMIT) {
      addPage(doc);
      brand(doc);
      doc.page.y = 110;
    }
    y = doc.page.y + 14;
    const totalsX = LEFT + 252;
    const totals = [['Entries', String(entries.length)], ['Days with Spending', spendingDays + ' of ' + daysSoFar]];
    totals.forEach(([label, value], i) => {
      const p = tag('P', root);
      text(doc, p, totalsX, y + i * 27, label, { size: 11.5, fill: MUTED });
      text(doc, p, RIGHT, y + i * 27, value, { size: 11.5, align: 'right' });
    });
    rule(doc, y + 40, totalsX, RIGHT, 0.9, INK);
    const final = tag('P', root);
    text(doc, final, totalsX, y + 66, 'Total for ' + monthName, { font: 'B', size: 12 });
    text(doc, final, RIGHT, y + 66, rm(total), { font: 'B', size: 12, align: 'right' });
    text(doc, tag('P', root), LEFT, y + 112, 'This statement is for your own records. It is not a bank statement.', { size: 11, fill: MUTED });

    // --- Footer on every page (decoration) ---
    doc.pages.forEach((page, i) => {
      doc.page = page;
      rule(doc, PAGE_H - 58);
      text(doc, null, LEFT, PAGE_H - 38, 'Receipt photos and unsaved entries are not included.', { size: 10, fill: MUTED });
      text(doc, null, RIGHT, PAGE_H - 38, 'Page ' + (i + 1) + ' of ' + doc.pages.length, { size: 10, fill: MUTED, align: 'right' });
    });
    return doc;
  }

  // -------------------------------------------------------------------------
  // 5. Writing the file
  // -------------------------------------------------------------------------

  /** A PDF text string in (brackets), with \, ( and ) escaped. ASCII only. */
  function literal(textValue) {
    return '(' + String(textValue).replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1') + ')';
  }

  /**
   * The "ToUnicode" map for a font: which character each glyph stands for,
   * so copying text and screen readers get real letters, not glyph numbers.
   */
  function toUnicode(font) {
    const lines = [];
    const entries = [...font.used.entries()];
    for (let i = 0; i < entries.length; i += 100) {
      const chunk = entries.slice(i, i + 100);
      lines.push(chunk.length + ' beginbfchar');
      for (const [g, ch] of chunk) {
        const units = [];
        for (let k = 0; k < ch.length; k++) units.push(ch.charCodeAt(k).toString(16).padStart(4, '0'));
        lines.push('<' + g.toString(16).padStart(4, '0') + '> <' + units.join('') + '>');
      }
      lines.push('endbfchar');
    }
    return '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
      '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' + lines.join('\n') +
      '\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
  }

  /** Joins everything into the bytes of a PDF file. */
  function write(doc, title) {
    const objects = [];                       // objects[n - 1] = text or bytes of object n
    const reserve = () => objects.push(null); // the next object number
    const set = (n, body) => { objects[n - 1] = body; };
    const ref = (n) => n + ' 0 R';
    const encoder = new TextEncoder();
    const stream = (dict, data) => [encoder.encode('<< ' + dict + ' /Length ' + data.length + ' >>\nstream\n'), data, encoder.encode('\nendstream')];

    const catalog = reserve();
    const pagesObj = reserve();
    const info = reserve();
    const treeRoot = reserve();
    const parentTree = reserve();

    // Fonts: each is a "Type0" font pointing to the embedded TrueType subset.
    const fontRefs = {};
    Object.entries(doc.fonts).forEach(([key, face], i) => {
      const type0 = reserve();
      const cid = reserve();
      const descriptor = reserve();
      const file = reserve();
      const cmap = reserve();
      const baseName = 'SENAA' + String.fromCharCode(65 + i) + '+' + face.name;
      const scale = 1000 / face.unitsPerEm;
      const widths = [...face.used.keys()].sort((a, b) => a - b).map((g) => g + ' [' + Math.round(face.advances[g] * scale) + ']').join(' ');
      const subset = subsetFont(face);
      set(file, stream('/Length1 ' + subset.length, subset));
      set(descriptor, '<< /Type /FontDescriptor /FontName /' + baseName + ' /Flags 32 /FontBBox [' +
        face.bbox.map((v) => Math.round(v * scale)).join(' ') + '] /ItalicAngle 0 /Ascent ' + Math.round(face.ascent * scale) +
        ' /Descent ' + Math.round(face.descent * scale) + ' /CapHeight ' + Math.round(face.capHeight * scale) +
        ' /StemV 80 /FontFile2 ' + ref(file) + ' >>');
      set(cid, '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /' + baseName +
        ' /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ' + ref(descriptor) +
        ' /CIDToGIDMap /Identity /DW 500 /W [' + widths + '] >>');
      set(cmap, stream('', encoder.encode(toUnicode(face))));
      set(type0, '<< /Type /Font /Subtype /Type0 /BaseFont /' + baseName + ' /Encoding /Identity-H /DescendantFonts [' +
        ref(cid) + '] /ToUnicode ' + ref(cmap) + ' >>');
      fontRefs[key === 'B' ? 'F2' : 'F1'] = type0;
    });

    // The logo: a JPEG image.
    let logoRef = null;
    if (doc.logo) {
      logoRef = reserve();
      set(logoRef, stream('/Type /XObject /Subtype /Image /Width ' + doc.logo.width + ' /Height ' + doc.logo.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', doc.logo.bytes));
    }

    // Pages and their drawing instructions.
    doc.pages.forEach((page) => { page.obj = reserve(); page.contents = reserve(); });
    const resources = '<< /Font << /F1 ' + ref(fontRefs.F1) + ' /F2 ' + ref(fontRefs.F2) + ' >>' +
      (logoRef ? ' /XObject << /Logo ' + ref(logoRef) + ' >>' : '') + ' >>';
    doc.pages.forEach((page, i) => {
      set(page.contents, stream('', encoder.encode(page.ops.join('\n'))));
      set(page.obj, '<< /Type /Page /Parent ' + ref(pagesObj) + ' /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + ']' +
        ' /Resources ' + resources + ' /Contents ' + ref(page.contents) + ' /StructParents ' + i + ' /Tabs /S >>');
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

    // Join, noting the byte position where each object starts, then the
    // table of positions ("xref") that lets a reader jump to any object.
    const parts = [encoder.encode('%PDF-1.7\n%âã\n')];
    let length = parts[0].length;
    const add = (piece) => { const bytes = typeof piece === 'string' ? encoder.encode(piece) : piece; parts.push(bytes); length += bytes.length; };
    const offsets = [];
    objects.forEach((body, i) => {
      offsets.push(length);
      add((i + 1) + ' 0 obj\n');
      (Array.isArray(body) ? body : [body]).forEach(add);
      add('\nendobj\n');
    });
    const xref = length;
    add('xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' +
      offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
      'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + ref(catalog) + ' /Info ' + ref(info) + ' >>\nstartxref\n' + xref + '\n%%EOF\n');
    return joinBytes(parts);
  }

  // -------------------------------------------------------------------------
  // Public functions
  // -------------------------------------------------------------------------

  let loading = null;

  /**
   * Loads what every statement needs, once: the two Geist font files and the
   * app icon (drawn onto white and saved as a JPEG for the PDF).
   */
  function load() {
    if (!loading) {
      const fetchFont = (file, name) => fetch(file).then((r) => {
        if (!r.ok) throw new Error('Could not load ' + file);
        return r.arrayBuffer();
      }).then((buffer) => readFont(new Uint8Array(buffer), name));
      const logo = new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          const size = 120;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, 0, 0, size, size);
          canvas.toBlob((blob) => blob.arrayBuffer().then((b) => resolve({ bytes: new Uint8Array(b), width: size, height: size })), 'image/jpeg', 0.92);
        };
        img.onerror = () => resolve(null); // no logo is better than no statement
        img.src = 'icons/icon-192.png';
      });
      loading = Promise.all([fetchFont('fonts/Geist-Medium.ttf', 'Geist-Medium'), fetchFont('fonts/Geist-SemiBold.ttf', 'Geist-SemiBold'), logo])
        .then(([R, B, logoImage]) => ({ fonts: { R, B }, logo: logoImage }))
        .catch((err) => { loading = null; throw err; });
    }
    return loading;
  }

  /**
   * Builds the statement. entries: the month's saved entries, newest first.
   * resources: the result of load(). Returns the file's bytes, its page
   * count and a file name like "sen-tracker-nov-2026.pdf".
   */
  function build(options, resources) {
    const doc = layout(options, resources);
    const [year, monthNumber] = options.month.split('-').map(Number);
    return {
      bytes: write(doc, 'Sen Tracker Statement, ' + options.monthLabel),
      pages: doc.pages.length,
      fileName: 'sen-tracker-' + MONTHS[monthNumber - 1].slice(0, 3).toLowerCase() + '-' + year + '.pdf',
    };
  }

  return { load, build, readFont };
})();
