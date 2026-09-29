// Home Inventory - user interface.
// Views (hash routes): #/ home map, #/unit/<id>, #/slot/<id>, #/labels, #/settings.
// Typing in the search box shows results on top of whatever view is open.

import { createStore } from './store.js';
import { buildSeed } from './seed.js';

const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
const QRGEN_URL = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
const COLLECTIONS = ['units', 'slots', 'items'];

// ---------------------------------------------------------------- helpers

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Lower case without accents, so "cajon" finds "Cajón".
const norm = v => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const natural = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const intOr = (v, fallback) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; };
const numOrNull = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };

function who(email) {
  if (!email) return 'someone';
  const name = email.split('@')[0].replace(/[._-]+/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return plural(Math.floor(s / 86400), 'day') + ' ago';
  return new Date(ts).toLocaleDateString();
}

const scriptCache = {};
function loadScript(url) {
  return (scriptCache[url] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = resolve;
    s.onerror = () => { delete scriptCache[url]; reject(new Error('Could not load ' + url)); };
    document.head.appendChild(s);
  }));
}

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Not an image')); };
    img.src = url;
  });
}

// Shrinks a photo to a JPEG data URL (small enough to live inside the database).
function toJpeg(img, maxSide, quality) {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

// ---------------------------------------------------------------- state

const S = {
  authKnown: false,
  user: null,
  units: new Map(),
  slots: new Map(),
  items: new Map(),
  ready: new Set(),
  error: null,
  query: '',
  editing: null,       // unit id whose layout is being edited
  flashItem: null,     // item to highlight after navigating to its shelf
  labelUnits: null,    // Set of unit ids selected on the labels page
  lastSlotId: null,    // last shelf used when adding, preselected next time
  pendingRender: false,
};
let D = {};            // derived indexes, rebuilt on every data change
let store;
let unsubscribers = [];

function derive() {
  const slotsByUnit = new Map();
  const itemsBySlot = new Map();
  const slotByTag = new Map();
  for (const s of S.slots.values()) {
    if (!slotsByUnit.has(s.unitId)) slotsByUnit.set(s.unitId, []);
    slotsByUnit.get(s.unitId).push(s);
    slotByTag.set(norm(s.tag), s);
  }
  for (const list of slotsByUnit.values()) list.sort((a, b) => a.row - b.row || a.col - b.col);
  for (const it of S.items.values()) {
    if (!itemsBySlot.has(it.slotId)) itemsBySlot.set(it.slotId, []);
    itemsBySlot.get(it.slotId).push(it);
  }
  for (const list of itemsBySlot.values()) list.sort((a, b) => natural(a.name, b.name));

  const units = [...S.units.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || natural(a.name, b.name));
  const rooms = new Map();
  for (const u of units) {
    const room = u.room || 'Other';
    if (!rooms.has(room)) rooms.set(room, []);
    rooms.get(room).push(u);
  }
  const categories = [...new Set([...S.items.values()].map(i => i.category).filter(Boolean))].sort(natural);
  const allSlots = [...S.slots.values()].sort((a, b) => natural(a.tag, b.tag));
  D = { slotsByUnit, itemsBySlot, slotByTag, units, rooms, categories, allSlots };
}

const itemsInSlot = id => D.itemsBySlot.get(id) || [];
const slotsInUnit = id => D.slotsByUnit.get(id) || [];
const itemsInUnit = id => slotsInUnit(id).reduce((n, s) => n + itemsInSlot(s.id).length, 0);
const unitLabel = u => (u ? `${u.room ? u.room + ' · ' : ''}${u.name}` : '?');

function slotPlace(slot) {
  const u = slot && S.units.get(slot.unitId);
  return u ? unitLabel(u) : 'Unknown place';
}

function stamp() {
  return { updatedAt: Date.now(), updatedBy: S.user?.email || '' };
}

// Every change goes through here. The UI does not wait for the server: the local copy
// updates at once (also offline) and syncs in the background.
function write(ops) {
  const p = store.batch(ops);
  p.catch(err => {
    console.error(err);
    toast('Could not save: ' + (err.code === 'permission-denied' ? 'this account has no access' : err.message));
  });
  return p;
}

// ---------------------------------------------------------------- toast + banner

let toastTimer;
function toast(msg, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" class="toast-btn">${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) $('.toast-btn', el).onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 2500);
}

function updateBanner() {
  const el = $('#banner');
  const parts = [];
  if (store?.mode === 'demo') {
    parts.push('<b>Demo mode</b>: data is kept only in this browser. Fill in <code>firebase-config.js</code> to sync between devices (see README).');
  }
  if (!navigator.onLine) parts.push('<b>Offline</b>: changes are saved and will sync when you are back online.');
  el.innerHTML = parts.join('<br>');
  el.hidden = parts.length === 0;
}

// ---------------------------------------------------------------- routing + render

function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || 'home', id: parts[1] || null, params: new URLSearchParams(qs || '') };
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render(force = false) {
  const view = $('#view');
  // Do not replace the page while someone is typing in it (a remote change would steal focus).
  const ae = document.activeElement;
  if (!force && ae && view.contains(ae) && ae.matches('input, textarea, select')) {
    S.pendingRender = true;
    return;
  }
  S.pendingRender = false;

  const r = route();
  const fab = $('#fab');
  fab.hidden = true;

  if (!S.authKnown) { view.innerHTML = '<p class="loading">Loading…</p>'; return; }
  if (!S.user) { view.innerHTML = loginHTML(); return; }
  if (S.error) { view.innerHTML = errorHTML(); return; }
  if (COLLECTIONS.some(c => !S.ready.has(c))) { view.innerHTML = '<p class="loading">Loading your inventory…</p>'; return; }

  document.body.dataset.view = S.query ? 'search' : r.name;
  if (S.query) {
    view.innerHTML = searchHTML(S.query);
  } else {
    switch (r.name) {
      case 'slot': view.innerHTML = slotHTML(r.id); break;
      case 'unit': view.innerHTML = unitHTML(r.id); break;
      case 'labels': view.innerHTML = labelsHTML(r.params.get('slot')); fillQRCodes(); break;
      case 'settings': view.innerHTML = settingsHTML(); break;
      default: view.innerHTML = homeHTML();
    }
  }
  fab.hidden = !['home', 'slot', 'unit'].includes(r.name) && !S.query;
  if (!D.units.length && !S.query) fab.hidden = true;

  if (S.flashItem) {
    const row = document.getElementById('item-' + S.flashItem);
    S.flashItem = null;
    if (row) {
      row.classList.add('flash');
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

// ---------------------------------------------------------------- views

function loginHTML() {
  return `
  <form class="card login" id="loginForm">
    <img src="icons/icon.svg" alt="" width="56" height="56">
    <h1>Home Inventory</h1>
    <p class="muted">Sign in with the account created for you.</p>
    <label class="field"><span>Email</span><input name="email" type="email" autocomplete="username" required></label>
    <label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required></label>
    <button class="btn primary wide" type="submit">Sign in</button>
    <button class="btn link" type="button" data-act="forgot">Forgot password?</button>
    <p class="error" id="loginErr" hidden></p>
  </form>`;
}

function errorHTML() {
  const denied = /permission/i.test(S.error.code || S.error.message || '');
  return `
  <div class="card">
    <h1>Cannot read the inventory</h1>
    <p>${denied
      ? `The account <b>${esc(S.user.email)}</b> is not allowed. Add this email to <code>firestore.rules</code> and publish the rules again (see README).`
      : esc(S.error.message || String(S.error))}</p>
    <button class="btn" data-act="sign-out">Sign out</button>
  </div>`;
}

function welcomeHTML() {
  return `
  <div class="card welcome">
    <h1>Welcome</h1>
    <p>Start with our house already drawn: storage closet (A1–A20), bedroom closet (H1–H9),
    vertical drawers (D1–D4), the 3 bathrooms with 2 closets each, the two empty walk-in rooms and the memories box.</p>
    <p class="muted">The grids are a first guess. Everything can be rearranged later with <b>Edit layout</b>.</p>
    <div class="actions">
      <button class="btn primary" data-act="load-seed">Load our house layout</button>
      <button class="btn" data-act="new-unit">Start from scratch</button>
    </div>
  </div>`;
}

// Draws a closet as a grid of shelves. Row heights follow the real cavity heights.
function gridHTML(u, o = {}) {
  const slots = slotsInUnit(u.id);
  let rows = Math.max(1, u.rows || 1);
  let cols = Math.max(1, u.cols || 1);
  for (const s of slots) {
    rows = Math.max(rows, s.row + (s.rowSpan || 1) - 1);
    cols = Math.max(cols, s.col + (s.colSpan || 1) - 1);
  }
  const scale = o.scale ?? 1;
  const rowH = Array(rows).fill(0);
  for (const s of slots) if ((s.rowSpan || 1) === 1 && s.h) rowH[s.row - 1] = Math.max(rowH[s.row - 1], s.h);
  const minPx = o.mini ? 26 : 44;
  const tpl = rowH.map(h => `${Math.max(minPx, Math.round((h || 30) * scale))}px`).join(' ');

  const taken = new Set();
  let cells = '';
  for (const s of slots) {
    for (let r = s.row; r < s.row + (s.rowSpan || 1); r++)
      for (let c = s.col; c < s.col + (s.colSpan || 1); c++) taken.add(r + ',' + c);
    const n = itemsInSlot(s.id).length;
    const cls = ['cell', n ? 'has' : 'empty', o.highlight === s.id ? 'hl' : '', o.edit ? 'editing' : ''].join(' ');
    const attr = o.pick ? `data-pick="${s.id}"` : `data-slot="${s.id}"`;
    const title = [s.tag, s.label, plural(n, 'item')].filter(Boolean).join(' · ');
    cells += `<button type="button" class="${cls}" ${attr} title="${esc(title)}" style="grid-row:${s.row}/span ${s.rowSpan || 1};grid-column:${s.col}/span ${s.colSpan || 1}">`
      + `<span class="ctag">${esc(s.tag)}</span>`
      + (n ? `<span class="ccount">${n}</span>` : '')
      + (!o.mini && s.label ? `<span class="clabel">${esc(s.label)}</span>` : '')
      + `</button>`;
  }
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) {
      if (taken.has(r + ',' + c)) continue;
      cells += o.edit
        ? `<button type="button" class="cell add" data-add="${r},${c}" style="grid-row:${r};grid-column:${c}" aria-label="Add a shelf here">+</button>`
        : `<div class="cell void" style="grid-row:${r};grid-column:${c}"></div>`;
    }
  }
  return `<div class="grid${o.mini ? ' mini' : ''}" style="grid-template-columns:repeat(${cols},minmax(0,1fr));grid-template-rows:${tpl}">${cells}</div>`;
}

function unitCols(u) {
  return Math.max(u.cols || 1, ...slotsInUnit(u.id).map(s => s.col + (s.colSpan || 1) - 1));
}

function homeHTML() {
  if (!D.units.length) return welcomeHTML();
  let h = `<div class="summary">
    <span><b>${S.items.size}</b> items</span>
    <span><b>${S.slots.size}</b> shelves</span>
    <span><b>${D.units.length}</b> closets</span>
  </div>`;
  for (const [room, units] of D.rooms) {
    h += `<section class="room"><h2>${esc(room)}</h2><div class="units">`;
    for (const u of units) {
      const n = itemsInUnit(u.id);
      const hasSlots = slotsInUnit(u.id).length > 0;
      h += `<article class="unit-card" style="--cols:${unitCols(u)}">
        <a class="unit-head" href="#/unit/${u.id}"><span class="unit-name">${esc(u.name)}</span><span class="muted small">${n || ''}</span></a>
        ${hasSlots ? gridHTML(u, { mini: true, scale: 0.9 }) : `<a class="empty-unit" href="#/unit/${u.id}">No shelves yet<br><small>tap to set up</small></a>`}
      </article>`;
    }
    h += `</div></section>`;
  }
  const recent = [...S.items.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 6);
  if (recent.length) {
    h += `<section class="room"><h2>Recently changed</h2><ul class="list">${recent.map(it => itemRowHTML(it, { where: true, stepper: false })).join('')}</ul></section>`;
  }
  h += `<div class="actions center"><button class="btn ghost" data-act="new-unit">+ Add a closet, drawer or box</button></div>`;
  return h;
}

function itemRowHTML(it, o = {}) {
  const slot = S.slots.get(it.slotId);
  const sub = [it.category, it.notes].filter(Boolean).join(' · ');
  const thumb = it.thumb
    ? `<button type="button" class="thumb" data-act="photo" data-id="${it.id}" aria-label="View photo"><img src="${it.thumb}" alt=""></button>`
    : `<span class="thumb ph" aria-hidden="true">${esc((it.name || '?').charAt(0).toUpperCase())}</span>`;
  const where = o.where && slot
    ? `<span class="where"><span class="tag-chip">${esc(slot.tag)}</span>${esc(slotPlace(slot))}${slot.label ? ' · ' + esc(slot.label) : ''}</span>`
    : '';
  const main = o.where
    ? `<button type="button" class="item-main" data-act="goto-item" data-id="${it.id}">`
    : `<button type="button" class="item-main" data-act="edit-item" data-id="${it.id}">`;
  const qty = o.stepper === false
    ? ((it.qty ?? 1) !== 1 ? `<span class="qty-plain">×${it.qty}</span>` : '')
    : `<div class="qty">
        <button type="button" data-act="qty-" data-id="${it.id}" aria-label="One less">−</button>
        <span>${it.qty ?? 1}</span>
        <button type="button" data-act="qty+" data-id="${it.id}" aria-label="One more">+</button>
      </div>`;
  return `<li class="item-row" id="item-${it.id}">
    ${thumb}
    ${main}<span class="item-name">${esc(it.name)}</span>${sub ? `<span class="muted small clip">${esc(sub)}</span>` : ''}${where}</button>
    ${qty}
  </li>`;
}

function searchHTML(q) {
  const terms = norm(q).split(/\s+/).filter(Boolean);
  const matchAll = hay => terms.every(t => hay.includes(t));

  const slotHits = D.allSlots.filter(s => {
    const u = S.units.get(s.unitId);
    return norm(s.tag).startsWith(terms.join('')) || (terms.length && matchAll(norm(`${s.tag} ${s.label} ${u?.name} ${u?.room}`)) && s.label);
  }).slice(0, 12);

  const itemHits = [];
  for (const it of S.items.values()) {
    const slot = S.slots.get(it.slotId);
    const u = slot && S.units.get(slot.unitId);
    const name = norm(it.name);
    const hay = `${name} ${norm(it.category)} ${norm(it.notes)} ${norm(slot?.tag)} ${norm(slot?.label)} ${norm(u?.name)} ${norm(u?.room)}`;
    if (!matchAll(hay)) continue;
    const score = name.startsWith(terms[0]) ? 3 : name.includes(terms[0]) ? 2 : 1;
    itemHits.push({ it, score });
  }
  itemHits.sort((a, b) => b.score - a.score || natural(a.it.name, b.it.name));

  let h = '';
  if (slotHits.length) {
    h += `<section class="room"><h2>Shelves</h2><div class="chips">${slotHits.map(s =>
      `<a class="chip" href="#/slot/${s.id}"><span class="tag-chip">${esc(s.tag)}</span>${esc(s.label || slotPlace(s))}</a>`).join('')}</div></section>`;
  }
  h += `<section class="room"><h2>Items <span class="muted">(${itemHits.length})</span></h2>`;
  h += itemHits.length
    ? `<ul class="list">${itemHits.slice(0, 150).map(x => itemRowHTML(x.it, { where: true, stepper: false })).join('')}</ul>`
    : `<p class="empty">Nothing found for “${esc(q)}”.</p>`;
  h += `</section>`;
  return h;
}

function dimsText(s) {
  const f = v => (v == null || v === '' ? '?' : v);
  if (s.h == null && s.w == null && s.d == null) return 'Size not set';
  return `${f(s.h)} × ${f(s.w)} × ${f(s.d)} cm <span class="muted">(H × W × D)</span>`;
}

function slotHTML(id) {
  const s = S.slots.get(id);
  if (!s) return `<div class="card"><p>This shelf does not exist any more.</p><a class="btn" href="#/">Home</a></div>`;
  const u = S.units.get(s.unitId);
  const items = itemsInSlot(id);
  return `
  <nav class="crumbs"><a href="#/">Home</a><span>›</span><a href="#/unit/${u?.id}">${esc(unitLabel(u))}</a></nav>
  <div class="slot-head">
    <div class="tag-big">${esc(s.tag)}</div>
    <div class="slot-meta">
      <input class="inline-input" data-field="slot-label" data-id="${id}" value="${esc(s.label)}" placeholder="Add a label, e.g. Winter clothes" maxlength="60" aria-label="Shelf label">
      <div class="muted small">${dimsText(s)}${s.note ? ' · ' + esc(s.note) : ''}</div>
    </div>
  </div>
  <div class="slot-body">
    <div class="where-map">
      <div class="muted small">Where it is</div>
      ${u ? gridHTML(u, { highlight: id, scale: 1.1 }) : ''}
    </div>
    <div class="contents">
      <div class="contents-head">
        <h2>Contents <span class="muted">(${items.length})</span></h2>
        <button class="btn primary" data-act="add-here">+ Add here</button>
      </div>
      ${items.length ? `<ul class="list">${items.map(it => itemRowHTML(it)).join('')}</ul>` : `<p class="empty">Nothing here yet.</p>`}
      <div class="actions">
        <button class="btn ghost" data-act="move-all" ${items.length ? '' : 'disabled'}>Move everything to another shelf</button>
        <a class="btn ghost" href="#/labels?slot=${id}">Print this label</a>
      </div>
    </div>
  </div>`;
}

function unitHTML(id) {
  const u = S.units.get(id);
  if (!u) return `<div class="card"><p>This closet does not exist any more.</p><a class="btn" href="#/">Home</a></div>`;
  const editing = S.editing === id;
  const slots = slotsInUnit(id);
  const lastRowUsed = slots.some(s => s.row + (s.rowSpan || 1) - 1 >= (u.rows || 1));
  const lastColUsed = slots.some(s => s.col + (s.colSpan || 1) - 1 >= (u.cols || 1));
  return `
  <nav class="crumbs"><a href="#/">Home</a><span>›</span><span>${esc(u.room || 'Other')}</span></nav>
  <div class="unit-title">
    <h1>${esc(u.name)}</h1>
    <button class="btn ${editing ? 'primary' : ''}" data-act="toggle-edit">${editing ? 'Done' : 'Edit layout'}</button>
  </div>
  ${u.note ? `<p class="muted note">${esc(u.note)}</p>` : ''}
  ${editing ? `
  <div class="edit-bar">
    <p class="small">Tap a shelf to change its tag, size or position. Tap <b>+</b> to add a shelf.</p>
    <div class="actions">
      <button class="btn" data-act="edit-unit">Name, room, tag prefix…</button>
      <button class="btn" data-act="add-row">+ Row</button>
      <button class="btn" data-act="del-row" ${lastRowUsed || (u.rows || 1) <= 1 ? 'disabled' : ''}>− Row</button>
      <button class="btn" data-act="add-col">+ Column</button>
      <button class="btn" data-act="del-col" ${lastColUsed || (u.cols || 1) <= 1 ? 'disabled' : ''}>− Column</button>
    </div>
  </div>` : ''}
  <div class="unit-layout">
    <div class="unit-grid" style="--cols:${unitCols(u)}">${gridHTML(u, { edit: editing, scale: 1.7 })}</div>
    <ul class="slot-list">
      ${slots.map(s => {
        const n = itemsInSlot(s.id).length;
        return `<li><a href="#/slot/${s.id}"><span class="tag-chip">${esc(s.tag)}</span><span class="grow">${esc(s.label) || '<span class="muted">No label</span>'}</span><span class="muted small">${plural(n, 'item')}</span></a></li>`;
      }).join('') || '<li class="empty">No shelves yet. Tap <b>Edit layout</b>, then a <b>+</b> cell.</li>'}
    </ul>
  </div>`;
}

function labelsHTML(onlySlotId) {
  const one = onlySlotId && S.slots.get(onlySlotId);
  if (!S.labelUnits) S.labelUnits = new Set(D.units.filter(u => slotsInUnit(u.id).length).map(u => u.id));
  const slots = one ? [one] : D.units.filter(u => S.labelUnits.has(u.id)).flatMap(u => slotsInUnit(u.id));
  const base = location.origin + location.pathname;
  return `
  <div class="noprint">
    <h1>Print labels</h1>
    <p class="muted">Stick each label on its shelf. Scanning the QR code (with the phone camera or the scan button of the app) opens that shelf.</p>
    ${one ? `<p><a href="#/labels">Show all closets instead</a></p>` : `
    <div class="chips">${D.units.filter(u => slotsInUnit(u.id).length).map(u =>
      `<label class="chip"><input type="checkbox" data-label-unit="${u.id}" ${S.labelUnits.has(u.id) ? 'checked' : ''}> ${esc(unitLabel(u))}</label>`).join('')}</div>`}
    <div class="actions"><button class="btn primary" data-act="print">Print ${plural(slots.length, 'label')}</button></div>
  </div>
  <div class="labels">
    ${slots.map(s => {
      const u = S.units.get(s.unitId);
      return `<div class="label">
        <div class="qr" data-qr="${esc(base + '#/slot/' + s.id)}"></div>
        <div class="ltext">
          <div class="ltag">${esc(s.tag)}</div>
          <div class="lunit">${esc(unitLabel(u))}</div>
          ${s.label ? `<div class="llabel">${esc(s.label)}</div>` : ''}
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

async function fillQRCodes() {
  const boxes = $$('.qr[data-qr]');
  if (!boxes.length) return;
  try { await loadScript(QRGEN_URL); } catch {
    boxes.forEach(b => { b.textContent = 'QR needs internet'; });
    return;
  }
  for (const b of boxes) {
    const qr = window.qrcode(0, 'M');
    qr.addData(b.dataset.qr);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    b.innerHTML = `<svg viewBox="-2 -2 ${n + 4} ${n + 4}" shape-rendering="crispEdges" aria-hidden="true"><rect x="-2" y="-2" width="${n + 4}" height="${n + 4}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }
}

function settingsHTML() {
  return `
  <h1>Settings</h1>
  <section class="card">
    <h2>Account</h2>
    ${store.mode === 'demo'
      ? `<p><b>Demo mode.</b> Data is only in this browser. Follow the README to connect Firebase and sync all devices.</p>`
      : `<p>Signed in as <b>${esc(S.user.email)}</b>. Changes sync to every device signed in to this inventory.</p>
         <button class="btn" data-act="sign-out">Sign out</button>`}
  </section>
  <section class="card">
    <h2>Closets, drawers and boxes</h2>
    <ul class="slot-list">${D.units.map(u =>
      `<li><a href="#/unit/${u.id}"><span class="tag-chip">${esc(u.prefix || '')}</span><span class="grow">${esc(unitLabel(u))}</span><span class="muted small">${plural(slotsInUnit(u.id).length, 'shelf').replace('shelfs', 'shelves')}</span></a></li>`).join('')}</ul>
    <div class="actions">
      <button class="btn" data-act="new-unit">+ Add a closet, drawer or box</button>
      ${D.units.length ? '' : '<button class="btn" data-act="load-seed">Load our house layout</button>'}
      <a class="btn" href="#/labels">Print labels</a>
    </div>
  </section>
  <section class="card">
    <h2>Backup</h2>
    <p class="muted small">Download a copy now and then. The JSON file can be restored here; the CSV opens in Excel.</p>
    <div class="actions">
      <button class="btn" data-act="export-json">Download backup (JSON)</button>
      <button class="btn" data-act="export-csv">Download list (Excel CSV)</button>
      <label class="btn">Restore backup…<input type="file" accept=".json,application/json" data-act="import" hidden></label>
    </div>
  </section>
  <section class="card">
    <h2>Install on the phone</h2>
    <p><b>Android (Chrome):</b> menu ⋮ → <i>Install app</i> (or <i>Add to Home screen</i>).</p>
    <p><b>iPhone (Safari):</b> Share button → <i>Add to Home Screen</i>.</p>
    <p><b>Computer (Chrome / Edge):</b> install icon at the right of the address bar.</p>
  </section>`;
}

// ---------------------------------------------------------------- dialogs

const sheet = () => $('#sheet');

function openSheet(html, onClick) {
  const d = sheet();
  d.innerHTML = html;
  d.onclick = e => {
    if (e.target === d) { d.close(); return; }             // tap on the backdrop
    if (e.target.closest('[data-close]')) { d.close(); return; }
    onClick && onClick(e);
  };
  d.onclose = () => { d.innerHTML = ''; };   // no stale forms left in the page
  if (!d.open) d.showModal();
  return d;
}

function pickerHTML(unitId, selectedSlotId) {
  const u = S.units.get(unitId) || D.units.find(x => slotsInUnit(x.id).length) || D.units[0];
  if (!u) return '<p class="muted">No closets yet.</p>';
  return `
    <select data-picker-unit aria-label="Closet">${D.units.map(x =>
      `<option value="${x.id}" ${x.id === u.id ? 'selected' : ''}>${esc(unitLabel(x))}</option>`).join('')}</select>
    <div class="picker-grid" style="--cols:${unitCols(u)}">${gridHTML(u, { pick: true, highlight: selectedSlotId, scale: 1 })}</div>`;
}

function tagDatalist() {
  return `<datalist id="tagList">${D.allSlots.map(s =>
    `<option value="${esc(s.tag)}">${esc(slotPlace(s))}${s.label ? ' · ' + esc(s.label) : ''}</option>`).join('')}</datalist>`;
}

function openItemEditor(item, presetSlotId, presetUnitId) {
  const isNew = !item;
  let slotId = item?.slotId || presetSlotId || (S.slots.has(S.lastSlotId) ? S.lastSlotId : '') || '';
  const photo = { thumb: item?.thumb || '', full: null, changed: false };
  const slot = S.slots.get(slotId);

  const d = openSheet(`
  <form class="sheet-form" id="itemForm" novalidate>
    <header class="sheet-head">
      <h2>${isNew ? 'Add item' : 'Edit item'}</h2>
      <button type="button" class="icon-btn" data-close aria-label="Close">×</button>
    </header>
    <label class="field"><span>What is it?</span>
      <input name="itemName" required maxlength="120" value="${esc(item?.name)}" placeholder="e.g. Christmas lights" autocomplete="off"></label>
    <div class="field-row">
      <label class="field qty-field"><span>Quantity</span>
        <input name="qty" type="number" inputmode="numeric" min="0" step="1" value="${item?.qty ?? 1}"></label>
      <label class="field grow"><span>Category</span>
        <input name="category" list="catList" maxlength="40" value="${esc(item?.category)}" placeholder="e.g. Clothes" autocomplete="off"></label>
    </div>
    <div class="field"><span>Where?</span>
      <div class="where-row">
        <input name="tag" list="tagList" placeholder="Tag, e.g. A7" value="${esc(slot?.tag)}" autocomplete="off" autocapitalize="characters" aria-label="Shelf tag">
        <button type="button" class="btn" data-act="toggle-picker">Pick on map</button>
      </div>
      <div class="where-desc small"></div>
      <div class="picker" hidden></div>
    </div>
    <label class="field"><span>Notes</span>
      <textarea name="notes" rows="2" maxlength="500" placeholder="Optional: size, colour, who it belongs to…">${esc(item?.notes)}</textarea></label>
    <div class="field"><span>Photo</span>
      <div class="photo-row">
        <img class="photo-preview" alt="" ${photo.thumb ? `src="${photo.thumb}"` : 'hidden'}>
        <label class="btn"><input type="file" accept="image/*" name="photo" hidden><span class="photo-btn-text">${photo.thumb ? 'Change photo' : 'Add photo'}</span></label>
        <button type="button" class="btn ghost" data-act="remove-photo" ${photo.thumb ? '' : 'hidden'}>Remove</button>
      </div>
    </div>
    ${!isNew && item.updatedBy ? `<p class="muted small">Last change by ${esc(who(item.updatedBy))}, ${esc(ago(item.updatedAt))}.</p>` : ''}
    <p class="error" hidden></p>
    <footer class="sheet-foot">
      ${isNew ? '' : '<button type="button" class="btn danger" data-act="delete-item">Delete</button>'}
      <span class="spacer"></span>
      ${isNew ? '<button type="button" class="btn" data-act="save-another">Save + add another</button>' : ''}
      <button type="submit" class="btn primary">Save</button>
    </footer>
    <datalist id="catList">${D.categories.map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    ${tagDatalist()}
  </form>`, onClick);

  const f = $('#itemForm', d);
  const err = $('.error', f);
  const picker = $('.picker', f);
  const desc = $('.where-desc', f);

  function showWhere() {
    const s = S.slots.get(slotId);
    desc.innerHTML = s
      ? `<span class="tag-chip">${esc(s.tag)}</span>${esc(slotPlace(s))}${s.label ? ' · ' + esc(s.label) : ''}`
      : (f.tag.value.trim() ? '<span class="error-text">Unknown tag</span>' : '<span class="muted">Type the tag written on the shelf, or pick it on the map.</span>');
  }
  function renderPicker(unitId) {
    picker.innerHTML = pickerHTML(unitId, slotId);
  }
  showWhere();

  f.tag.addEventListener('input', () => {
    const s = D.slotByTag.get(norm(f.tag.value));
    slotId = s ? s.id : '';
    showWhere();
    if (!picker.hidden && s) renderPicker(s.unitId);
  });
  picker.addEventListener('change', e => {
    if (e.target.matches('[data-picker-unit]')) renderPicker(e.target.value);
  });
  f.photo.addEventListener('change', async () => {
    const file = f.photo.files[0];
    if (!file) return;
    try {
      const img = await loadImage(file);
      photo.thumb = toJpeg(img, 160, 0.7);
      photo.full = toJpeg(img, 1024, 0.7);
      photo.changed = true;
      const prev = $('.photo-preview', f);
      prev.src = photo.thumb;
      prev.hidden = false;
      $('[data-act="remove-photo"]', f).hidden = false;
      $('.photo-btn-text', f).textContent = 'Change photo';
    } catch (e) {
      toast('Could not read that photo');
    }
    f.photo.value = '';
  });

  function onClick(e) {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      slotId = pick.dataset.pick;
      f.tag.value = S.slots.get(slotId)?.tag || '';
      showWhere();
      picker.hidden = true;
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'toggle-picker') {
      picker.hidden = !picker.hidden;
      if (!picker.hidden) renderPicker(S.slots.get(slotId)?.unitId || presetUnitId);
    } else if (act === 'remove-photo') {
      photo.thumb = ''; photo.full = null; photo.changed = true;
      $('.photo-preview', f).hidden = true;
      e.target.hidden = true;
      $('.photo-btn-text', f).textContent = 'Add photo';
    } else if (act === 'delete-item') {
      d.close();
      deleteItem(item);
    } else if (act === 'save-another') {
      save(true);
    }
  }

  function save(again) {
    const name = f.itemName.value.trim();
    const qty = Math.max(0, intOr(f.qty.value, 1));
    err.hidden = true;
    if (!name) { err.textContent = 'Write what it is.'; err.hidden = false; f.itemName.focus(); return; }
    if (!S.slots.has(slotId)) { err.textContent = 'Choose where it is (a valid tag or pick it on the map).'; err.hidden = false; return; }

    const id = item?.id || store.newId();
    const data = {
      name, qty,
      category: f.category.value.trim(),
      notes: f.notes.value.trim(),
      slotId,
      ...stamp(),
    };
    if (isNew) Object.assign(data, { createdAt: data.updatedAt, createdBy: data.updatedBy, thumb: '', hasPhoto: false });
    const ops = [];
    if (photo.changed) {
      data.thumb = photo.thumb;
      data.hasPhoto = !!photo.full;
      if (photo.full) ops.push({ op: 'set', coll: 'photos', id, data: { data: photo.full } });
      else if (item?.hasPhoto) ops.push({ op: 'delete', coll: 'photos', id });
    }
    ops.unshift({ op: isNew ? 'set' : 'update', coll: 'items', id, data });
    write(ops);
    S.lastSlotId = slotId;

    const where = S.slots.get(slotId)?.tag;
    if (again) {
      toast(`Saved “${name}” in ${where}`);
      f.itemName.value = ''; f.qty.value = 1; f.notes.value = '';
      photo.thumb = ''; photo.full = null; photo.changed = false;
      $('.photo-preview', f).hidden = true;
      $('[data-act="remove-photo"]', f).hidden = true;
      $('.photo-btn-text', f).textContent = 'Add photo';
      $('#catList', f).innerHTML = D.categories.map(c => `<option value="${esc(c)}">`).join('');
      f.itemName.focus();
    } else {
      d.close();
      toast(isNew ? `Added “${name}” to ${where}` : 'Saved');
    }
  }
  f.addEventListener('submit', e => { e.preventDefault(); save(false); });
  if (isNew) setTimeout(() => f.itemName.focus(), 50);
}

async function deleteItem(item) {
  let photoDoc = null;
  if (item.hasPhoto) {
    // Keep the full photo for Undo, but never wait long for it (offline).
    const timeout = new Promise(res => setTimeout(() => res(null), 1500));
    photoDoc = await Promise.race([store.get('photos', item.id).catch(() => null), timeout]);
  }
  const ops = [{ op: 'delete', coll: 'items', id: item.id }];
  if (item.hasPhoto) ops.push({ op: 'delete', coll: 'photos', id: item.id });
  write(ops);
  const { id, ...data } = item;
  toast(`Deleted “${item.name}”`, {
    label: 'Undo',
    run: () => {
      const back = [{ op: 'set', coll: 'items', id, data }];
      if (photoDoc) back.push({ op: 'set', coll: 'photos', id, data: { data: photoDoc.data } });
      write(back);
    },
  });
}

function openSlotEditor(slot) {
  const u = S.units.get(slot.unitId);
  const n = itemsInSlot(slot.id).length;
  const d = openSheet(`
  <form class="sheet-form" id="slotForm" novalidate>
    <header class="sheet-head"><h2>Shelf ${esc(slot.tag)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <div class="field-row">
      <label class="field"><span>Tag (on the label)</span><input name="tag" required maxlength="12" value="${esc(slot.tag)}" autocapitalize="characters"></label>
      <label class="field grow"><span>Label</span><input name="label" maxlength="60" value="${esc(slot.label)}" placeholder="e.g. Winter clothes"></label>
    </div>
    <p class="small muted">Position in the grid (row 1 = top, column 1 = left). A shelf can span several cells.</p>
    <div class="field-row four">
      <label class="field"><span>Row</span><input name="row" type="number" min="1" inputmode="numeric" value="${slot.row}"></label>
      <label class="field"><span>Column</span><input name="col" type="number" min="1" inputmode="numeric" value="${slot.col}"></label>
      <label class="field"><span>Rows tall</span><input name="rowSpan" type="number" min="1" inputmode="numeric" value="${slot.rowSpan || 1}"></label>
      <label class="field"><span>Cols wide</span><input name="colSpan" type="number" min="1" inputmode="numeric" value="${slot.colSpan || 1}"></label>
    </div>
    <div class="field-row four">
      <label class="field"><span>Height cm</span><input name="h" inputmode="decimal" value="${slot.h ?? ''}"></label>
      <label class="field"><span>Width cm</span><input name="w" inputmode="decimal" value="${slot.w ?? ''}"></label>
      <label class="field"><span>Depth cm</span><input name="d" inputmode="decimal" value="${slot.d ?? ''}"></label>
    </div>
    <label class="field"><span>Note</span><input name="note" maxlength="120" value="${esc(slot.note)}" placeholder="e.g. box type, fragile…"></label>
    <p class="error" hidden></p>
    <footer class="sheet-foot">
      <button type="button" class="btn danger" data-act="delete-slot" ${n ? `disabled title="Move its ${plural(n, 'item')} first"` : ''}>Delete shelf</button>
      <span class="spacer"></span>
      <button type="submit" class="btn primary">Save</button>
    </footer>
    ${n ? `<p class="small muted">This shelf has ${plural(n, 'item')}; move them before deleting it.</p>` : ''}
  </form>`, e => {
    if (e.target.closest('[data-act="delete-slot"]')) {
      if (!confirm(`Delete shelf ${slot.tag}?`)) return;
      write([{ op: 'delete', coll: 'slots', id: slot.id }]);
      d.close();
      toast(`Deleted ${slot.tag}`);
    }
  });

  const f = $('#slotForm', d);
  const err = $('.error', f);
  f.addEventListener('submit', e => {
    e.preventDefault();
    const tag = f.tag.value.trim().toUpperCase();
    const pos = {
      row: Math.max(1, intOr(f.row.value, 1)), col: Math.max(1, intOr(f.col.value, 1)),
      rowSpan: Math.max(1, intOr(f.rowSpan.value, 1)), colSpan: Math.max(1, intOr(f.colSpan.value, 1)),
    };
    const fail = m => { err.textContent = m; err.hidden = false; };
    if (!tag) return fail('The tag cannot be empty.');
    const clash = D.slotByTag.get(norm(tag));
    if (clash && clash.id !== slot.id) return fail(`Tag ${tag} is already used in ${slotPlace(clash)}.`);
    const over = slotsInUnit(u.id).find(o => o.id !== slot.id
      && pos.row < o.row + (o.rowSpan || 1) && o.row < pos.row + pos.rowSpan
      && pos.col < o.col + (o.colSpan || 1) && o.col < pos.col + pos.colSpan);
    if (over) return fail(`That position overlaps shelf ${over.tag}.`);

    const ops = [{
      op: 'update', coll: 'slots', id: slot.id,
      data: { tag, label: f.label.value.trim(), ...pos, h: numOrNull(f.h.value), w: numOrNull(f.w.value), d: numOrNull(f.d.value), note: f.note.value.trim() },
    }];
    const rows = Math.max(u.rows || 1, pos.row + pos.rowSpan - 1);
    const cols = Math.max(u.cols || 1, pos.col + pos.colSpan - 1);
    if (rows !== u.rows || cols !== u.cols) ops.push({ op: 'update', coll: 'units', id: u.id, data: { rows, cols } });
    write(ops);
    d.close();
    toast('Saved');
  });
}

function nextTag(u) {
  const prefix = u.prefix || '';
  let n = 0;
  for (const s of slotsInUnit(u.id)) {
    const m = String(s.tag).match(/(\d+)$/);
    if (m && String(s.tag).toUpperCase().startsWith(prefix.toUpperCase())) n = Math.max(n, +m[1]);
  }
  let tag;
  do { tag = `${prefix}${++n}`; } while (D.slotByTag.has(norm(tag)));
  return tag;
}

function addSlotAt(u, row, col) {
  const siblings = slotsInUnit(u.id);
  const sameRow = siblings.find(s => s.row === row && s.h);
  const any = siblings.find(s => s.w || s.d);
  const tag = nextTag(u);
  write([{
    op: 'set', coll: 'slots', id: store.newId(),
    data: { unitId: u.id, tag, label: '', row, col, rowSpan: 1, colSpan: 1, h: sameRow?.h ?? null, w: any?.w ?? null, d: any?.d ?? null, note: '' },
  }]);
  toast(`Added shelf ${tag}`);
}

function openUnitEditor(unit) {
  const isNew = !unit;
  const rooms = [...D.rooms.keys()];
  const n = unit ? itemsInUnit(unit.id) : 0;
  const d = openSheet(`
  <form class="sheet-form" id="unitForm" novalidate>
    <header class="sheet-head"><h2>${isNew ? 'New closet, drawer or box' : 'Closet details'}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <label class="field"><span>Name</span><input name="unitName" required maxlength="40" value="${esc(unit?.name)}" placeholder="e.g. Hall closet"></label>
    <div class="field-row">
      <label class="field grow"><span>Room</span><input name="room" list="roomList" maxlength="40" value="${esc(unit?.room)}" placeholder="e.g. Hallway"></label>
      <label class="field"><span>Tag prefix</span><input name="tagPrefix" maxlength="6" value="${esc(unit?.prefix)}" placeholder="e.g. C" autocapitalize="characters"></label>
    </div>
    <div class="field-row">
      <label class="field"><span>Columns</span><input name="cols" type="number" min="1" max="20" inputmode="numeric" value="${unit?.cols ?? 1}"></label>
      <label class="field"><span>Rows</span><input name="rows" type="number" min="1" max="30" inputmode="numeric" value="${unit?.rows ?? 4}"></label>
    </div>
    ${isNew ? `<label class="check"><input type="checkbox" name="fill" checked> Create a shelf in every cell now (tags prefix1, prefix2…)</label>` : ''}
    <label class="field"><span>Note</span><input name="note" maxlength="160" value="${esc(unit?.note)}"></label>
    <p class="error" hidden></p>
    <footer class="sheet-foot">
      ${isNew ? '' : `<button type="button" class="btn danger" data-act="delete-unit" ${n ? 'disabled' : ''}>Delete</button>`}
      <span class="spacer"></span>
      <button type="submit" class="btn primary">${isNew ? 'Create' : 'Save'}</button>
    </footer>
    ${n ? `<p class="small muted">It contains ${plural(n, 'item')}: move them before deleting it.</p>` : ''}
    <datalist id="roomList">${rooms.map(r => `<option value="${esc(r)}">`).join('')}</datalist>
  </form>`, e => {
    if (e.target.closest('[data-act="delete-unit"]')) {
      if (!confirm(`Delete “${unit.name}” and its shelves?`)) return;
      write([{ op: 'delete', coll: 'units', id: unit.id }, ...slotsInUnit(unit.id).map(s => ({ op: 'delete', coll: 'slots', id: s.id }))]);
      d.close();
      location.hash = '#/';
      toast('Deleted');
    }
  });

  const f = $('#unitForm', d);
  f.addEventListener('submit', e => {
    e.preventDefault();
    const err = $('.error', f);
    const data = {
      name: f.unitName.value.trim(),
      room: f.room.value.trim() || 'Other',
      prefix: f.tagPrefix.value.trim().toUpperCase(),
      cols: Math.min(20, Math.max(1, intOr(f.cols.value, 1))),
      rows: Math.min(30, Math.max(1, intOr(f.rows.value, 1))),
      note: f.note.value.trim(),
    };
    if (!data.name) { err.textContent = 'Give it a name.'; err.hidden = false; return; }
    if (isNew) {
      const id = store.newId();
      data.order = Math.max(0, ...D.units.map(u => u.order ?? 0)) + 1;
      const ops = [{ op: 'set', coll: 'units', id, data }];
      if (f.fill.checked) {
        const used = new Set(D.slotByTag.keys());
        let k = 0;
        for (let r = 1; r <= data.rows; r++) {
          for (let c = 1; c <= data.cols; c++) {
            let tag;
            do { tag = `${data.prefix}${++k}`; } while (used.has(norm(tag)));
            used.add(norm(tag));
            ops.push({ op: 'set', coll: 'slots', id: store.newId(), data: { unitId: id, tag, label: '', row: r, col: c, rowSpan: 1, colSpan: 1, h: null, w: null, d: null, note: '' } });
          }
        }
      }
      write(ops);
      d.close();
      S.editing = id;
      location.hash = '#/unit/' + id;
    } else {
      write([{ op: 'update', coll: 'units', id: unit.id, data }]);
      d.close();
      toast('Saved');
    }
  });
  if (isNew) setTimeout(() => f.unitName.focus(), 50);
}

function openMoveAll(fromSlot) {
  const items = itemsInSlot(fromSlot.id);
  const d = openSheet(`
  <div class="sheet-form">
    <header class="sheet-head"><h2>Move ${plural(items.length, 'item')} from ${esc(fromSlot.tag)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <p class="muted small">Tap the shelf where everything goes (e.g. when a whole box changes place).</p>
    <div class="picker">${pickerHTML(fromSlot.unitId, fromSlot.id)}</div>
  </div>`, e => {
    const pick = e.target.closest('[data-pick]');
    if (!pick || pick.dataset.pick === fromSlot.id) return;
    const to = S.slots.get(pick.dataset.pick);
    if (!confirm(`Move ${plural(items.length, 'item')} from ${fromSlot.tag} to ${to.tag}?`)) return;
    const st = stamp();
    write(items.map(it => ({ op: 'update', coll: 'items', id: it.id, data: { slotId: to.id, ...st } })));
    d.close();
    toast(`Moved to ${to.tag}`, {
      label: 'Undo',
      run: () => write(items.map(it => ({ op: 'update', coll: 'items', id: it.id, data: { slotId: fromSlot.id, ...stamp() } }))),
    });
  });
  d.addEventListener('change', e => {
    if (e.target.matches('[data-picker-unit]')) $('.picker', d).innerHTML = pickerHTML(e.target.value, fromSlot.id);
  });
}

async function openPhoto(item) {
  const d = openSheet(`
  <div class="sheet-form">
    <header class="sheet-head"><h2>${esc(item.name)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">×</button></header>
    <img class="photo-full" src="${item.thumb}" alt="">
  </div>`);
  try {
    const p = await store.get('photos', item.id);
    if (p?.data && d.open) $('.photo-full', d).src = p.data;
  } catch { /* offline and not cached: keep the thumbnail */ }
}

// ---------------------------------------------------------------- scanner

let scanStream = null;
let scanTimer = null;
let lastBadScan = '';

async function openScanner() {
  if (!navigator.mediaDevices?.getUserMedia) { toast('The camera is not available here'); return; }
  const box = $('#scanner');
  const video = $('#scanVideo');
  box.hidden = false;
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    box.hidden = true;
    toast('No permission to use the camera');
    return;
  }
  video.srcObject = scanStream;
  await video.play().catch(() => {});

  let detector = null;
  if ('BarcodeDetector' in window) {
    try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; }
  }
  if (!detector) {
    try { await loadScript(JSQR_URL); } catch { closeScanner(); toast('The scanner needs internet the first time'); return; }
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const tick = async () => {
    if (!scanStream) return;
    if (video.readyState >= 2) {
      let text = null;
      try {
        if (detector) {
          const codes = await detector.detect(video);
          text = codes[0]?.rawValue || null;
        } else if (window.jsQR) {
          const k = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * k);
          canvas.height = Math.round(video.videoHeight * k);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          text = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data || null;
        }
      } catch { /* try again on the next frame */ }
      if (text && handleScan(text)) return;
    }
    scanTimer = setTimeout(tick, 200);
  };
  tick();
}

function closeScanner() {
  clearTimeout(scanTimer);
  if (scanStream) scanStream.getTracks().forEach(t => t.stop());
  scanStream = null;
  $('#scanVideo').srcObject = null;
  $('#scanner').hidden = true;
}

function handleScan(text) {
  const m = text.match(/#\/slot\/([A-Za-z0-9_-]+)/);
  const slot = (m && S.slots.get(m[1])) || D.slotByTag.get(norm(text));
  if (!slot) {
    if (text !== lastBadScan) toast('That QR is not a shelf of this inventory');
    lastBadScan = text;
    return false;
  }
  closeScanner();
  clearSearch();
  location.hash = '#/slot/' + slot.id;
  return true;
}

// ---------------------------------------------------------------- backup

function exportJSON() {
  const strip = m => [...m.values()];
  const payload = {
    app: 'home-inventory', version: 1, exportedAt: new Date().toISOString(),
    units: strip(S.units), slots: strip(S.slots), items: strip(S.items),
  };
  download(`inventory-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 1), 'application/json');
}

function exportCSV() {
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Item', 'Quantity', 'Category', 'Tag', 'Shelf label', 'Closet', 'Room', 'Notes', 'Last change', 'Changed by'];
  const rows = [...S.items.values()].sort((a, b) => natural(a.name, b.name)).map(it => {
    const s = S.slots.get(it.slotId);
    const u = s && S.units.get(s.unitId);
    return [it.name, it.qty ?? 1, it.category, s?.tag, s?.label, u?.name, u?.room, it.notes,
      it.updatedAt ? new Date(it.updatedAt).toLocaleString() : '', who(it.updatedBy)];
  });
  // Semicolons + BOM: opens correctly in Excel with Spanish regional settings.
  const text = '﻿' + [head, ...rows].map(r => r.map(cell).join(';')).join('\r\n');
  download(`inventory-${new Date().toISOString().slice(0, 10)}.csv`, text, 'text/csv;charset=utf-8');
}

async function importJSON(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file is not a backup'); return; }
  if (data?.app !== 'home-inventory' || !Array.isArray(data.units) || !Array.isArray(data.slots) || !Array.isArray(data.items)) {
    toast('That file is not a backup of this app');
    return;
  }
  if (!confirm(`Restore ${data.units.length} closets, ${data.slots.length} shelves and ${data.items.length} items?\nThings with the same id are overwritten; nothing is deleted.`)) return;
  const ops = [];
  for (const c of COLLECTIONS) {
    for (const doc of data[c]) {
      if (!doc || typeof doc.id !== 'string') continue;
      const { id, ...rest } = doc;
      ops.push({ op: 'set', coll: c, id, data: rest });
    }
  }
  await write(ops).catch(() => {});
  toast('Backup restored');
}

// ---------------------------------------------------------------- events

function clearSearch() {
  S.query = '';
  $('#q').value = '';
  $('#qclear').hidden = true;
}

function currentSlotId() {
  const r = route();
  return !S.query && r.name === 'slot' ? r.id : null;
}

document.addEventListener('click', e => {
  if (e.target.closest('#sheet')) return;
  const cell = e.target.closest('[data-slot]');
  if (cell) {
    const r = route();
    const slot = S.slots.get(cell.dataset.slot);
    if (r.name === 'unit' && S.editing === r.id && !S.query) openSlotEditor(slot);
    else { clearSearch(); location.hash = '#/slot/' + cell.dataset.slot; }
    return;
  }
  const add = e.target.closest('[data-add]');
  if (add) {
    const [row, col] = add.dataset.add.split(',').map(Number);
    addSlotAt(S.units.get(route().id), row, col);
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el || el.matches('input')) return;
  const act = el.dataset.act;
  const item = el.dataset.id && S.items.get(el.dataset.id);
  const r = route();

  switch (act) {
    case 'add-here': openItemEditor(null, r.id); break;
    case 'edit-item': if (item) openItemEditor(item); break;
    case 'goto-item':
      if (item) { S.flashItem = item.id; clearSearch(); location.hash = '#/slot/' + item.slotId; if (r.name === 'slot' && r.id === item.slotId) render(true); }
      break;
    case 'photo': if (item) openPhoto(item); break;
    case 'qty+': if (item) write([{ op: 'update', coll: 'items', id: item.id, data: { qty: (item.qty ?? 1) + 1, ...stamp() } }]); break;
    case 'qty-':
      if (!item) break;
      if ((item.qty ?? 1) <= 1) { if (confirm(`Remove “${item.name}” from the inventory?`)) deleteItem(item); }
      else write([{ op: 'update', coll: 'items', id: item.id, data: { qty: item.qty - 1, ...stamp() } }]);
      break;
    case 'move-all': openMoveAll(S.slots.get(r.id)); break;
    case 'toggle-edit': S.editing = S.editing === r.id ? null : r.id; render(true); break;
    case 'edit-unit': openUnitEditor(S.units.get(r.id)); break;
    case 'add-row': case 'del-row': case 'add-col': case 'del-col': {
      const u = S.units.get(r.id);
      const k = act.startsWith('add') ? 1 : -1;
      const field = act.endsWith('row') ? 'rows' : 'cols';
      write([{ op: 'update', coll: 'units', id: u.id, data: { [field]: Math.max(1, (u[field] || 1) + k) } }]);
      break;
    }
    case 'new-unit': openUnitEditor(null); break;
    case 'load-seed': {
      if (D.units.length && !confirm('Add the default house layout next to what you already have?')) break;
      const start = Math.max(0, ...D.units.map(u => (u.order ?? 0) + 1));
      write(buildSeed(() => store.newId(), start));
      toast('House layout loaded');
      break;
    }
    case 'print': window.print(); break;
    case 'export-json': exportJSON(); break;
    case 'export-csv': exportCSV(); break;
    case 'sign-out': store.signOut(); break;
    case 'forgot': {
      const email = $('#loginForm')?.email.value.trim();
      if (!email) { toast('Write your email first'); break; }
      store.resetPassword(email).then(() => toast('Password reset email sent'), () => toast('Could not send the email'));
      break;
    }
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('[data-field="slot-label"]')) {
    const s = S.slots.get(t.dataset.id);
    if (s && s.label !== t.value.trim()) write([{ op: 'update', coll: 'slots', id: s.id, data: { label: t.value.trim() } }]);
  } else if (t.matches('[data-label-unit]')) {
    t.checked ? S.labelUnits.add(t.dataset.labelUnit) : S.labelUnits.delete(t.dataset.labelUnit);
    render(true);
  } else if (t.matches('input[data-act="import"]')) {
    if (t.files[0]) importJSON(t.files[0]);
    t.value = '';
  }
});

document.addEventListener('keydown', e => {
  if (e.target.matches('[data-field="slot-label"]') && e.key === 'Enter') e.target.blur();
  if (e.key === '/' && !e.target.closest('input, textarea, select, dialog')) { e.preventDefault(); $('#q').focus(); }
});

$('#view').addEventListener('focusout', () => {
  setTimeout(() => { if (S.pendingRender) render(); }, 0);
});

document.addEventListener('submit', async e => {
  if (e.target.id !== 'loginForm') return;
  e.preventDefault();
  const f = e.target;
  const out = $('#loginErr');
  out.hidden = true;
  try {
    await store.signIn(f.email.value.trim(), f.password.value);
  } catch (err) {
    out.textContent = /invalid|wrong|not-found|credential/i.test(err.code || '') ? 'Wrong email or password.' : (err.message || 'Could not sign in.');
    out.hidden = false;
  }
});

const q = $('#q');
q.addEventListener('input', () => {
  S.query = q.value.trim();
  $('#qclear').hidden = !q.value;
  render(true);
});
q.addEventListener('keydown', e => {
  if (e.key === 'Escape') { clearSearch(); render(true); q.blur(); }
  if (e.key === 'Enter') {
    const s = D.slotByTag?.get(norm(q.value));
    if (s) { clearSearch(); q.blur(); location.hash = '#/slot/' + s.id; }
    else q.blur();
  }
});
$('#qclear').addEventListener('click', () => { clearSearch(); render(true); q.focus(); });
$('#fab').addEventListener('click', () => {
  const r = route();
  openItemEditor(null, currentSlotId(), r.name === 'unit' ? r.id : null);
});
$('#scanBtn').addEventListener('click', openScanner);
$('#scanClose').addEventListener('click', closeScanner);

window.addEventListener('hashchange', () => {
  const r = route();
  if (!(r.name === 'unit' && r.id === S.editing)) S.editing = null;
  if (r.name !== 'labels') S.labelUnits = null;
  const flashing = !!S.flashItem;
  render(true);
  if (!flashing) window.scrollTo(0, 0);
});
window.addEventListener('online', updateBanner);
window.addEventListener('offline', updateBanner);

// ---------------------------------------------------------------- start

async function start() {
  try {
    store = await createStore();
  } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<div class="card"><h1>Cannot start</h1><p>The app needs internet the very first time it opens (to download Firebase). ${esc(e.message)}</p></div>`;
    return;
  }
  updateBanner();
  store.onAuth(user => {
    S.authKnown = true;
    S.user = user;
    unsubscribers.forEach(u => u());
    unsubscribers = [];
    S.ready.clear();
    S.error = null;
    S.units.clear(); S.slots.clear(); S.items.clear();
    derive();
    if (user) {
      for (const c of COLLECTIONS) {
        unsubscribers.push(store.watch(c, docs => {
          S[c] = new Map(docs.map(d => [d.id, d]));
          S.ready.add(c);
          derive();
          scheduleRender();
        }, err => { S.error = err; scheduleRender(); }));
      }
    }
    render(true);
  });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service worker not registered', e));
  }
}

start();
