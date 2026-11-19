'use strict';
// Bedienoberfläche: Zeichenfläche, Tastatur, Maus, Menüs, Dateien.

// ---------- Browser-Umgebung ----------
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
const FS = { canOpen: 'showOpenFilePicker' in window, canSave: 'showSaveFilePicker' in window };
const PICKER_TYPES = {
  mindmap: [{ description: 'Mindmap', accept: { 'application/json': ['.mindmap'] } }],
  markdown: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.txt'] } }],
  pdf: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
  png: [{ description: 'PNG-Bild', accept: { 'image/png': ['.png'] } }],
};
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- Zustand ----------
const S = {
  map: emptyMap(),
  layout: null,
  selection: null,
  undo: [], redo: [],
  pendingCreate: null,
  lastMap: null,
  path: null,          // Dateiname, null = noch nicht gespeichert
  handle: null,        // Datei-Handle (nur Chrome/Edge am Computer)
  untitledName: 'Unbenannt',
  savedText: null,
  dirty: false,
  zoom: 1, ox: 0, oy: 0,
  didInitialFit: false,
  editingId: null,
  theme: THEMES.light,
};

const $ = id => document.getElementById(id);
const stage = $('stage'), svg = $('canvas'), world = $('world'), editor = $('editor');

function themeNow() { return matchMedia('(prefers-color-scheme: dark)').matches ? THEMES.dark : THEMES.light; }

// ---------- Dokument ----------
function setDocument(map, path, untitledName) {
  S.map = map; S.lastMap = map; S.path = path; S.handle = null; S.untitledName = untitledName || 'Unbenannt';
  S.undo = []; S.redo = []; S.pendingCreate = null;
  S.savedText = path ? encodeMap(map) : null;
  S.selection = map.root.id;
  S.layout = new MapLayout(map);
  S.didInitialFit = false;
  if (S.editingId) endEditing(false);
  fitIfReady();
  render(); updateDirty();
}

function isPristine() {
  return !S.path && !S.undo.length && !S.redo.length && !S.editingId && isDefaultMap();
}

function docName() {
  if (S.path) return S.path.split(/[\\/]/).pop();
  return S.untitledName;
}

function updateDirty() {
  const text = encodeMap(S.map);
  S.dirty = S.savedText === null ? (S.undo.length > 0 || !isDefaultMap()) : text !== S.savedText;
  const title = (S.dirty ? '• ' : '') + docName() + ' – Mindmap';
  if (document.title !== title) document.title = title;
  $('docName').textContent = docName();
  $('docTitle').classList.toggle('dirty', S.dirty);
  persistDraft();
}
function isDefaultMap() { return S.map.root.children.length === 0 && S.map.root.title === 'Zentrales Thema'; }

function mapDidChange() {
  const m = S.map;
  if (S.selection && !findNode(m.root, S.selection)) {
    let fallback = m.root.id;
    let cur = S.lastMap ? parentOf(S.lastMap.root, S.selection) : null;
    while (cur) {
      if (findNode(m.root, cur.id)) { fallback = cur.id; break; }
      cur = parentOf(S.lastMap.root, cur.id);
    }
    S.selection = fallback;
  }
  S.lastMap = m;
  S.layout = new MapLayout(m);
  while (S.selection && !S.layout.boxes[S.selection]) {
    const p = parentOf(m.root, S.selection); if (!p) break; S.selection = p.id;
  }
  if (S.editingId && !S.layout.boxes[S.editingId]) endEditing(false);
  render(); updateEditorFrame(); updateDirty();
}

function setMap(newMap, previous, name) {
  S.map = newMap;
  S.undo.push({ map: previous, name });
  if (S.undo.length > 500) S.undo.shift();
  S.redo = [];
  mapDidChange();
}

function apply(name, change) {
  const m = cloneMap(S.map);
  change(m);
  if (encodeMap(m) === encodeMap(S.map)) return;
  setMap(m, S.map, name);
}

function undo() {
  commitEditing();
  const e = S.undo.pop(); if (!e) return;
  S.redo.push({ map: S.map, name: e.name });
  S.map = e.map; mapDidChange();
}
function redo() {
  commitEditing();
  const e = S.redo.pop(); if (!e) return;
  S.undo.push({ map: S.map, name: e.name });
  S.map = e.map; mapDidChange();
}

// ---------- Bearbeiten ----------
function addChild() {
  const sel = S.selection; if (!sel || !findNode(S.map.root, sel)) return;
  const m = cloneMap(S.map);
  const n = makeNode('Neues Thema');
  if (sel === m.root.id) { n.side = S.layout.lighterSide; n.color = leastUsed(m.root); }
  const target = findNode(m.root, sel);
  target.collapsed = false; target.children.push(n);
  beginCreate(m, n.id);
}
function addSibling() {
  const sel = S.selection; if (!sel) return;
  if (sel === S.map.root.id) { addChild(); return; }
  const parent = parentOf(S.map.root, sel); if (!parent) return;
  const idx = parent.children.findIndex(c => c.id === sel);
  const n = makeNode('Neues Thema');
  if (parent.id === S.map.root.id) { n.side = (S.layout.boxes[sel] || {}).side || 'right'; n.color = leastUsed(S.map.root); }
  const m = cloneMap(S.map);
  findNode(m.root, parent.id).children.splice(idx + 1, 0, n);
  beginCreate(m, n.id);
}
function beginCreate(m, id) {
  S.pendingCreate = { snapshot: S.map, id };
  S.map = m; S.selection = id;
  mapDidChange();
  ensureVisible(id);
  beginEditing(id, null);
}
function commitRename(id, title) {
  const t = title === null ? null : title.trim();
  const p = S.pendingCreate;
  if (p && p.id === id) {
    S.pendingCreate = null;
    const m = cloneMap(S.map);
    if (t) { const n = findNode(m.root, id); if (n) n.title = t; }
    setMap(m, p.snapshot, 'Neues Thema');
    return;
  }
  if (!t) { render(); return; }
  apply('Umbenennen', m => { const n = findNode(m.root, id); if (n) n.title = t; });
  render();
}
function deleteSelection() {
  const sel = S.selection; if (!sel || sel === S.map.root.id) return;
  const parent = parentOf(S.map.root, sel); if (!parent) return;
  const idx = parent.children.findIndex(c => c.id === sel);
  let next = parent.id;
  if (parent.id !== S.map.root.id) {
    if (idx + 1 < parent.children.length) next = parent.children[idx + 1].id;
    else if (idx > 0) next = parent.children[idx - 1].id;
  } else {
    const box = S.layout.boxes[sel];
    const same = S.layout.childrenOf(parent.id).filter(b => b.side === box.side && b.id !== sel);
    let best = null;
    for (const b of same) if (!best || Math.abs(midY(b.frame) - midY(box.frame)) < Math.abs(midY(best.frame) - midY(box.frame))) best = b;
    if (best) next = best.id;
  }
  apply('Thema löschen', m => removeDescendant(m.root, sel));
  S.selection = next; render();
  ensureVisible(next);
}
function toggleCollapse(id) {
  if (id === S.map.root.id) return;
  const n = findNode(S.map.root, id); if (!n || !n.children.length) return;
  const collapse = !n.collapsed;
  const sel = S.selection;
  apply(collapse ? 'Ast einklappen' : 'Ast ausklappen', m => { findNode(m.root, id).collapsed = collapse; });
  if (collapse && sel && sel !== id && findNode(n, sel)) { S.selection = id; render(); }
}
function setColor(id, hex) {
  if (id === S.map.root.id) return;
  apply('Farbe ändern', m => { const n = findNode(m.root, id); if (hex) n.color = hex; else delete n.color; });
}
function arrangeEvenly() {
  commitEditing();
  const kids = S.map.root.children;
  if (kids.length >= 2) {
    const sides = balancedSides(kids.map(c => S.layout.subtreeHeights[c.id] || 40), Style.vGap(1),
      kids.map(c => (S.layout.boxes[c.id] || {}).side || 'right'));
    apply('Gleichmäßig anordnen', m => m.root.children.forEach((c, i) => { if (i < sides.length) c.side = sides[i]; }));
  }
  fitToWindow(1);
}

