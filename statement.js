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
//   SenStatement.build({month, monthLabel, name, email, entries, previousEntries, generatedAt}, resources)
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
  // Colours from the app (layouts v9), adjusted for white paper: fills and
  // dots use the app's bright category colours; words stay dark enough to
  // read (4.5:1 or better on white).
  const GREEN = [0.059, 0.416, 0.290];        // less than last month (text)
  const GREEN_FILL = [0.863, 0.976, 0.925];   // the app's mint pill, on paper
  const GREEN_BORDER = [0.561, 0.902, 0.765];
  const RED = [0.702, 0.149, 0.118];          // more than last month (text)
  const RED_FILL = [1.000, 0.890, 0.890];
  const RED_BORDER = [1.000, 0.690, 0.690];
  const PINK = [1.000, 0.373, 0.682];         // the biggest day (the app's picked-day glow)
  const PINK_INK = [0.690, 0.078, 0.373];     // its label
  const INDIGO = [0.478, 0.463, 1.000];       // other days (the app's week ovals)
  const LILAC = [0.725, 0.659, 1.000];        // this month's comparison bar
  const GREY_BAR = [0.561, 0.576, 0.627];     // last month's comparison bar
  const HERO = [[0.071, 0.055, 0.180], [0.165, 0.102, 0.549], [0.353, 0.114, 0.471]]; // the Overview card: indigo to plum
  const HERO_INK = [0.902, 0.886, 1.000];
  const WARN_FILL = [1.000, 0.953, 0.839];    // the "In Progress" notice (the app's amber)
  const WARN_BORDER = [1.000, 0.761, 0.239];
  const WARN_INK = [0.361, 0.239, 0.000];
  const CATEGORY_COLORS = {            // the app's category colours (v9)
    Food: [1.000, 0.478, 0.271], Transport: [0.247, 0.714, 1.000], Bills: [0.545, 0.424, 1.000],
    Shopping: [1.000, 0.373, 0.682], Health: [0.263, 0.878, 0.627], Entertainment: [1.000, 0.761, 0.239],
    Other: [0.604, 0.651, 0.769],
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
   * null. Inside a chart (doc.inFigure) it is drawn plain: the chart is one
   * tagged figure with a text description. Font 'R' is Geist Medium, 'B' is
   * Geist SemiBold. align 'right' makes x the right edge; 'center' centres it.
   */
  function text(doc, owner, x, y, str, { font = 'R', size = 11, fill = INK, align = 'left' } = {}) {
    const page = doc.page;
    const face = doc.fonts[font];
    const w = width(face, str, size);
    const drawX = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
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
      paint(doc, draw);
    }
  }

  /**
   * Adds drawing instructions that are decoration: marked "Artifact" so
   * screen readers skip them, or drawn plain inside a chart (doc.inFigure).
   */
  function paint(doc, ops) {
    doc.page.ops.push(doc.inFigure ? ops : '/Artifact BMC ' + ops + ' EMC');
  }

  /**
   * Splits text into lines no wider than maxWidth, breaking between words.
   * Used for the "In Progress" notice and chart captions.
   */
  function wrap(doc, str, font, size, maxWidth) {
    const lines = [];
    let line = '';
    for (const word of String(str).split(' ')) {
      const next = line ? line + ' ' + word : word;
      if (line && width(doc.fonts[font], next, size) > maxWidth) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }

  /** A thin horizontal line (decoration). */
  function rule(doc, y, x1 = LEFT, x2 = RIGHT, weight = 0.6, stroke = RULE) {
    paint(doc, 'q ' + color(stroke) + ' RG ' + f(weight) + ' w ' +
      f(x1) + ' ' + f(PAGE_H - y) + ' m ' + f(x2) + ' ' + f(PAGE_H - y) + ' l S Q');
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

  /** A rounded rectangle: an outline, a fill, or both (decoration). */
  function box(doc, x, top, w, h, r, { stroke = RULE, fill = null } = {}) {
    const mode = fill && stroke ? 'B' : fill ? 'f' : 'S';
    paint(doc, 'q ' + (fill ? color(fill) + ' rg ' : '') + (stroke ? color(stroke) + ' RG 0.8 w ' : '') +
      roundedPath(x, top, w, h, r) + ' ' + mode + ' Q');
  }

  /**
   * A rounded box filled with the Overview card's indigo-to-plum gradient,
   * drawn as thin bands (decoration). White text on it stays above 7:1.
   */
  function heroBox(doc, x, top, w, h, r) {
    const bands = 40;
    const ops = ['q', roundedPath(x, top, w, h, r), 'W n'];
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      const [a, b, k] = t < 0.45 ? [HERO[0], HERO[1], t / 0.45] : [HERO[1], HERO[2], (t - 0.45) / 0.55];
      const c = a.map((v, j) => v + (b[j] - v) * k);
      const y0 = top + (h * i) / bands;
      ops.push(color(c) + ' rg ' + f(x) + ' ' + f(PAGE_H - y0 - h / bands - 0.5) + ' ' + f(w) + ' ' + f(h / bands + 0.5) + ' re f');
    }
    ops.push('Q');
    paint(doc, ops.join(' '));
  }

  /** A category colour dot centred at (x, y) (decoration: the name is beside it). */
  function dot(doc, x, y, category) {
    const r = 3.6;
    paint(doc, 'q ' + color(CATEGORY_COLORS[category] || MUTED) + ' rg ' + roundedPath(x - r, y - r, r * 2, r * 2, r) + ' f Q');
  }

  /**
   * Draws a chart as ONE tagged figure: drawFn's lines and words are drawn
   * plain, and `alt` is the text a screen reader reads instead.
   */
  function figure(doc, alt, drawFn) {
    const el = tag('Figure', doc.root, { Alt: alt });
    const page = doc.page;
    const mcid = page.mcids.length;
    page.mcids.push(el);
    el.kids.push({ page, mcid });
    page.ops.push('/Figure <</MCID ' + mcid + '>> BDC');
    doc.inFigure = true;
    drawFn();
    doc.inFigure = false;
    page.ops.push('EMC');
  }

  /** The "sen" logo and app name, top left of every page (decoration). */
  function brand(doc) {
    if (doc.logo) {
      // The app's mark: "sen" on a dark tile with a warm glow (56 × 52 in the app).
      paint(doc, 'q ' + roundedPath(LEFT, 42, 32, 30, 7.5) + ' W n 32 0 0 30 ' + f(LEFT) + ' ' + f(PAGE_H - 72) + ' cm /Logo Do Q');
    }
    text(doc, null, LEFT + 42, 62, 'Sen Tracker', { font: 'B', size: 15 });
  }

  /** The title block on the right of every page; tagged on page 1 only. */
  function titleBlock(doc, subtitle, tagged) {
    text(doc, tagged ? tag('H1', doc.root) : null, RIGHT, 62, 'Monthly Statement', { font: 'B', size: 20, align: 'right' });
    text(doc, tagged ? tag('P', doc.root) : null, RIGHT, 80, subtitle, { size: 11.5, fill: MUTED, align: 'right' });
  }

  /** The column positions of the "All Entries" table. */
  const COLS = { date: LEFT, dot: LEFT + 62, category: LEFT + 70, note: LEFT + 174, amount: RIGHT };
  const NOTE_WIDTH = RIGHT - 84 - COLS.note;
  const ROW = 22; // row height

  /** Draws the header row of "All Entries"; tagged once, decoration when repeated. */
  function entryHeader(doc, table, repeated) {
    const y = doc.page.y;
    const owner = repeated ? null : tag('TR', table);
    const th = (label, x, align) => text(doc, owner ? tag('TH', owner, { Scope: 'Column' }) : null, x, y, label,
      { font: 'B', size: 10.5, align });
    th('Date', COLS.date);
    th('Category', COLS.category - 8);
    th('Note', COLS.note);
    th('Amount', COLS.amount, 'right');
    rule(doc, y + 8, LEFT, RIGHT, 0.9, INK);
    doc.page.y = y + 8 + 17;
  }

  /** "↓ RM 96.20" (less, green) / "↑ RM 7.60" (more, red) / "No change". */
  function change(diff) {
    if (diff === 0) return { words: 'No change', fill: MUTED };
    return { words: (diff < 0 ? '↓ ' : '↑ ') + rm(Math.abs(diff)), fill: diff < 0 ? GREEN : RED };
  }

  /**
   * A pie slice from angle a0 to a1 (radians, clockwise from 12 o'clock),
   * built from bezier curves of at most a quarter turn each.
   */
  function slicePath(cx, cy, r, a0, a1) {
    const pt = (a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)]; // top-based y
    const parts = [f(cx) + ' ' + f(PAGE_H - cy) + ' m'];
    const [sx, sy] = pt(a0);
    parts.push(f(sx) + ' ' + f(PAGE_H - sy) + ' l');
    const steps = Math.ceil((a1 - a0) / (Math.PI / 2));
    for (let i = 0; i < steps; i++) {
      const t0 = a0 + ((a1 - a0) * i) / steps;
      const t1 = a0 + ((a1 - a0) * (i + 1)) / steps;
      const k = (4 / 3) * Math.tan((t1 - t0) / 4) * r;
      const [x0, y0] = pt(t0);
      const [x3, y3] = pt(t1);
      const c1 = [x0 + k * Math.cos(t0), y0 + k * Math.sin(t0)];
      const c2 = [x3 - k * Math.cos(t1), y3 - k * Math.sin(t1)];
      parts.push([c1[0], PAGE_H - c1[1], c2[0], PAGE_H - c2[1], x3, PAGE_H - y3].map(f).join(' ') + ' c');
    }
    return parts.join(' ') + ' h';
  }

  /**
   * Lays out the whole statement. Returns the document (pages + tags).
   * Page 1: header (and the amber "In Progress" notice while the month is
   * still going), details, four summary boxes, three charts, and spending
   * by category compared with last month. Then every entry, oldest first,
   * and the totals.
   */
  function layout(options, resources) {
    const { month, monthLabel, email, name, entries, previousEntries = [], generatedAt: now } = options;
    const doc = { pages: [], root: tag('Document', null), fonts: resources.fonts, logo: resources.logo, inFigure: false };
    for (const face of Object.values(doc.fonts)) face.used = new Map();
    addPage(doc);
    const root = doc.root;
    const [year, monthNumber] = month.split('-').map(Number);
    const monthName = MONTHS[monthNumber - 1];
    const mon = monthName.slice(0, 3);
    const prevName = MONTHS[(monthNumber + 10) % 12];
    const lastDay = new Date(year, monthNumber, 0).getDate();
    const inProgress = now.getFullYear() === year && now.getMonth() + 1 === monthNumber;
    const daysSoFar = inProgress ? now.getDate() : lastDay;
    const total = sum(entries);
    const prevTotal = sum(previousEntries);
    const byDay = {};
    for (const e of entries) byDay[e.date] = (byDay[e.date] || 0) + Math.round(e.amount * 100) / 100;
    const spendingDays = Object.keys(byDay).length;
    const generated = now.getDate() + ' ' + MONTHS[now.getMonth()].slice(0, 3) + ' ' + now.getFullYear() + ', ' + now.getHours() + ':' + pad2(now.getMinutes());
    const asOf = daysSoFar + ' ' + mon;
    const subtitle = inProgress ? monthLabel + ' · as of ' + asOf : monthLabel;

    // --- Header ---
    brand(doc);
    titleBlock(doc, subtitle, true);
    let y = 100;

    // --- "In Progress" notice (only while the month is still going) ---
    if (inProgress) {
      const p = tag('P', root);
      const lines = wrap(doc, monthName + ' is not over yet. This statement covers 1 to ' + daysSoFar + ' ' + monthName +
        ', as of ' + generated + '. Later spending is not included.', 'R', 10, RIGHT - LEFT - 120);
      const h = 18 + lines.length * 13;
      box(doc, LEFT, y, RIGHT - LEFT, h, 8, { stroke: WARN_BORDER, fill: WARN_FILL });
      box(doc, LEFT + 10, y + h / 2 - 9, 86, 18, 9, { stroke: null, fill: WARN_BORDER });
      text(doc, p, LEFT + 53, y + h / 2 + 3.4, 'IN PROGRESS', { font: 'B', size: 8.5, fill: WARN_INK, align: 'center' });
      lines.forEach((line, i) => text(doc, p, LEFT + 108, y + 15 + i * 13, line, { size: 10, fill: WARN_INK }));
      y += h + 14;
    }

    // --- Details: label above value, read as one paragraph each ---
    rule(doc, y);
    y += 20;
    const details = [
      ['Prepared For', name || email, name ? email : ''],
      ['Period', '1 to ' + daysSoFar + ' ' + mon + ' ' + year + (inProgress ? ' (so far)' : ''), ''],
      ['Generated', generated, ''],
    ];
    details.forEach(([label, value, extra], i) => {
      const x = LEFT + [0, 200, 360][i];
      const p = tag('P', root);
      text(doc, p, x, y, label, { size: 10, fill: MUTED });
      text(doc, p, x, y + 15, fit(doc.fonts.B, value, 11, 190), { font: 'B', size: 11 });
      if (extra) text(doc, p, x, y + 29, fit(doc.fonts.R, extra, 9.5, 190), { size: 9.5, fill: MUTED });
    });
    y += name ? 40 : 28;
    rule(doc, y);
    y += 12;

    // --- Four summary boxes ---
    const boxW = (RIGHT - LEFT - 24) / 4;
    const vs = prevTotal > 0 ? change(Math.round((total - prevTotal) * 100) / 100) : null;
    [[inProgress ? 'Total So Far' : 'Total Spent', rm(total), INK],
     ['Entries', String(entries.length), INK],
     ['Daily Average', rm(spendingDays ? total / spendingDays : 0), INK],
     ['vs ' + prevName, vs ? vs.words : 'No data', vs ? vs.fill : MUTED]].forEach(([label, value, fill], i) => {
      const x = LEFT + i * (boxW + 8);
      const tint = i === 3 && vs && vs.fill !== MUTED ? (vs.fill === GREEN ? [GREEN_FILL, GREEN_BORDER] : [RED_FILL, RED_BORDER]) : [null, RULE];
      // The total leads, on the same indigo-to-plum as the app's Overview card.
      if (i === 0) heroBox(doc, x, y, boxW, 50, 12);
      else box(doc, x, y, boxW, 50, 12, { stroke: tint[1], fill: tint[0] });
      const p = tag('P', root);
      text(doc, p, x + 11, y + 18, label, { size: 9.5, fill: i === 0 ? HERO_INK : i === 3 && vs ? fill : MUTED });
      text(doc, p, x + 11, y + 38, fit(doc.fonts.B, value, 14, boxW - 18), { font: 'B', size: 14, fill: i === 0 ? [1, 1, 1] : fill });
    });
    y += 64;

    // --- Charts: Where It Went (pie), Spending by Day (bars), Compared With (bars) ---
    const chartTop = y;
    const leftW = 236;
    const rightX = LEFT + leftW + 12;
    const rightW = RIGHT - rightX;
    const cats = CATEGORIES.map((c) => ({ name: c, amount: sum(entries.filter((e) => e.category === c)), n: entries.filter((e) => e.category === c).length }))
      .filter((c) => c.n > 0).sort((a, b) => b.amount - a.amount);
    const share = (amount) => Math.round((amount / total) * 100);

    box(doc, LEFT, chartTop, leftW, 196, 14);
    text(doc, tag('H2', root), LEFT + 12, chartTop + 20, 'Where It Went', { font: 'B', size: 11.5 });
    figure(doc, 'Pie chart of spending by category: ' + cats.map((c) => c.name + ' ' + share(c.amount) + '%').join(', ') + '.', () => {
      const cx = LEFT + leftW / 2;
      const cy = chartTop + 118;
      const r = 44;
      let a = 0;
      const small = [];
      const labels = { left: [], right: [] };
      for (const c of cats) {
        const sweep = (c.amount / total) * Math.PI * 2;
        const a1 = a + sweep;
        paint(doc, 'q ' + color(CATEGORY_COLORS[c.name]) + ' rg ' + (sweep >= Math.PI * 2 - 1e-6
          ? roundedPath(cx - r, cy - r, r * 2, r * 2, r) : slicePath(cx, cy, r, a, a1)) + ' f Q');
        if (share(c.amount) < 5) small.push(c.name + ' ' + share(c.amount) + '%');
        else {
          const mid = a + sweep / 2;
          const side = Math.sin(mid) >= 0 ? 'right' : 'left';
          labels[side].push({ c, y: cy - (r + 8) * Math.cos(mid) });
        }
        a = a1;
      }
      // Labels sit beside the pie, right of it or left of it, and are pushed
      // apart so neighbouring small slices never print on top of each other.
      for (const side of ['left', 'right']) {
        const list = labels[side].sort((p, q) => p.y - q.y);
        for (let i = 1; i < list.length; i++) list[i].y = Math.max(list[i].y, list[i - 1].y + 22);
        const overflow = list.length ? list[list.length - 1].y - (chartTop + 186) : 0;
        if (overflow > 0) list.forEach((l) => { l.y -= overflow; });
        for (const l of list) {
          const x = side === 'right' ? cx + r + 10 : cx - r - 10;
          const align = side === 'right' ? 'left' : 'right';
          text(doc, null, x, l.y - 1, l.c.name, { size: 8.5, align });
          text(doc, null, x, l.y + 9, share(l.c.amount) + '%', { font: 'B', size: 8.5, align });
        }
      }
      // Slices under 5% are named together at the top, so labels don't collide.
      if (small.length) text(doc, null, cx, chartTop + 40, fit(doc.fonts.R, small.join(', '), 8.5, leftW - 20), { size: 8.5, align: 'center' });
    });

    // Spending by Day
    const dayBoxH = 104;
    box(doc, rightX, chartTop, rightW, dayBoxH, 14);
    text(doc, tag('H2', root), rightX + 12, chartTop + 20, 'Spending by Day', { font: 'B', size: 11.5 });
    const days = Object.keys(byDay);
    const biggest = days.length ? days.reduce((p, q) => (byDay[q] > byDay[p] ? q : p)) : null;
    const dayLabel = (d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(year, monthNumber - 1, Number(d.slice(8))).getDay()] + ' ' + Number(d.slice(8)) + ' ' + mon;
    figure(doc, 'Bar chart of spending for each day, 1 to ' + daysSoFar + ' ' + mon + '.' +
      (biggest ? ' Biggest day ' + dayLabel(biggest) + ', ' + rm(byDay[biggest]) + '.' : ''), () => {
      const x0 = rightX + 12;
      const plotW = rightW - 24;
      const base = chartTop + 70;
      const step = plotW / lastDay;
      const max = Math.max(...Object.values(byDay), 1);
      for (let d = 1; d <= lastDay; d++) {
        const key = month + '-' + pad2(d);
        const x = x0 + (d - 1) * step + step * 0.15;
        if (d > daysSoFar) {
          paint(doc, 'q ' + color(RULE) + ' rg ' + roundedPath(x, base - 1.5, step * 0.7, 1.5, 0.5) + ' f Q');
          continue;
        }
        const v = byDay[key] || 0;
        if (!v) continue;
        const hgt = Math.max(2, (v / max) * 44);
        paint(doc, 'q ' + color(key === biggest ? PINK : INDIGO) + ' rg ' + roundedPath(x, base - hgt, step * 0.7, hgt, Math.min(1.2, step * 0.3)) + ' f Q');
      }
      rule(doc, base + 0.5, x0, x0 + plotW, 0.6, MUTED);
      text(doc, null, x0, base + 11, '1 ' + mon, { size: 8, fill: MUTED });
      if (inProgress && daysSoFar < lastDay - 3 && daysSoFar > 4) {
        text(doc, null, x0 + (daysSoFar - 0.5) * step, base + 11, daysSoFar + ' ' + mon + ' · today', { font: 'B', size: 8, align: 'center' });
      }
      text(doc, null, x0 + plotW, base + 11, lastDay + ' ' + mon, { size: 8, fill: MUTED, align: 'right' });
      if (biggest) text(doc, null, x0, base + 25, 'Biggest: ' + dayLabel(biggest) + ', ' + rm(byDay[biggest]), { font: 'B', size: 8.5, fill: PINK_INK });
    });

    // Compared With last month
    const cmpTop = chartTop + dayBoxH + 10;
    box(doc, rightX, cmpTop, rightW, 196 - dayBoxH - 10, 14);
    text(doc, tag('H2', root), rightX + 12, cmpTop + 20, 'Compared With ' + prevName, { font: 'B', size: 11.5 });
    figure(doc, prevTotal > 0
      ? monthName + (inProgress ? ' so far ' : ' ') + rm(total) + ', ' + prevName + ' ' + rm(prevTotal) + '.'
      : 'No entries in ' + prevName + ' to compare.', () => {
      if (!(prevTotal > 0)) {
        text(doc, null, rightX + 12, cmpTop + 44, 'No entries in ' + prevName + ' to compare.', { size: 9.5, fill: MUTED });
        return;
      }
      const barX = rightX + 38;
      const barW = rightW - 38 - 80;
      const max = Math.max(total, prevTotal);
      const rowsY = [cmpTop + 36, cmpTop + 52];
      [[mon, total, LILAC], [prevName.slice(0, 3), prevTotal, GREY_BAR]].forEach(([label, v, c], i) => {
        text(doc, null, rightX + 12, rowsY[i] + 3, label, { size: 9, fill: MUTED });
        paint(doc, 'q ' + color(c) + ' rg ' + roundedPath(barX, rowsY[i] - 5, Math.max(2, (v / max) * barW), 9, 4.5) + ' f Q');
        text(doc, null, RIGHT - 12, rowsY[i] + 3, rm(v), { font: i === 0 ? 'B' : 'R', size: 9, fill: i === 0 && vs ? vs.fill : INK, align: 'right' });
      });
      text(doc, null, rightX + 12, cmpTop + 70, monthName + (inProgress ? ' so far' : '') + ' vs all of ' + prevName + '.', { size: 8.5, fill: MUTED });
    });
    y = chartTop + 196 + 26;

    // --- By Category, with the change from last month ---
    text(doc, tag('H2', root), LEFT, y, 'By Category', { font: 'B', size: 12.5 });
    const catTable = tag('Table', root);
    const cols = [[LEFT, 'Category', 'left'], [LEFT + 288, 'Entries', 'right'], [LEFT + 378, 'Amount', 'right'], [LEFT + 432, 'Share', 'right'], [RIGHT, 'vs ' + prevName.slice(0, 3), 'right']];
    y += 24;
    const headRow = tag('TR', catTable);
    cols.forEach(([x, label, align]) => text(doc, tag('TH', headRow, { Scope: 'Column' }), x, y, label, { font: 'B', size: 10.5, align }));
    rule(doc, y + 8, LEFT, RIGHT, 0.9, INK);
    y += 25;
    for (const c of cats) {
      const row = tag('TR', catTable);
      const before = sum(previousEntries.filter((e) => e.category === c.name));
      const ch = prevTotal > 0 ? change(Math.round((c.amount - before) * 100) / 100) : { words: '—', fill: MUTED };
      const chWords = ch.words.replace('RM ', '');
      dot(doc, LEFT + 4, y - 3.6, c.name);
      text(doc, tag('TD', row), LEFT + 14, y, c.name, { size: 10.5 });
      text(doc, tag('TD', row), cols[1][0], y, String(c.n), { size: 10.5, align: 'right' });
      text(doc, tag('TD', row), cols[2][0], y, rm(c.amount), { size: 10.5, align: 'right' });
      text(doc, tag('TD', row), cols[3][0], y, share(c.amount) + '%', { size: 10.5, align: 'right' });
      text(doc, tag('TD', row), RIGHT, y, chWords, { font: 'B', size: 10.5, fill: ch.fill, align: 'right' });
      rule(doc, y + 9);
      y += 23;
    }

    // --- All Entries: a new page, oldest first, like a diary of the month ---
    addPage(doc);
    brand(doc);
    titleBlock(doc, subtitle, false);
    text(doc, tag('H2', root), LEFT, 114, 'All Entries, 1 to ' + daysSoFar + ' ' + mon, { font: 'B', size: 12.5 });
    doc.page.y = 138;
    const entryTable = tag('Table', root);
    entryHeader(doc, entryTable, false);
    for (const e of entries) {
      if (doc.page.y + 12 > BOTTOM_LIMIT) {
        // New page: repeat the header so each page makes sense on its own.
        // The repeats are decoration: the table is still one table.
        addPage(doc);
        brand(doc);
        titleBlock(doc, subtitle, false);
        text(doc, null, LEFT, 114, 'All Entries, Continued', { font: 'B', size: 12.5 });
        doc.page.y = 138;
        entryHeader(doc, entryTable, true);
      }
      const rowY = doc.page.y;
      const row = tag('TR', entryTable);
      text(doc, tag('TD', row), COLS.date, rowY, Number(e.date.slice(8)) + ' ' + mon, { size: 10.5, fill: MUTED });
      dot(doc, COLS.dot, rowY - 3.6, e.category);
      text(doc, tag('TD', row), COLS.category, rowY, e.category, { size: 10.5 });
      text(doc, tag('TD', row), COLS.note, rowY, fit(doc.fonts.R, e.note || '—', 10.5, NOTE_WIDTH), { size: 10.5, fill: e.note ? INK : MUTED });
      text(doc, tag('TD', row), COLS.amount, rowY, rm(e.amount), { size: 10.5, align: 'right' });
      rule(doc, rowY + 9);
      doc.page.y = rowY + ROW;
    }

    // --- Totals on the right, closing the statement ---
    // The totals block is about 96 points tall and may run down to just
    // above the footer line.
    if (doc.page.y + 96 > PAGE_H - 66) {
      addPage(doc);
      brand(doc);
      titleBlock(doc, subtitle, false);
      doc.page.y = 120;
    }
    y = doc.page.y + 10;
    const totalsX = LEFT + 252;
    [['Entries', String(entries.length)], ['Days with Spending', spendingDays + ' of ' + daysSoFar]].forEach(([label, value], i) => {
      const p = tag('P', root);
      text(doc, p, totalsX, y + i * 21, label, { size: 10.5, fill: MUTED });
      text(doc, p, RIGHT, y + i * 21, value, { size: 10.5, align: 'right' });
    });
    rule(doc, y + 31, totalsX, RIGHT, 0.9, INK);
    const final = tag('P', root);
    text(doc, final, totalsX, y + 52, inProgress ? 'Total as of ' + asOf : 'Total for ' + monthName, { font: 'B', size: 11.5 });
    text(doc, final, RIGHT, y + 52, rm(total), { font: 'B', size: 11.5, align: 'right' });
    text(doc, tag('P', root), LEFT, y + 84, 'This statement is for your own records. It is not a bank statement.', { size: 10, fill: MUTED });

    // --- Footer on every page (decoration) ---
    doc.pages.forEach((page, i) => {
      doc.page = page;
      rule(doc, PAGE_H - 58);
      text(doc, null, LEFT, PAGE_H - 38, 'Amounts in Malaysian Ringgit (RM). Receipt photos are not included.', { size: 9.5, fill: MUTED });
      text(doc, null, RIGHT, PAGE_H - 38, 'Page ' + (i + 1) + ' of ' + doc.pages.length, { size: 9.5, fill: MUTED, align: 'right' });
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
      const attrs = el.attributes && el.attributes.Scope ? ' /A << /O /Table /Scope /' + el.attributes.Scope + ' >>'
        : el.attributes && el.attributes.Alt ? ' /Alt ' + literal(el.attributes.Alt) : '';
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
   * Draws the app's "sen" mark (as on the sign-in screen: a near-black tile,
   * a blurred lilac-pink-peach glow rising from the bottom, and "sen" in
   * Geist) on a canvas, and saves it as a JPEG for the PDF.
   */
  async function makeLogo() {
    const w = 168;
    const h = 156;
    if (document.fonts && document.fonts.load) await document.fonts.load('700 57px Geist');
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0b0c10';
    ctx.fillRect(0, 0, w, h);
    // radial-gradient(95% 62% at 50% 108%, #ffc58a 0, #ff4f9a 30%, #7a4dff 60%, #0b0c10 92%), blurred
    ctx.save();
    ctx.filter = 'blur(14px)';
    ctx.translate(w / 2, h * 1.08);
    ctx.scale(1, (0.62 * h) / (0.95 * w));
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.95 * w);
    glow.addColorStop(0, '#ffc58a');
    glow.addColorStop(0.3, '#ff4f9a');
    glow.addColorStop(0.6, '#7a4dff');
    glow.addColorStop(0.92, '#0b0c10');
    ctx.fillStyle = glow;
    ctx.fillRect(-w, -h * 3, w * 2, h * 6);
    ctx.restore();
    ctx.fillStyle = '#f4f5f8';
    ctx.font = '700 57px Geist, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '-3px';
    ctx.fillText('sen', w / 2, h / 2 - 4);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
  }

  /**
   * Loads what every statement needs, once: the two Geist font files and the
   * app's mark (see makeLogo).
   */
  function load() {
    if (!loading) {
      const fetchFont = (file, name) => fetch(file).then((r) => {
        if (!r.ok) throw new Error('Could not load ' + file);
        return r.arrayBuffer();
      }).then((buffer) => readFont(new Uint8Array(buffer), name));
      const logo = makeLogo().catch(() => null); // no logo is better than no statement
      loading = Promise.all([fetchFont('fonts/Geist-Medium.ttf', 'Geist-Medium'), fetchFont('fonts/Geist-SemiBold.ttf', 'Geist-SemiBold'), logo])
        .then(([R, B, logoImage]) => ({ fonts: { R, B }, logo: logoImage }))
        .catch((err) => { loading = null; throw err; });
    }
    return loading;
  }

  /**
   * Builds the statement. entries: the month's saved entries, oldest first;
   * previousEntries: last month's, for the comparisons.
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
