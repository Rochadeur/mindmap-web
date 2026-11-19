'use strict';
// Datenmodell, Dateiformat (kompatibel zur Mac-App), Layout, Zeichnen, Markdown.

const PALETTE = [
  ['Rot', '#E5484D'], ['Orange', '#F08C2E'], ['Gelb', '#D9A514'], ['Grün', '#3FA35B'],
  ['Türkis', '#12A0A0'], ['Blau', '#3E7BFA'], ['Violett', '#8E4EC6'], ['Rosa', '#D6409F'],
  ['Grau', '#80838D'],
];
function defaultHex(i) { const order = [5, 3, 1, 6, 4, 0, 7, 2]; return PALETTE[order[i % order.length]][1]; }
function leastUsed(root) {
  const used = {};
  root.children.forEach((c, i) => { const h = c.color || defaultHex(i); used[h] = (used[h] || 0) + 1; });
  let best = null;
  for (let i = 0; i < 8; i++) { const h = defaultHex(i); if (best === null || (used[h] || 0) < (used[best] || 0)) best = h; }
  return best;
}

function newId() {
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function makeNode(title, children = []) { return { id: newId(), title, children, collapsed: false }; }
function emptyMap() { return { root: makeNode('Zentrales Thema') }; }
function cloneMap(m) { return JSON.parse(JSON.stringify(m)); }

function findNode(n, id) {
  if (n.id === id) return n;
  for (const c of n.children) { const f = findNode(c, id); if (f) return f; }
  return null;
}
function parentOf(n, id) {
  for (const c of n.children) {
    if (c.id === id) return n;
    const p = parentOf(c, id); if (p) return p;
  }
  return null;
}
function removeDescendant(n, id) {
  const i = n.children.findIndex(c => c.id === id);
  if (i >= 0) { n.children.splice(i, 1); return true; }
  return n.children.some(c => removeDescendant(c, id));
}
function nodeCount(n) { return 1 + n.children.reduce((s, c) => s + nodeCount(c), 0); }

// ---------- Dateiformat ----------
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function decodeNode(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('Ungültiges Thema in der Datei.');
  const n = {
    id: typeof o.id === 'string' && UUID_RE.test(o.id) ? o.id.toUpperCase() : newId(),
    title: typeof o.title === 'string' ? o.title : '',
    children: Array.isArray(o.children) ? o.children.map(decodeNode) : [],
    collapsed: o.collapsed === true,
  };
  if (typeof o.color === 'string') n.color = o.color;
  if (o.side === 'left' || o.side === 'right') n.side = o.side;
  return n;
}
function decodeMap(text) {
  let o;
  try { o = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error('Die Datei ist keine gültige Mindmap-Datei (kein JSON).'); }
  if (!o || typeof o !== 'object' || !o.root) throw new Error('Die Datei ist keine gültige Mindmap-Datei.');
  return { root: decodeNode(o.root) };
}
function encodeNode(n) {
  const o = { id: n.id, title: n.title };
  if (n.children.length) o.children = n.children.map(encodeNode);
  if (n.collapsed) o.collapsed = true;
  if (n.color) o.color = n.color;
  if (n.side) o.side = n.side;
  return o;
}
// Gleiche Schreibweise wie Swifts JSONEncoder (.prettyPrinted, .sortedKeys)
function swiftJSON(v, ind = '') {
  if (Array.isArray(v)) {
    if (!v.length) return '[\n\n' + ind + ']';
    return '[\n' + v.map(x => ind + '  ' + swiftJSON(x, ind + '  ')).join(',\n') + '\n' + ind + ']';
  }
  if (v && typeof v === 'object') {
    const ks = Object.keys(v).sort();
    return '{\n' + ks.map(k => ind + '  ' + JSON.stringify(k) + ' : ' + swiftJSON(v[k], ind + '  ')).join(',\n') + '\n' + ind + '}';
  }
  return JSON.stringify(v).replace(/\//g, '\\/');
}
function encodeMap(m) { return swiftJSON({ format: 'mindmap', version: 1, root: encodeNode(m.root) }); }

// ---------- Stil & Text ----------
const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
const Style = {
  size: d => d === 0 ? 20 : d === 1 ? 15 : 13,
  weight: d => d === 0 ? 700 : d === 1 ? 600 : 400,
  font: d => `${Style.weight(d)} ${Style.size(d)}px ${FONT_FAMILY}`,
  lineH: d => Math.round(Style.size(d) * 1.3),
  pad: d => d === 0 ? [22, 13] : d === 1 ? [14, 8] : [10, 5],
  minW: d => d === 0 ? 140 : d === 1 ? 80 : 44,
  radius: d => d === 0 ? 16 : d === 1 ? 10 : 7,
  hGap: d => d <= 1 ? 58 : 42,
  vGap: d => d <= 1 ? 20 : 9,
  lineW: d => d === 1 ? 3.5 : d === 2 ? 2.4 : 1.6,
  maxTextWidth: 260,
};

let _measureCtx = null;
const _measureCache = new Map();
function textWidth(s, font) {
  const k = font + '\u0000' + s;
  let w = _measureCache.get(k);
  if (w === undefined) {
    if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
    _measureCtx.font = font;
    w = _measureCtx.measureText(s).width;
    if (_measureCache.size > 20000) _measureCache.clear();
    _measureCache.set(k, w);
  }
  return w;
}
function wrapText(text, font, maxW) {
  const out = [];
  const paras = (text === '' ? ' ' : text).split(/\r\n|\r|\n/);
  for (const para of paras) {
    const words = para.split(/ +/);
    let line = '';
    for (let word of words) {
      const test = line ? line + ' ' + word : word;
      if (textWidth(test, font) <= maxW) { line = test; continue; }
      if (line) out.push(line);
      line = '';
      // überlanges Wort zeichenweise umbrechen
      while (textWidth(word, font) > maxW && word.length > 1) {
        let i = 1;
        while (i < word.length && textWidth(word.slice(0, i + 1), font) <= maxW) i++;
        out.push(word.slice(0, i));
        word = word.slice(i);
      }
      line = word;
    }
    out.push(line === '' ? ' ' : line);
  }
  return out;
}

// ---------- Layout (wie MapLayout.swift) ----------
function rectUnion(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
function inset(r, dx, dy) { return { x: r.x + dx, y: r.y + dy, w: r.w - 2 * dx, h: r.h - 2 * dy }; }
function contains(r, p) { return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h; }
function midY(r) { return r.y + r.h / 2; }
function midX(r) { return r.x + r.w / 2; }

function indicatorRect(b) {
  if (b.depth === 0 || b.childCount === 0) return null;
  const cx = b.side === 'right' ? b.frame.x + b.frame.w + 11 : b.frame.x - 11;
  return { x: cx - 8, y: midY(b.frame) - 8, w: 16, h: 16 };
}

function resolveSides(root, subH) {
  const res = {}; let hr = 0, hl = 0;
  for (const c of root.children) if (c.side) {
    res[c.id] = c.side;
    if (c.side === 'right') hr += subH[c.id] || 0; else hl += subH[c.id] || 0;
  }
  for (const c of root.children) if (!c.side) {
    if (hr <= hl) { res[c.id] = 'right'; hr += subH[c.id] || 0; } else { res[c.id] = 'left'; hl += subH[c.id] || 0; }
  }
  return res;
}

class MapLayout {
  constructor(map) {
    const sizes = {}, lines = {}, subH = {};
    const measure = (n, depth) => {
      const font = Style.font(depth);
      const ls = wrapText(n.title, font, Style.maxTextWidth);
      const tw = Math.ceil(Math.max(...ls.map(l => textWidth(l, font))));
      const th = ls.length * Style.lineH(depth);
      const [px, py] = Style.pad(depth);
      const size = { w: Math.max(Style.minW(depth), tw + 2 * px), h: th + 2 * py };
      sizes[n.id] = size; lines[n.id] = ls;
      let h = size.h;
      if ((depth === 0 || !n.collapsed) && n.children.length) {
        const kids = n.children.map(c => measure(c, depth + 1));
        const total = kids.reduce((a, b) => a + b, 0) + Style.vGap(depth + 1) * (kids.length - 1);
        h = Math.max(h, total);
      }
      subH[n.id] = h;
      return h;
    };
    const root = map.root;
    measure(root, 0);
    const sides = resolveSides(root, subH);
    const boxes = {}; const order = [];

    const place = (n, depth, parent, side, centerY, anchorX, color) => {
      const s = sizes[n.id];
      const gap = Style.hGap(depth);
      const x = side === 'right' ? anchorX + gap : anchorX - gap - s.w;
      const frame = { x, y: centerY - s.h / 2, w: s.w, h: s.h };
      boxes[n.id] = { id: n.id, parentId: parent, title: n.title, lines: lines[n.id], depth, side, frame,
        color, childCount: n.children.length, collapsed: n.collapsed };
      order.push(n.id);
      if (n.collapsed || !n.children.length) return;
      const vg = Style.vGap(depth + 1);
      const total = n.children.reduce((a, c) => a + (subH[c.id] || 0), 0) + vg * (n.children.length - 1);
      let y = centerY - total / 2;
      const ax = side === 'right' ? frame.x + frame.w : frame.x;
      for (const c of n.children) {
        const h = subH[c.id] || 0;
        place(c, depth + 1, n.id, side, y + h / 2, ax, c.color || color);
        y += h + vg;
      }
    };

    const rs = sizes[root.id];
    const rootFrame = { x: -rs.w / 2, y: -rs.h / 2, w: rs.w, h: rs.h };
    boxes[root.id] = { id: root.id, parentId: null, title: root.title, lines: lines[root.id], depth: 0, side: 'right',
      frame: rootFrame, color: null, childCount: root.children.length, collapsed: false };
    order.push(root.id);

    for (const side of ['right', 'left']) {
      const kids = root.children.map((c, i) => [i, c]).filter(([, c]) => sides[c.id] === side);
      if (!kids.length) continue;
      const vg = Style.vGap(1);
      const total = kids.reduce((a, [, c]) => a + (subH[c.id] || 0), 0) + vg * (kids.length - 1);
      let y = -total / 2;
      const ax = side === 'right' ? rootFrame.x + rootFrame.w : rootFrame.x;
      for (const [idx, c] of kids) {
        const h = subH[c.id] || 0;
        place(c, 1, root.id, side, y + h / 2, ax, c.color || defaultHex(idx));
        y += h + vg;
      }
    }

    let b = rootFrame;
    for (const id of order) {
      const box = boxes[id];
      b = rectUnion(b, box.frame);
      const ir = indicatorRect(box); if (ir) b = rectUnion(b, ir);
    }
    b = inset(b, -48, -48);
    const x0 = Math.floor(b.x), y0 = Math.floor(b.y);
    this.bounds = { x: x0, y: y0, w: Math.ceil(b.x + b.w) - x0, h: Math.ceil(b.y + b.h) - y0 };
    this.boxes = boxes; this.order = order; this.subtreeHeights = subH;
  }

  get lighterSide() {
    let rmin = Infinity, rmax = -Infinity, lmin = Infinity, lmax = -Infinity;
    for (const id of this.order) {
      const b = this.boxes[id]; if (b.depth < 1) continue;
      if (b.side === 'right') { rmin = Math.min(rmin, b.frame.y); rmax = Math.max(rmax, b.frame.y + b.frame.h); }
      else { lmin = Math.min(lmin, b.frame.y); lmax = Math.max(lmax, b.frame.y + b.frame.h); }
    }
    const hr = rmax > rmin ? rmax - rmin : 0, hl = lmax > lmin ? lmax - lmin : 0;
    return hr <= hl ? 'right' : 'left';
  }
  hitNode(p) {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const b = this.boxes[this.order[i]];
      if (contains(inset(b.frame, -2, -2), p)) return b.id;
    }
    return null;
  }
  hitIndicator(p) {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const r = indicatorRect(this.boxes[this.order[i]]);
      if (r && contains(inset(r, -3, -3), p)) return this.order[i];
    }
    return null;
  }
  childrenOf(id) { return this.order.map(i => this.boxes[i]).filter(b => b.parentId === id); }
}

// Beste Aufteilung der Hauptäste (wie MapController.balancedSides)
function balancedSides(hs, gap, current) {
  const n = hs.length;
  const sideH = (cnt, sum) => cnt === 0 ? 0 : sum + gap * (cnt - 1);
  const total = hs.reduce((a, b) => a + b, 0);
  if (n <= 16) {
    let best = { diff: Infinity, penalty: Infinity, mask: 0 };
    for (let mask = 1; mask < (1 << n) - 1; mask++) {
      let sum = 0, cnt = 0, changes = 0;
      for (let i = 0; i < n; i++) {
        const right = (mask & (1 << i)) !== 0;
        if (right) { sum += hs[i]; cnt++; }
        if ((right ? 'right' : 'left') !== current[i]) changes++;
      }
      const diff = Math.abs(sideH(cnt, sum) - sideH(n - cnt, total - sum));
      const penalty = (cnt < n - cnt ? 1000 : 0) + changes;
      if (diff < best.diff - 0.5 || (Math.abs(diff - best.diff) <= 0.5 && penalty < best.penalty)) best = { diff, penalty, mask };
    }
    return [...Array(n).keys()].map(i => (best.mask & (1 << i)) ? 'right' : 'left');
  }
  const res = Array(n).fill('right'); let hr = 0, hl = 0;
  [...Array(n).keys()].sort((a, b) => hs[b] - hs[a]).forEach(i => {
    if (hr <= hl) { res[i] = 'right'; hr += hs[i] + gap; } else { res[i] = 'left'; hl += hs[i] + gap; }
  });
  return res;
}

// ---------- Zeichnen (SVG; Bildschirm, PNG und PDF nutzen denselben Code) ----------
function rgb(r, g, b) { return '#' + [r, g, b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase(); }
const THEMES = {
  light: { dark: false, background: rgb(0.975, 0.972, 0.962), text: rgb(0.13, 0.14, 0.16), rootFill: rgb(0.17, 0.18, 0.22),
    rootText: '#FFFFFF', nodeFill: '#FFFFFF', selection: '#2F7BF6' },
  dark: { dark: true, background: rgb(0.115, 0.12, 0.13), text: rgb(0.92, 0.92, 0.93), rootFill: rgb(0.92, 0.905, 0.87),
    rootText: rgb(0.10, 0.10, 0.12), nodeFill: rgb(0.17, 0.18, 0.20), selection: '#4C8DFF' },
};
function parseHex(hex) {
  let s = (hex || '').trim(); if (s.startsWith('#')) s = s.slice(1);
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return [128, 128, 140];
  const v = parseInt(s, 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
function colorHex(hex) { return '#' + parseHex(hex).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase(); }
function blend(hex, f, bgHex) {
  const a = parseHex(hex), b = parseHex(bgHex);
  return '#' + a.map((v, i) => Math.round(v * (1 - f) + b[i] * f).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const f1 = v => Math.round(v * 100) / 100;

// opts: { selection, editing, pdfFonts: {regular, semibold, bold} | null, shadow: bool }
function renderSVG(layout, theme, opts = {}) {
  const out = [];
  const fontAttr = (d) => {
    if (opts.pdfFonts) {
      const fam = d === 0 ? opts.pdfFonts.bold : d === 1 ? opts.pdfFonts.semibold : opts.pdfFonts.regular;
      return `font-family="${fam.family}" font-weight="${fam.weight}"`;
    }
    return `font-family="${esc(FONT_FAMILY)}" font-weight="${Style.weight(d)}"`;
  };
  if (opts.shadow !== false) {
    out.push(`<defs><filter id="mmShadow" x="-30%" y="-40%" width="160%" height="190%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="${theme.dark ? 0.5 : 0.18}"/></filter></defs>`);
  }
  // Verbindungen
  for (const id of layout.order) {
    const b = layout.boxes[id]; if (!b.parentId) continue;
    const p = layout.boxes[b.parentId];
    const r = b.side === 'right';
    const sx = p.depth === 0 ? (r ? p.frame.x + p.frame.w - 10 : p.frame.x + 10) : (r ? p.frame.x + p.frame.w : p.frame.x);
    const sy = midY(p.frame);
    const ex = r ? b.frame.x : b.frame.x + b.frame.w, ey = midY(b.frame);
    const c1x = sx + (ex - sx) * 0.55, c2x = sx + (ex - sx) * 0.45;
    out.push(`<path d="M${f1(sx)} ${f1(sy)}C${f1(c1x)} ${f1(sy)} ${f1(c2x)} ${f1(ey)} ${f1(ex)} ${f1(ey)}" fill="none" stroke="${colorHex(b.color)}" stroke-opacity="${theme.dark ? 0.85 : 0.9}" stroke-width="${Style.lineW(b.depth)}" stroke-linecap="round"/>`);
  }
  // Knoten
  for (const id of layout.order) {
    const b = layout.boxes[id];
    const fr = b.frame, d = b.depth, rad = Style.radius(d);
    const branch = colorHex(b.color);
    const rect = `x="${f1(fr.x)}" y="${f1(fr.y)}" width="${f1(fr.w)}" height="${f1(fr.h)}" rx="${rad}" ry="${rad}"`;
    let textColor;
    if (d === 0) {
      out.push(`<rect ${rect} fill="${theme.rootFill}"${opts.shadow !== false ? ' filter="url(#mmShadow)"' : ''}/>`);
      textColor = theme.rootText;
    } else if (d === 1) {
      out.push(`<rect ${rect} fill="${blend(branch, theme.dark ? 0.70 : 0.84, theme.background)}" stroke="${branch}" stroke-width="1.6"/>`);
      textColor = theme.text;
    } else {
      out.push(`<rect ${rect} fill="${theme.nodeFill}" stroke="${branch}" stroke-opacity="0.65" stroke-width="1"/>`);
      textColor = theme.text;
    }
    if (b.id === opts.selection) {
      const s = inset(fr, -4, -4);
      out.push(`<rect x="${f1(s.x)}" y="${f1(s.y)}" width="${f1(s.w)}" height="${f1(s.h)}" rx="${rad + 4}" ry="${rad + 4}" fill="none" stroke="${theme.selection}" stroke-width="2.5"/>`);
    }
    if (b.id !== opts.editing) {
      const size = Style.size(d), lh = Style.lineH(d), [, py] = Style.pad(d);
      const cx = midX(fr);
      if (opts.measure) {
        // PDF: Zeilen einzeln und linksbündig setzen, Breite mit der PDF-Schrift gemessen
        b.lines.forEach((l, i) => {
          const w = opts.measure(l, d);
          out.push(`<text ${fontAttr(d)} font-size="${size}" fill="${textColor}" x="${f1(cx - w / 2)}" y="${f1(fr.y + py + i * lh + lh / 2 + size * 0.35)}">${esc(l)}</text>`);
        });
      } else {
        const tspans = b.lines.map((l, i) =>
          `<tspan x="${f1(cx)}" y="${f1(fr.y + py + i * lh + lh / 2 + size * 0.35)}">${esc(l)}</tspan>`).join('');
        out.push(`<text ${fontAttr(d)} font-size="${size}" fill="${textColor}" text-anchor="middle" xml:space="preserve">${tspans}</text>`);
      }
    }
    const ir = indicatorRect(b);
    if (ir) {
      const cx = midX(ir), cy = midY(ir);
      if (b.collapsed) {
        const label = b.childCount > 99 ? '99+' : String(b.childCount);
        const fs = label.length > 1 ? 8 : 9.5;
        out.push(`<circle cx="${f1(cx)}" cy="${f1(cy)}" r="8" fill="${branch}"/>`);
        const fa = opts.pdfFonts ? `font-family="${opts.pdfFonts.bold.family}" font-weight="${opts.pdfFonts.bold.weight}"` : `font-family="${esc(FONT_FAMILY)}" font-weight="700"`;
        const lx = opts.measure ? cx - opts.measure(label, 'count', fs) / 2 : cx;
        out.push(`<text ${fa} font-size="${fs}" fill="#FFFFFF"${opts.measure ? '' : ' text-anchor="middle"'} x="${f1(lx)}" y="${f1(cy + fs * 0.35)}">${label}</text>`);
      } else {
        out.push(`<circle cx="${f1(cx)}" cy="${f1(cy)}" r="8" fill="${theme.background}" stroke="${branch}" stroke-width="1.4"/>`);
        out.push(`<path d="M${f1(cx - 4)} ${f1(cy)}L${f1(cx + 4)} ${f1(cy)}" stroke="${branch}" stroke-width="1.6" stroke-linecap="round"/>`);
      }
    }
  }
  return out.join('');
}

// Komplettes SVG-Dokument der ganzen Map (für Export)
function exportSVG(map, opts = {}) {
  const layout = new MapLayout(map);
  const b = layout.bounds, theme = THEMES.light;
  const inner = renderSVG(layout, theme, { ...opts, selection: null, editing: null });
  return {
    layout,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${b.w}" height="${b.h}" viewBox="${b.x} ${b.y} ${b.w} ${b.h}">` +
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${theme.background}"/>${inner}</svg>`,
  };
}

// ---------- Markdown ----------
function exportMarkdown(map) {
  const clean = s => s.replace(/\r\n|\n|\r/g, ' ').trim();
  let out = `# ${clean(map.root.title)}\n`;
  if (map.root.children.length) out += '\n';
  const walk = (n, level) => {
    out += '  '.repeat(level) + '- ' + clean(n.title) + '\n';
    n.children.forEach(c => walk(c, level + 1));
  };
  map.root.children.forEach(c => walk(c, 0));
  return out;
}

const MarkdownImporter = {
  isMarkdownName(name) { return /\.(md|markdown|mdown|mkd|txt)$/i.test(name); },

  parse(text, fallbackTitle) {
    const item = (title, isParagraph = false) => ({ title, children: [], isParagraph });
    const top = item('');
    const stack = [{ rank: 0, item: top }];
    let inFence = false, sawHeading = false;
    let lines = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (lines.length && lines[0].trim() === '---') {
      const end = lines.slice(1).findIndex(l => l.trim() === '---');
      if (end >= 0) lines = lines.slice(end + 2);
    }
    const add = (it, rank, push) => {
      while (stack.length > 1 && stack[stack.length - 1].rank >= rank) stack.pop();
      stack[stack.length - 1].item.children.push(it);
      if (push) stack.push({ rank, item: it });
    };
    for (const raw of lines) {
      const trimmed = raw.replace(/^[ \t]+|[ \t]+$/g, '');
      if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) { inFence = !inFence; continue; }
      if (inFence || !trimmed) continue;
      if (this.isRule(trimmed)) continue;
      if (trimmed.startsWith('|') || trimmed.startsWith('<!--')) continue;
      const h = this.heading(trimmed);
      if (h) {
        const t = this.clean(h[1]);
        if (t) { sawHeading = true; add(item(t), h[0], true); }
        continue;
      }
      const indent = this.indentWidth(raw);
      const content = this.listContent(trimmed);
      if (content !== null) {
        const t = this.clean(content);
        if (t) add(item(t), 100 + indent, true);
        continue;
      }
      let p = trimmed;
      while (p.startsWith('>')) p = p.slice(1).trim();
      const t = this.clean(p);
      if (t) add(item(t, true), stack[stack.length - 1].rank + 1, false);
    }
    let rootItem;
    if (top.children.length === 1) rootItem = top.children[0];
    else if (top.children.length && top.children[0].isParagraph && !sawHeading) {
      rootItem = top.children[0];
      rootItem.children = top.children.slice(1);
    } else {
      const name = (fallbackTitle || '').trim();
      rootItem = item(name || 'Importierte Map');
      rootItem.children = top.children;
    }
    const toNode = it => makeNode(it.title, it.children.map(toNode));
    return { root: toNode(rootItem) };
  },
  isRule(s) {
    const c = s.replace(/ /g, '');
    if (c.length < 3 || !'-*_'.includes(c[0])) return false;
    return [...c].every(ch => ch === c[0]);
  },
  heading(s) {
    const m = /^(#{1,7})(.*)$/.exec(s);
    if (!m || m[1].length > 6) return null;
    if (m[2] && m[2][0] !== ' ' && m[2][0] !== '\t') return null;
    let title = m[2].trim();
    title = title.replace(/#+$/, '');
    return [m[1].length, title.trim()];
  },
  indentWidth(s) {
    let w = 0;
    for (const ch of s) { if (ch === ' ') w += 1; else if (ch === '\t') w += 4; else break; }
    return w;
  },
  listContent(s) {
    const f = s[0];
    if ('-*+•'.includes(f)) {
      const rest = s.slice(1);
      if (rest && rest[0] !== ' ' && rest[0] !== '\t') return null;
      return this.stripCheckbox(rest.trim());
    }
    const m = /^(\d{1,9})([.)])([ \t].*|)$/.exec(s);
    if (!m) return null;
    return this.stripCheckbox(m[3].trim());
  },
  stripCheckbox(s) {
    for (const box of ['[ ] ', '[x] ', '[X] ']) if (s.startsWith(box)) return s.slice(box.length);
    return s;
  },
  clean(s) {
    let t = s;
    const re = (p, r) => { t = t.replace(p, r); };
    re(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    re(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    re(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
    re(/\[\[([^\]]+)\]\]/g, '$1');
    re(/<(https?:\/\/[^>]+)>/g, '$1');
    re(/`([^`]*)`/g, '$1');
    re(/(\*\*|__)(.+?)\1/g, '$2');
    re(/~~(.+?)~~/g, '$1');
    re(/(?<![\p{L}\p{N}_*])\*(?!\s)(.+?)(?<!\s)\*(?![\p{L}\p{N}_*])/gu, '$1');
    re(/(?<![\p{L}\p{N}_])_(?!\s)(.+?)(?<!\s)_(?![\p{L}\p{N}_])/gu, '$1');
    re(/<[^>]+>/g, '');
    re(/\\([\\`*_{}\[\]()#+\-.!])/g, '$1');
    re(/\s+/g, ' ');
    return t.trim();
  },
};

if (typeof module !== 'undefined') module.exports = { MarkdownImporter, decodeMap, encodeMap, exportMarkdown, balancedSides };