function move(dir) {
  const sel = S.selection, L = S.layout;
  const box = sel && L.boxes[sel];
  if (!box) { S.selection = S.map.root.id; render(); return; }
  let target = null;
  const closest = (list, f) => { let best = null, bv = Infinity; for (const b of list) { const v = f(b); if (v < bv) { bv = v; best = b; } } return best; };
  if (dir === 'left' || dir === 'right') {
    if (box.depth === 0) {
      const t = closest(L.childrenOf(sel).filter(b => b.side === dir), b => Math.abs(midY(b.frame)));
      target = t && t.id;
    } else if (box.side === dir) {
      const t = closest(L.childrenOf(sel), b => Math.abs(midY(b.frame) - midY(box.frame)));
      target = t && t.id;
    } else target = box.parentId;
  } else if (box.parentId) {
    const up = dir === 'up';
    const sibs = L.childrenOf(box.parentId).filter(b => b.side === box.side).sort((a, b) => midY(a.frame) - midY(b.frame));
    const i = sibs.findIndex(b => b.id === sel);
    const j = up ? i - 1 : i + 1;
    if (i >= 0 && j >= 0 && j < sibs.length) target = sibs[j].id;
    if (!target) {
      const cands = L.order.map(id => L.boxes[id]).filter(b => b.depth > 0 && b.side === box.side &&
        (up ? midY(b.frame) < box.frame.y : midY(b.frame) > box.frame.y + box.frame.h));
      const t = closest(cands, b => Math.abs(midY(b.frame) - midY(box.frame)) + 2 * Math.abs(midX(b.frame) - midX(box.frame)));
      target = t && t.id;
    }
  }
  if (target) { S.selection = target; render(); ensureVisible(target); }
}

// ---------- Ansicht ----------
const MIN_ZOOM = 0.15, MAX_ZOOM = 4;
function viewSize() { return { w: stage.clientWidth, h: stage.clientHeight }; }
function toModel(px, py) { return { x: (px - S.ox) / S.zoom, y: (py - S.oy) / S.zoom }; }
function toView(r) { return { x: r.x * S.zoom + S.ox, y: r.y * S.zoom + S.oy, w: r.w * S.zoom, h: r.h * S.zoom }; }

function applyTransform() {
  world.setAttribute('transform', `translate(${S.ox} ${S.oy}) scale(${S.zoom})`);
  updateEditorFrame();
}
function render() {
  S.theme = themeNow();
  world.innerHTML = renderSVG(S.layout, S.theme, { selection: S.selection, editing: S.editingId });
  applyTransform();
  $('zoomLabel').textContent = Math.round(S.zoom * 100) + ' %';
}
function setZoom(z, px, py) {
  const nz = Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM);
  const m = toModel(px, py);
  S.zoom = nz; S.ox = px - m.x * nz; S.oy = py - m.y * nz;
  applyTransform();
  $('zoomLabel').textContent = Math.round(S.zoom * 100) + ' %';
}
function zoomIn() { const v = viewSize(); setZoom(S.zoom * 1.25, v.w / 2, v.h / 2); }
function zoomOut() { const v = viewSize(); setZoom(S.zoom / 1.25, v.w / 2, v.h / 2); }
function actualSize() {
  const v = viewSize(); const r = S.layout.boxes[S.map.root.id].frame;
  S.zoom = 1; S.ox = v.w / 2 - midX(r); S.oy = v.h / 2 - midY(r);
  applyTransform(); $('zoomLabel').textContent = '100 %';
}
function fitToWindow(maxZoom = 2) {
  const v = viewSize(), b = S.layout.bounds;
  if (v.w <= 0 || v.h <= 0) return;
  const z = Math.min(maxZoom, Math.min(v.w / b.w, v.h / b.h));
  S.zoom = Math.min(Math.max(z, MIN_ZOOM), MAX_ZOOM);
  S.ox = v.w / 2 - midX(b) * S.zoom; S.oy = v.h / 2 - midY(b) * S.zoom;
  applyTransform(); $('zoomLabel').textContent = Math.round(S.zoom * 100) + ' %';
}
function fitIfReady() {
  const v = viewSize();
  if (!S.didInitialFit && v.w > 50 && v.h > 50) { S.didInitialFit = true; fitToWindow(1); }
}
function ensureVisible(id) {
  const b = S.layout.boxes[id]; if (!b) return;
  const v = viewSize();
  const r = inset(toView(b.frame), -30, -30);
  let dx = 0, dy = 0;
  if (r.w > v.w) dx = v.w / 2 - midX(r); else if (r.x < 0) dx = -r.x; else if (r.x + r.w > v.w) dx = v.w - (r.x + r.w);
  if (r.h > v.h) dy = v.h / 2 - midY(r); else if (r.y < 0) dy = -r.y; else if (r.y + r.h > v.h) dy = v.h - (r.y + r.h);
  if (dx || dy) { S.ox += dx; S.oy += dy; applyTransform(); }
}

let lastSize = null;
new ResizeObserver(() => {
  const v = viewSize();
  if (!S.didInitialFit) fitIfReady();
  else if (lastSize) { S.ox += (v.w - lastSize.w) / 2; S.oy += (v.h - lastSize.h) / 2; applyTransform(); }
  lastSize = v;
}).observe(stage);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { render(); styleEditor(); });

// ---------- Umbenennen ----------
function beginEditing(id, initialText) {
  if (S.editingId) commitEditing();
  const box = S.layout.boxes[id]; if (!box) return;
  S.editingId = id;
  editor.value = initialText !== null && initialText !== undefined ? initialText : box.title;
  editor.style.display = 'block';
  styleEditor(); updateEditorFrame(); render();
  editor.focus();
  if (initialText !== null && initialText !== undefined) editor.setSelectionRange(editor.value.length, editor.value.length);
  else editor.select();
}
function styleEditor() {
  const t = themeNow();
  editor.style.background = t.nodeFill; editor.style.color = t.text;
}
function updateEditorFrame() {
  const id = S.editingId; if (!id) return;
  const box = S.layout.boxes[id]; if (!box) return;
  const d = box.depth, z = S.zoom;
  editor.style.font = `${Style.weight(d)} ${Style.size(d) * z}px ${FONT_FAMILY}`;
  editor.style.lineHeight = (Style.lineH(d) * z) + 'px';
  let r = toView(box.frame);
  const minW = 200 * z;
  if (r.w < minW) r = inset(r, -(minW - r.w) / 2, 0);
  const inner = inset(r, 4 * z, 0);
  editor.style.left = inner.x + 'px'; editor.style.width = inner.w + 'px';
  editor.style.height = '0px';
  const h = Math.max(editor.scrollHeight, Style.lineH(d) * z);
  editor.style.height = h + 'px';
  editor.style.top = (midY(r) - h / 2) + 'px';
}
function commitEditing() { endEditing(true); }
function endEditing(commit) {
  const id = S.editingId; if (!id) return;
  S.editingId = null;
  const text = editor.value;
  editor.style.display = 'none';
  if (document.activeElement === editor) editor.blur();
  stage.focus({ preventScroll: true });
  commitRename(id, commit ? text : null);
  render();
}
editor.addEventListener('keydown', e => {
  if (e.isComposing) return;
  if ((e.ctrlKey || e.metaKey) && ['s', 'o', 'n', 'w'].includes(e.key.toLowerCase())) return; // weiter an die Fenster-Tastenkürzel
  if (e.key === 'Enter') { e.preventDefault(); endEditing(true); }
  else if (e.key === 'Escape') { e.preventDefault(); endEditing(false); }
  else if (e.key === 'Tab') { e.preventDefault(); endEditing(true); addChild(); }
  e.stopPropagation();
});
editor.addEventListener('input', updateEditorFrame);
editor.addEventListener('blur', () => { if (S.editingId) endEditing(true); });

// ---------- Maus ----------
let pan = null;
stage.addEventListener('mousedown', e => {
  if (e.target === editor) return;
  closeMenus();
  if (e.button !== 0) return;
  commitEditing();
  stage.focus({ preventScroll: true });
  const rect = stage.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const m = toModel(px, py);
  const ind = S.layout.hitIndicator(m);
  if (ind) { toggleCollapse(ind); return; }
  const hit = S.layout.hitNode(m);
  if (hit) {
    S.selection = hit; render();
    if (e.detail === 2) beginEditing(hit, null);
    e.preventDefault();
    return;
  }
  pan = { x: e.clientX, y: e.clientY, ox: S.ox, oy: S.oy };
  e.preventDefault();
});
window.addEventListener('mousemove', e => {
  if (!pan) return;
  S.ox = pan.ox + e.clientX - pan.x; S.oy = pan.oy + e.clientY - pan.y;
  stage.classList.add('panning');
  applyTransform();
});
window.addEventListener('mouseup', () => { pan = null; stage.classList.remove('panning'); });

stage.addEventListener('wheel', e => {
  e.preventDefault();
  const rect = stage.getBoundingClientRect();
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  let dx = e.deltaX, dy = e.deltaY;
  if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
  if (e.ctrlKey) {
    const f = Math.min(1.25, Math.max(0.8, Math.exp(-dy * 0.01)));
    setZoom(S.zoom * f, px, py);
    return;
  }
  if (e.shiftKey && !dx) { dx = dy; dy = 0; }
  S.ox -= dx; S.oy -= dy; applyTransform();
}, { passive: false });

// ---------- Touch (iPhone/iPad) ----------
let T = null, longPress = null;
const tdist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
stage.addEventListener('touchstart', e => {
  if (e.target === editor) return;
  e.preventDefault();
  closeMenus();
  clearTimeout(longPress);
  if (e.touches.length === 1) {
    const t = e.touches[0];
    T = { mode: 'tap', x: t.clientX, y: t.clientY, ox: S.ox, oy: S.oy };
    longPress = setTimeout(() => {
      if (!T || T.mode !== 'tap') return;
      const rect = stage.getBoundingClientRect();
      const id = S.layout.hitNode(toModel(T.x - rect.left, T.y - rect.top));
      if (!id) return;
      T.mode = 'done';
      commitEditing();
      S.selection = id; render();
      openNodeMenu(id, T.x, T.y);
    }, 550);
  } else {
    const [a, b] = e.touches;
    const rect = stage.getBoundingClientRect();
    T = { mode: 'pinch', d: Math.max(tdist(a, b), 1), zoom: S.zoom,
      m: toModel((a.clientX + b.clientX) / 2 - rect.left, (a.clientY + b.clientY) / 2 - rect.top) };
  }
}, { passive: false });
stage.addEventListener('touchmove', e => {
  if (e.target === editor || !T) return;
  e.preventDefault();
  if (T.mode === 'pinch' && e.touches.length >= 2) {
    const [a, b] = e.touches;
    const rect = stage.getBoundingClientRect();
    const z = Math.min(Math.max(T.zoom * tdist(a, b) / T.d, MIN_ZOOM), MAX_ZOOM);
    const cx = (a.clientX + b.clientX) / 2 - rect.left, cy = (a.clientY + b.clientY) / 2 - rect.top;
    S.zoom = z; S.ox = cx - T.m.x * z; S.oy = cy - T.m.y * z;
    applyTransform(); $('zoomLabel').textContent = Math.round(S.zoom * 100) + ' %';
    return;
  }
  const t = e.touches[0];
  if (T.mode === 'tap' && Math.hypot(t.clientX - T.x, t.clientY - T.y) > 8) { T.mode = 'pan'; clearTimeout(longPress); }
  if (T.mode === 'pan') { S.ox = T.ox + t.clientX - T.x; S.oy = T.oy + t.clientY - T.y; applyTransform(); }
}, { passive: false });
stage.addEventListener('touchend', e => {
  if (e.target === editor || !T) return;
  e.preventDefault();
  clearTimeout(longPress);
  if (e.touches.length === 1) { // von zwei Fingern auf einen: weiter verschieben
    const t = e.touches[0];
    T = { mode: 'pan', x: t.clientX, y: t.clientY, ox: S.ox, oy: S.oy };
    return;
  }
  if (e.touches.length === 0) {
    const g = T; T = null;
    if (g.mode === 'tap') handleTap(g.x, g.y);
  }
}, { passive: false });
stage.addEventListener('touchcancel', () => { clearTimeout(longPress); T = null; });
function handleTap(x, y) {
  const rect = stage.getBoundingClientRect();
  const m = toModel(x - rect.left, y - rect.top);
  const ind = S.layout.hitIndicator(m);
  if (ind) { commitEditing(); toggleCollapse(ind); return; }
  const hit = S.layout.hitNode(m);
  if (!hit) { commitEditing(); return; }
  if (S.editingId === hit) return;
  // Zweites Antippen eines schon ausgewählten Themas: umbenennen
  if (hit === S.selection && !S.editingId) { beginEditing(hit, null); return; }
  commitEditing();
  S.selection = hit; render();
}
// iOS: Seitenzoom verhindern; Safari am Mac: Trackpad-Zoom
let gestureZoom = null;
document.addEventListener('gesturestart', e => {
  e.preventDefault();
  if (!IS_TOUCH && e.target.closest && e.target.closest('#stage')) gestureZoom = S.zoom;
});
document.addEventListener('gesturechange', e => {
  e.preventDefault();
  if (gestureZoom === null) return;
  const rect = stage.getBoundingClientRect();
  setZoom(gestureZoom * e.scale, e.clientX - rect.left, e.clientY - rect.top);
});
document.addEventListener('gestureend', e => { e.preventDefault(); gestureZoom = null; });

// Bildschirmtastatur: bearbeitetes Thema sichtbar halten
function keepEditorVisible() {
  if (!S.editingId || !window.visualViewport) return;
  const box = S.layout.boxes[S.editingId]; if (!box) return;
  const rect = stage.getBoundingClientRect();
  const r = toView(box.frame);
  const bottom = visualViewport.height + visualViewport.offsetTop - rect.top - 24;
  if (r.y + r.h > bottom) { S.oy -= r.y + r.h - bottom; applyTransform(); }
}
if (window.visualViewport) visualViewport.addEventListener('resize', () => setTimeout(keepEditorVisible, 50));

// ---------- Kontextmenü ----------
const ctxMenu = $('ctxmenu');
stage.addEventListener('contextmenu', e => {
  e.preventDefault();
  commitEditing();
  const rect = stage.getBoundingClientRect();
  const id = S.layout.hitNode(toModel(e.clientX - rect.left, e.clientY - rect.top));
  if (!id) { closeMenus(); return; }
  S.selection = id; render();
  openNodeMenu(id, e.clientX, e.clientY);
});
function openNodeMenu(id, x, y) {
  closeMenus();
  const box = S.layout.boxes[id], node = findNode(S.map.root, id);
  if (!box || !node) return;
  const items = [];
  items.push(['Unterthema hinzufügen', 'Tab', addChild]);
  if (box.depth > 0) items.push(['Thema danach hinzufügen', 'Enter', addSibling]);
  items.push(['Umbenennen', 'F2', () => beginEditing(id, null)]);
  if (box.depth > 0 && box.childCount > 0) items.push([box.collapsed ? 'Ast ausklappen' : 'Ast einklappen', 'Leertaste', () => toggleCollapse(id)]);
  let html = items.map((it, i) => `<div class="mi" data-i="${i}"><span>${it[0]}</span><kbd>${it[1]}</kbd></div>`).join('');
  if (box.depth > 0) {
    const cur = node.color ? node.color.toUpperCase() : null;
    html += '<div class="sep"></div><div class="mlabel">Farbe</div><div class="swatches">' +
      PALETTE.map(([n, h]) => `<button class="sw${cur === h ? ' on' : ''}" title="${n}" data-color="${h}" style="background:${h}"></button>`).join('') +
      '</div>' +
      `<div class="mi${!node.color ? ' checked' : ''}" data-color=""><span>${box.depth === 1 ? 'Standardfarbe' : 'Vom übergeordneten Ast erben'}</span><kbd>${!node.color ? '✓' : ''}</kbd></div>` +
      '<div class="sep"></div><div class="mi danger" data-del="1"><span>Löschen</span><kbd>Entf</kbd></div>';
  }
  ctxMenu.innerHTML = html;
  ctxMenu.onclick = ev => {
    const t = ev.target.closest('[data-i],[data-color],[data-del]'); if (!t) return;
    closeMenus();
    S.selection = id;
    if (t.dataset.i !== undefined) items[+t.dataset.i][2]();
    else if (t.dataset.color !== undefined) setColor(id, t.dataset.color || null);
    else if (t.dataset.del) deleteSelection();
  };
  ctxMenu.style.display = 'block';
  const mw = ctxMenu.offsetWidth, mh = ctxMenu.offsetHeight;
  ctxMenu.style.left = Math.max(4, Math.min(x, innerWidth - mw - 4)) + 'px';
  ctxMenu.style.top = Math.max(4, Math.min(y, innerHeight - mh - 4)) + 'px';
}

// ---------- Menüleiste ----------
const MENUS = {
  datei: [
    ['Neu', 'Strg+N', () => newDocument()],
    ['Öffnen …', 'Strg+O', () => openDocument()],
    ['Speichern', 'Strg+S', () => save()],
    ['Speichern unter …', 'Strg+Umschalt+S', () => saveAs()],
    '-',
    ['Markdown importieren …', 'Strg+Umschalt+I', () => importMarkdownDialog()],
    '-',
    ['Als PDF exportieren …', '', () => exportAs('pdf')],
    ['Als Markdown exportieren …', '', () => exportAs('markdown')],
    ['Als PNG exportieren …', '', () => exportAs('png')],
    '-',
    ['Ablage auf dem iPhone …', '', () => showSyncHelp()],
  ],
  bearbeiten: [
    [() => 'Rückgängig' + (S.undo.length ? ': ' + S.undo[S.undo.length - 1].name : ''), 'Strg+Z', undo, () => S.undo.length > 0],
    [() => 'Wiederholen' + (S.redo.length ? ': ' + S.redo[S.redo.length - 1].name : ''), 'Strg+Y', redo, () => S.redo.length > 0],
    '-',
    ['Unterthema hinzufügen', 'Tab', addChild],
    ['Thema danach hinzufügen', 'Enter', addSibling],
    ['Umbenennen', 'F2', () => S.selection && beginEditing(S.selection, null)],
    ['Ast ein-/ausklappen', 'Leertaste', () => S.selection && toggleCollapse(S.selection), () => S.selection !== S.map.root.id],
    ['Thema löschen', 'Entf', deleteSelection, () => S.selection !== S.map.root.id],
  ],
  ansicht: [
    ['Vergrößern', 'Strg++', zoomIn],
    ['Verkleinern', 'Strg+−', zoomOut],
    ['Originalgröße', 'Strg+0', actualSize],
    ['Ganze Map zeigen', 'Strg+Umschalt+0', () => fitToWindow()],
    '-',
    ['Gleichmäßig anordnen', 'Strg+Umschalt+L', arrangeEvenly],
  ],
  hilfe: [
    ['Tastenkürzel …', 'F1', () => showHelp()],
    ['Über Mindmap', '', () => showAbout()],
  ],
};
let openMenu = null;
function closeMenus() {
  ctxMenu.style.display = 'none';
  $('dropdown').style.display = 'none';
  document.querySelectorAll('.menubtn.open').forEach(b => b.classList.remove('open'));
  openMenu = null;
}
function showMenu(name, btn) {
  closeMenus();
  commitEditing();
  const dd = $('dropdown');
  const TITLES = { datei: 'Datei', bearbeiten: 'Bearbeiten', ansicht: 'Ansicht', hilfe: 'Hilfe' };
  const items = name === 'alle'
    ? Object.keys(MENUS).flatMap((k, i) => [...(i ? ['-'] : []), ['#' + TITLES[k]], ...MENUS[k]])
    : MENUS[name];
  dd.innerHTML = items.map((it, i) => {
    if (it === '-') return '<div class="sep"></div>';
    if (it.length === 1) return `<div class="mlabel">${it[0].slice(1)}</div>`;
    const label = typeof it[0] === 'function' ? it[0]() : it[0];
    const enabled = !it[3] || it[3]();
    return `<div class="mi${enabled ? '' : ' disabled'}" data-i="${i}"><span>${label}</span><kbd>${it[1]}</kbd></div>`;
  }).join('');
  dd.onclick = ev => {
    const t = ev.target.closest('[data-i]'); if (!t || t.classList.contains('disabled')) return;
    closeMenus(); items[+t.dataset.i][2]();
  };
  const r = btn.getBoundingClientRect();
  dd.style.left = Math.max(4, Math.min(r.left, innerWidth - dd.offsetWidth - 4)) + 'px'; dd.style.top = r.bottom + 'px';
  dd.style.display = 'block';
  btn.classList.add('open'); openMenu = name;
}
$('menuBtn').addEventListener('click', e => {
  e.stopPropagation();
  if (openMenu === 'alle') closeMenus(); else showMenu('alle', $('menuBtn'));
});
document.querySelectorAll('.menubtn').forEach(btn => {
  btn.addEventListener('mousedown', e => {
    e.preventDefault(); e.stopPropagation();
    if (openMenu === btn.dataset.menu) closeMenus(); else showMenu(btn.dataset.menu, btn);
  });
  btn.addEventListener('mouseenter', () => { if (openMenu && openMenu !== btn.dataset.menu) showMenu(btn.dataset.menu, btn); });
});
document.addEventListener('mousedown', e => {
  if (!e.target.closest('#dropdown,#ctxmenu,.menubtn,#menuBtn,[data-tool=color]')) closeMenus();
});

// Symbolleiste
const TOOL_ACTIONS = {
  addChild: () => { commitEditing(); addChild(); }, addSibling: () => { commitEditing(); addSibling(); },
  delete: () => { commitEditing(); deleteSelection(); }, arrange: arrangeEvenly,
  zoomOut, zoomIn, fit: () => fitToWindow(), undo, redo,
  rename: () => { if (S.selection) beginEditing(S.selection, null); },
  open: () => openDocument(), save: () => save(),
};
document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.tool === 'color') {
    commitEditing();
    const id = S.selection;
    if (!id || id === S.map.root.id) { closeMenus(); return; }
    if (ctxMenu.style.display === 'block') { closeMenus(); return; }
    const r = b.getBoundingClientRect();
    openNodeMenu(id, r.left, r.top - 8);
    const mh = ctxMenu.offsetHeight; ctxMenu.style.top = Math.max(4, r.top - mh - 6) + 'px';
    return;
  }
  closeMenus(); TOOL_ACTIONS[b.dataset.tool]();
  if (!S.editingId) stage.focus({ preventScroll: true });
}));
document.querySelectorAll('.toolbar button').forEach(b => b.addEventListener('mousedown', e => e.preventDefault()));

// ---------- Tastatur ----------
document.addEventListener('keydown', e => {
  if (e.target === editor) {
    // Speichern & Co. funktionieren auch während des Umbenennens
    if (!((e.ctrlKey || e.metaKey) && ['s', 'o', 'n', 'w'].includes(e.key.toLowerCase()))) return;
    commitEditing();
  }
  if ($('modal').style.display === 'flex') {
    if (e.key === 'Escape') { e.preventDefault(); hideModal(); }
    else if (e.key === 'Enter') { e.preventDefault(); const b = $('modalActions').querySelector('button.primary'); if (b) b.click(); else hideModal(); }
    return;
  }
  if (e.key === 'Escape' && (openMenu || ctxMenu.style.display === 'block')) { closeMenus(); return; }
  if (e.key === 'F1') { e.preventDefault(); showHelp(); return; }
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && !e.altKey) {
    const k = e.key.toLowerCase();
    let handled = true;
    if (e.code === 'Digit0' || e.code === 'Numpad0') { e.shiftKey ? fitToWindow() : actualSize(); }
    else if (k === '+' || k === '=' || e.code === 'NumpadAdd') zoomIn();
    else if (k === '-' || e.code === 'NumpadSubtract') zoomOut();
    else if (k === 'z' && !e.shiftKey) undo();
    else if (k === 'y' || (k === 'z' && e.shiftKey)) redo();
    else if (k === 'n') newDocument();
    else if (k === 'o') openDocument();
    else if (k === 's') e.shiftKey ? saveAs() : save();
    else if (k === 'i' && e.shiftKey) importMarkdownDialog();
    else if (k === 'l' && e.shiftKey) arrangeEvenly();
    else handled = false;
    e.preventDefault();
    return;
  }
  if (e.altKey) return;
  closeMenus();
  switch (e.key) {
    case 'Tab':
      e.preventDefault();
      if (e.shiftKey) { const b = S.layout.boxes[S.selection]; move(b && b.side === 'left' ? 'right' : 'left'); }
      else addChild();
      return;
    case 'Enter': e.preventDefault(); addSibling(); return;
    case 'Delete': case 'Backspace': e.preventDefault(); deleteSelection(); return;
    case 'F2': e.preventDefault(); if (S.selection) beginEditing(S.selection, null); return;
    case 'ArrowLeft': e.preventDefault(); move('left'); return;
    case 'ArrowRight': e.preventDefault(); move('right'); return;
    case 'ArrowUp': e.preventDefault(); move('up'); return;
    case 'ArrowDown': e.preventDefault(); move('down'); return;
    case ' ': e.preventDefault(); if (S.selection) toggleCollapse(S.selection); return;
    case 'F5': case 'F3': case 'F7': case 'F12': e.preventDefault(); return;
  }
  if (!S.selection) return;
  if (e.key === 'Dead' || e.key === 'Process') { beginEditing(S.selection, ''); return; } // Akzente/IME: Eingabe dem Textfeld überlassen
  if (e.key.length === 1 || (e.key.length === 2 && /[\uD800-\uDBFF]/.test(e.key[0]))) {
    e.preventDefault();
    beginEditing(S.selection, e.key);
  }
});

// Dateien ins Fenster ziehen: .mindmap öffnen, Markdown importieren
window.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('drop', async e => {
  e.preventDefault();
  const items = [...(e.dataTransfer.items || [])].filter(i => i.kind === 'file');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  let handle = null;
  try { if (items[0] && items[0].getAsFileSystemHandle) handle = await items[0].getAsFileSystemHandle(); } catch (err) { handle = null; }
  await openFile(f, handle && handle.kind === 'file' ? handle : null);
});

// ---------- Dialoge ----------
let modalState = null;
function dialog(title, html, buttons) {
  if (modalState) modalState.done(modalState.cancel);
  return new Promise(resolve => {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = html;
    const act = $('modalActions'); act.innerHTML = '';
    const state = { cancel: buttons[0].value, done: v => { if (modalState !== state) return; modalState = null; $('modal').style.display = 'none'; if (!S.editingId) stage.focus({ preventScroll: true }); resolve(v); } };
    if (buttons.length > 1) state.cancel = buttons.find(b => b.cancel)?.value ?? null;
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.primary) el.className = 'primary';
      if (b.danger) el.className = 'danger';
      // Aktionen laufen direkt im Klick, damit iOS „Teilen“ erlaubt
      el.addEventListener('click', () => {
        if (b.action) { const r = b.action(); state.done(r); } else state.done(b.value);
      });
      act.appendChild(el);
    }
    modalState = state;
    $('modal').style.display = 'flex';
  });
}
function showModal(title, html) { return dialog(title, html, [{ label: 'OK', value: true, primary: true }]); }
function hideModal() { if (modalState) modalState.done(modalState.cancel); }
$('modal').addEventListener('mousedown', e => { if (e.target === $('modal')) hideModal(); });
async function alertBox(msg, title = 'Mindmap') { await showModal(title, escHtml(msg).replace(/\n/g, '<br>')); }
function errMsg(e) { return e && e.message ? e.message : String(e); }

// Ungesicherte Änderungen? true = weitermachen
async function confirmDiscard() {
  commitEditing(); updateDirty();
  if (!S.dirty) return true;
  const ans = await dialog('Änderungen sichern?',
    `„${escHtml(docName())}“ wurde geändert. Möchtest du die Änderungen vorher sichern?`,
    [{ label: 'Abbrechen', value: 'cancel', cancel: true }, { label: 'Nicht sichern', value: 'no', danger: true }, { label: 'Sichern …', primary: true, action: () => save() }]);
  if (ans === 'cancel') return false;
  if (ans === 'no') return true;
  return (await ans) === true;
}

// ---------- Dateien ----------
function pickFile(kind) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    // iOS kennt .mindmap nicht und würde sonst alle Dateien ausgrauen
    if (kind === 'markdown') input.accept = IS_IOS ? '' : '.md,.markdown,.txt,text/markdown,text/plain';
    else if (!IS_IOS) input.accept = '.mindmap,application/json';
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
    input.addEventListener('cancel', () => { resolve(null); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}
async function chooseFile(kind) {
  if (FS.canOpen) {
    try {
      const [h] = await window.showOpenFilePicker({ types: PICKER_TYPES[kind], excludeAcceptAllOption: false, id: 'mindmap' });
      return { file: await h.getFile(), handle: h };
    } catch (e) { if (e.name === 'AbortError') return null; throw e; }
  }
  const f = await pickFile(kind);
  return f ? { file: f, handle: null } : null;
}

function newDocument() {
  (async () => {
    if (!(await confirmDiscard())) return;
    setDocument(emptyMap(), null);
  })().catch(e => alertBox(errMsg(e)));
}

async function openDocument() {
  commitEditing();
  try {
    const r = await chooseFile('mindmap');
    if (r) await openFile(r.file, r.handle);
  } catch (e) { alertBox('Die Datei konnte nicht geöffnet werden.\n\n' + errMsg(e)); }
}
async function openFile(file, handle) {
  try {
    const text = await file.text();
    const base = file.name.replace(/\.[^.]+$/, '');
    if (MarkdownImporter.isMarkdownName(file.name)) {
      const map = MarkdownImporter.parse(text, base);
      if (!(await confirmDiscard())) return;
      setDocument(map, null, base); updateDirty();
      return;
    }
    const map = decodeMap(text);
    if (!(await confirmDiscard())) return;
    setDocument(map, file.name);
    S.handle = handle || null;
    updateDirty();
  } catch (e) { alertBox('Die Datei konnte nicht geöffnet werden.\n\n' + errMsg(e)); }
}
async function importMarkdownDialog() {
  commitEditing();
  try {
    const r = await chooseFile('markdown');
    if (!r) return;
    const text = await r.file.text();
    const name = r.file.name.replace(/\.[^.]+$/, '');
    const map = MarkdownImporter.parse(text, name);
    if (!(await confirmDiscard())) return;
    setDocument(map, null, name); updateDirty();
  } catch (e) { alertBox('Import fehlgeschlagen.\n\n' + errMsg(e)); }
}

function safeBase() {
  let base = S.path ? docName().replace(/\.mindmap$/i, '') : (S.untitledName !== 'Unbenannt' ? S.untitledName : S.map.root.title);
  base = base.replace(/[\\/:*?"<>|\r\n]+/g, '-').trim();
  return base || 'Mindmap';
}

async function writeHandle(h, data) {
  if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Keine Schreibberechtigung für die Datei.');
  }
  const w = await h.createWritable();
  await w.write(data); await w.close();
}
function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; a.style.display = 'none';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// iPhone/iPad: Teilen-Menü („In Dateien sichern“); sonst Download
function shareableFile(file) {
  if (!navigator.canShare) return null;
  const types = file.type === 'application/x-mindmap' ? ['application/octet-stream', 'application/json', 'text/plain'] : [file.type];
  for (const t of types) {
    const f = new File([file], file.name, { type: t });
    try { if (navigator.canShare({ files: [f] })) return f; } catch (e) { /* weiter */ }
  }
  return null;
}
async function deliverFile(file) {
  const f = IS_TOUCH ? shareableFile(file) : null;
  if (!f) { downloadFile(file); return true; }
  const share = () => navigator.share({ files: [f] }).then(() => true, e => {
    if (e.name === 'AbortError') return false;
    downloadFile(file); return true;
  });
  try {
    await navigator.share({ files: [f] });
    return true;
  } catch (e) {
    if (e.name === 'AbortError') return false;
    if (e.name !== 'NotAllowedError') { downloadFile(file); return true; }
    // Das Erzeugen hat zu lange gedauert: iOS will einen neuen Fingertipp
    return await dialog('Datei ist fertig', `„${escHtml(file.name)}“ kann jetzt gesichert werden.`,
      [{ label: 'Abbrechen', value: false, cancel: true }, { label: 'Sichern …', primary: true, action: share }]);
  }
}

async function save() {
  commitEditing();
  if (!S.handle) return saveAs();
  try {
    const text = encodeMap(S.map);
    await writeHandle(S.handle, text);
    S.savedText = text; updateDirty();
    return true;
  } catch (e) { await alertBox('Speichern fehlgeschlagen.\n\n' + errMsg(e)); return false; }
}
async function saveAs() {
  commitEditing();
  const name = (S.path && /\.mindmap$/i.test(S.path)) ? S.path : safeBase() + '.mindmap';
  const text = encodeMap(S.map);
  try {
    if (FS.canSave) {
      let h;
      try { h = await window.showSaveFilePicker({ suggestedName: name, types: PICKER_TYPES.mindmap, id: 'mindmap' }); }
      catch (e) { if (e.name === 'AbortError') return false; throw e; }
      await writeHandle(h, text);
      S.path = h.name; S.handle = h;
    } else {
      const ok = await deliverFile(new File([text], name, { type: 'application/x-mindmap' }));
      if (!ok) return false;
      S.path = name;
    }
    S.savedText = text; updateDirty();
    return true;
  } catch (e) { await alertBox('Speichern fehlgeschlagen.\n\n' + errMsg(e)); return false; }
}

function b64ToBytes(b64) { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
async function exportAs(kind) {
  commitEditing();
  const ext = { pdf: '.pdf', markdown: '.md', png: '.png' }[kind];
  const mime = { pdf: 'application/pdf', markdown: 'text/markdown', png: 'image/png' }[kind];
  const name = safeBase() + ext;
  try {
    let handle = null;
    if (FS.canSave) {
      try { handle = await window.showSaveFilePicker({ suggestedName: name, types: PICKER_TYPES[kind], id: 'export' }); }
      catch (e) { if (e.name === 'AbortError') return; throw e; }
    }
    document.body.classList.add('busy');
    await new Promise(r => setTimeout(r, 30));
    let data;
    if (kind === 'markdown') data = new TextEncoder().encode(exportMarkdown(S.map));
    else if (kind === 'png') data = b64ToBytes(await pngBase64(S.map, 2));
    else data = b64ToBytes(await pdfBase64(S.map));
    document.body.classList.remove('busy');
    if (handle) await writeHandle(handle, data);
    else await deliverFile(new File([data], name, { type: mime }));
  } catch (e) {
    await alertBox('Export fehlgeschlagen.\n\n' + errMsg(e));
  } finally { document.body.classList.remove('busy'); }
}

async function pngBase64(map, scale) {
  const { svg: svgText, layout } = exportSVG(map);
  const b = layout.bounds;
  let sc = scale;
  while ((b.w * sc > 16000 || b.h * sc > 16000 || b.w * b.h * sc * sc > 200e6) && sc > 0.25) sc /= 2;
  if (b.w * sc > 16000 || b.h * sc > 16000) throw new Error('Die Map ist zu groß für einen Bildexport.');
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('Bild konnte nicht erzeugt werden.')); img.src = url; });
    const c = document.createElement('canvas');
    c.width = Math.ceil(b.w * sc); c.height = Math.ceil(b.h * sc);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1];
  } finally { URL.revokeObjectURL(url); }
}

// Im Browser gibt es keine Systemschriften für jsPDF: Helvetica (mit Umlauten) wird verwendet.
async function loadPdfFonts() { return {}; }
async function pdfBase64(map) {
  const { jsPDF } = window.jspdf;
  const files = await loadPdfFonts();
  const layout0 = new MapLayout(map);
  const b = layout0.bounds;
  const doc = new jsPDF({ orientation: b.w > b.h ? 'l' : 'p', unit: 'pt', format: [b.w, b.h], compress: true });
  let fonts;
  const reg = (file, fam) => { doc.addFileToVFS(file, files[file]); doc.addFont(file, fam, 'normal'); return { family: fam, weight: 'normal' }; };
  if (files['segoeui.ttf']) {
    const regular = reg('segoeui.ttf', 'MMRegular');
    const semibold = files['seguisb.ttf'] ? reg('seguisb.ttf', 'MMSemibold') : regular;
    const bold = files['segoeuib.ttf'] ? reg('segoeuib.ttf', 'MMBold') : semibold;
    fonts = { regular, semibold, bold };
  } else {
    fonts = { regular: { family: 'helvetica', weight: 'normal' }, semibold: { family: 'helvetica', weight: 'bold' }, bold: { family: 'helvetica', weight: 'bold' } };
  }
  const measure = (text, d, fs) => {
    const f = d === 'count' ? fonts.bold : d === 0 ? fonts.bold : d === 1 ? fonts.semibold : fonts.regular;
    doc.setFont(f.family, f.weight);
    doc.setFontSize(d === 'count' ? fs : Style.size(d));
    return doc.getTextWidth(text);
  };
  const { svg: svgText } = exportSVG(map, { pdfFonts: fonts, shadow: false, measure });
  const el = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden';
  holder.appendChild(document.importNode(el, true));
  document.body.appendChild(holder);
  try {
    await doc.svg(holder.firstChild, { x: 0, y: 0, width: b.w, height: b.h });
  } finally { holder.remove(); }
  doc.setProperties({ title: map.root.title, creator: 'Mindmap' });
  const out = doc.output('datauristring');
  return out.slice(out.indexOf(',') + 1);
}


// ---------- Entwurf (übersteht Neustart der App) ----------
const DRAFT_KEY = 'mindmap.entwurf.v1';
let draftTimer = null;
function persistDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(writeDraft, 250);
}
function writeDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      text: encodeMap(S.map), path: S.path, untitled: S.untitledName, saved: S.savedText,
    }));
  } catch (e) { /* privater Modus o. Ä. */ }
}
function restoreDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { d = null; }
  if (!d || typeof d.text !== 'string') return false;
  try {
    setDocument(decodeMap(d.text), d.path || null, d.untitled || 'Unbenannt');
    S.savedText = typeof d.saved === 'string' ? d.saved : null;
    updateDirty();
    return true;
  } catch (e) { return false; }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writeDraft(); });
window.addEventListener('pagehide', writeDraft);
window.addEventListener('beforeunload', e => { writeDraft(); if (S.dirty && !IS_TOUCH) { e.preventDefault(); e.returnValue = ''; } });

// ---------- Hilfe ----------
function showHelp() {
  const touch = [
    ['Thema auswählen', 'Antippen'], ['Umbenennen', 'Ausgewähltes Thema noch einmal antippen oder ✎'],
    ['Unterthema / gleiche Ebene', 'Knöpfe unten'], ['Farbe, Löschen, Einklappen', 'Thema lange drücken oder Farbknopf'],
    ['Ast ein-/ausklappen', 'Kreis am Thema antippen'], ['Verschieben', 'Mit einem Finger ziehen'],
    ['Zoomen', 'Mit zwei Fingern auf- oder zuziehen'],
  ];
  const keys = [
    ['Unterthema anlegen', 'Tab'], ['Thema auf gleicher Ebene', 'Enter (an der Wurzel: neuer Hauptast)'],
    ['Thema löschen', 'Entf oder Rücktaste'], ['Umbenennen', 'Doppelklick, F2 oder einfach lostippen'],
    ['Umbenennen beenden', 'Enter übernimmt, Esc bricht ab, Tab legt gleich ein Unterthema an'],
    ['Auswahl bewegen', 'Pfeiltasten'], ['Ast ein-/ausklappen', 'Klick auf den Kreis oder Leertaste'],
    ['Astfarbe ändern', 'Rechtsklick auf ein Thema'], ['Zoomen', 'Strg/⌘ + Mausrad, Strg/⌘ + und −, Strg/⌘+0 = 100 %'],
    ['Ansicht verschieben', 'Mausrad oder auf freier Fläche ziehen'],
    ['Gleichmäßig anordnen', 'Strg/⌘+Umschalt+L'], ['Rückgängig / Wiederholen', 'Strg/⌘+Z / Strg/⌘+Y'],
    ['Öffnen / Speichern', 'Strg/⌘+O / Strg/⌘+S'], ['Markdown importieren', 'Strg/⌘+Umschalt+I oder Datei ins Fenster ziehen'],
  ];
  const rows = IS_TOUCH ? touch : keys;
  showModal(IS_TOUCH ? 'Bedienung' : 'Tastenkürzel', '<table>' + rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('') + '</table>');
}
function showSyncHelp() {
  showModal('Mit dem Mac abwechselnd arbeiten', `
<ol>
<li><b>Öffnen:</b> Ordner-Knopf oben, dann im Dateien-Fenster „iCloud Drive“ wählen und die <code>.mindmap</code>-Datei antippen (dieselbe Datei, die der Mac benutzt).</li>
<li><b>Bearbeiten.</b> Deine Arbeit bleibt auf dem iPhone erhalten, auch wenn die App geschlossen wird.</li>
<li><b>Sichern:</b> Diskette oben, dann „In Dateien sichern“, denselben iCloud-Ordner wählen und „Ersetzen“ tippen.</li>
</ol>
<p>Am Mac öffnest du die Datei danach wie gewohnt. Bevor du auf dem anderen Gerät weitermachst, die Datei dort neu öffnen, damit du den neuesten Stand hast.</p>`);
}
function showAbout() {
  showModal('Über Mindmap', '<p><b>Mindmap im Browser</b>, Version 1.0</p><p>Öffnet und speichert dieselben <code>.mindmap</code>-Dateien wie die Mac- und die Windows-App. Export als PDF, Markdown und PNG. Funktioniert auch ohne Internet.</p>');
}

// ---------- Start ----------
function start() {
  S.layout = new MapLayout(S.map);
  S.selection = S.map.root.id;
  render(); fitIfReady(); updateDirty();
  restoreDraft();
  stage.focus({ preventScroll: true });
  // Installierte App am Computer (Chrome/Edge): .mindmap-Dateien per Doppelklick öffnen
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async params => {
      const h = params.files && params.files[0];
      if (h) await openFile(await h.getFile(), h);
    });
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
start();
