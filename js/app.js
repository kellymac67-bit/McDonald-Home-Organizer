// Home Organizer — single-page app (no build step).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_KEY, PUBLIC_URL } from './config.js';

const VERSION = '1.1.0';
const recoveryLink = /type=recovery/.test(location.hash);
const configured = /^https:\/\//.test(SUPABASE_URL) && SUPABASE_KEY && !SUPABASE_KEY.startsWith('PASTE');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' }
}) : null;

// ---------- state ----------
const S = {
  email: '', me: null,
  members: [], categories: [], locations: [], boxes: [], items: [], photos: [],
  loadedAt: 0, q: '', cat: '', cleanup: null, urls: new Map(),
};
const ix = { cat: new Map(), loc: new Map(), box: new Map(), boxByCode: new Map(), locByCode: new Map(),
  itemsByBox: new Map(), photosByBox: new Map(), photosByLoc: new Map(), kids: new Map() };

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const cleanCode = s => String(s ?? '').toUpperCase().trim().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '');
const base = () => (PUBLIC_URL || location.origin).replace(/\/$/, '');
const boxLink = code => `${base()}/b/${code}`;
const locLink = code => `${base()}/loc/${code}`;
const plural = (n, w) => `${n} ${n === 1 ? w : /(x|s|ch|sh)$/.test(w) ? w + 'es' : w + 's'}`;
const fmtDate = d => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}
async function run(p) {
  const { data, error } = await p;
  if (error) { toast(error.message || 'Something went wrong', 4000); throw error; }
  return data;
}
async function fetchAll(table, order = 'created_at') {
  const out = []; const page = 1000;
  for (let from = 0; ; from += page) {
    const rows = await run(sb.from(table).select('*').order(order).range(from, from + page - 1));
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}
function reindex() {
  for (const m of Object.values(ix)) m.clear();
  S.categories.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  S.categories.forEach(c => ix.cat.set(c.id, c));
  S.locations.forEach(l => { ix.loc.set(l.id, l); ix.locByCode.set(l.code, l); });
  S.locations.forEach(l => { const k = l.parent_id || ''; if (!ix.kids.has(k)) ix.kids.set(k, []); ix.kids.get(k).push(l); });
  for (const arr of ix.kids.values()) arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  S.boxes.forEach(b => { ix.box.set(b.id, b); ix.boxByCode.set(b.code, b); });
  S.items.forEach(i => { if (!ix.itemsByBox.has(i.box_id)) ix.itemsByBox.set(i.box_id, []); ix.itemsByBox.get(i.box_id).push(i); });
  S.photos.forEach(p => {
    const m = p.box_id ? ix.photosByBox : ix.photosByLoc; const k = p.box_id || p.location_id;
    if (!m.has(k)) m.set(k, []); m.get(k).push(p);
  });
}
async function loadAll() {
  const [members, categories, locations, boxes, items, photos] = await Promise.all([
    fetchAll('members'), fetchAll('categories'), fetchAll('locations'),
    fetchAll('boxes'), fetchAll('items'), fetchAll('photos'),
  ]);
  Object.assign(S, { members, categories, locations, boxes, items, photos, loadedAt: Date.now() });
  S.me = members.find(m => m.email === S.email) || null;
  reindex();
}
function putLocal(table, row) {
  const arr = S[table]; const i = arr.findIndex(r => r.id === row.id);
  if (i >= 0) arr[i] = row; else arr.push(row);
  reindex();
}
function dropLocal(table, id) { S[table] = S[table].filter(r => r.id !== id); reindex(); }

function locTrail(id) {
  const out = []; const seen = new Set(); let cur = ix.loc.get(id);
  while (cur && !seen.has(cur.id)) { out.unshift(cur); seen.add(cur.id); cur = ix.loc.get(cur.parent_id); }
  return out;
}
const locText = id => locTrail(id).map(l => l.name).join(' › ');
function descendants(id) {
  const out = new Set([id]); const stack = [id];
  while (stack.length) for (const k of ix.kids.get(stack.pop()) || []) if (!out.has(k.id)) { out.add(k.id); stack.push(k.id); }
  return out;
}
const boxesIn = ids => S.boxes.filter(b => ids.has(b.location_id));
const KIND_LABEL = { building: 'Building', room: 'Room', shelf: 'Shelf' };
const levelsOf = l => (l && l.kind === 'shelf' ? Math.max(1, l.levels || 1) : 1);
function levelLabel(n, total) { return `Level ${n}${total > 1 && n === total ? ' (top)' : total > 1 && n === 1 ? ' (bottom)' : ''}`; }
function whereText(b) {
  if (!b.location_id) return '';
  const l = ix.loc.get(b.location_id); const t = locText(b.location_id);
  return levelsOf(l) > 1 && b.level ? `${t} · Level ${b.level}` : t;
}
const buildings = () => (ix.kids.get('') || []).filter(l => l.kind === 'building');
const firstPhoto = b => (ix.photosByBox.get(b.id) || [])[0];

// signed photo URLs, fetched in batches for whatever is on screen
async function hydrate(root = document) {
  const imgs = $$('img[data-path]', root).filter(i => !i.src);
  const need = [...new Set(imgs.map(i => i.dataset.path))].filter(p => { const c = S.urls.get(p); return !c || c.exp < Date.now(); });
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const { data } = await sb.storage.from('photos').createSignedUrls(chunk, 6 * 3600);
    (data || []).forEach(d => d.signedUrl && S.urls.set(d.path, { url: d.signedUrl, exp: Date.now() + 5.5 * 3600e3 }));
  }
  imgs.forEach(i => { const c = S.urls.get(i.dataset.path); if (c) i.src = c.url; });
}

// ---------- navigation ----------
let navIdx = history.state?.idx || 0;
function go(path, replace = false) {
  if (replace) history.replaceState({ idx: navIdx }, '', path);
  else history.pushState({ idx: ++navIdx }, '', path);
  render();
}
function back(fallback = '/') { if (navIdx > 0) history.back(); else go(fallback, true); }
window.addEventListener('popstate', e => { navIdx = e.state?.idx || 0; render(); });
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || a.target || e.metaKey || e.ctrlKey || a.hasAttribute('download')) return;
  e.preventDefault(); go(a.getAttribute('href'));
});

const ICON = {
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>',
  places: '<svg viewBox="0 0 24 24"><path d="M4 3v18M20 3v18M4 8h16M4 14h16M4 20h16"/></svg>',
  scan: '<svg viewBox="0 0 24 24"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 9h2v2H8zM14 9h2v2h-2zM8 14h2v2H8zM14 14h2v2h-2z"/></svg>',
  add: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 11h18M12 13v5M9.5 15.5h5M7 7l2-3h6l2 3"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
};
function tabs(active) {
  const t = [['/', 'Search', 'search'], ['/places', 'Places', 'places'], ['/scan', 'Scan', 'scan'], ['/new', 'New box', 'add'], ['/more', 'More', 'more']];
  const nav = $('#tabs'); nav.hidden = false;
  nav.innerHTML = `<div class="in">${t.map(([href, label, ic]) =>
    `<a href="${href}" class="t-${ic}" ${active === ic ? 'aria-current="page"' : ''}>${ic === 'scan' ? `<span class="ring">${ICON[ic]}</span>` : ICON[ic]}${label}</a>`).join('')}</div>`;
}
function header(title, { backBtn = false, right = '' } = {}) {
  $('#top').innerHTML = `${backBtn ? '<button class="back" aria-label="Back">‹</button>' : ''}<h1>${esc(title)}</h1>${right}`;
  const b = $('#top .back'); if (b) b.onclick = () => back();
}
const view = () => $('#view');

const routes = [
  [/^\/$/, viewHome], [/^\/b\/([^/]+)$/, viewBox], [/^\/loc\/([^/]+)$/, viewLoc],
  [/^\/places$/, viewPlaces], [/^\/scan$/, viewScan], [/^\/new$/, viewNewBox], [/^\/new-place$/, viewNewLoc],
  [/^\/more$/, viewMore], [/^\/labels$/, viewLabels], [/^\/categories$/, viewCats], [/^\/family$/, viewFamily],
];
function render() {
  if (S.cleanup) { try { S.cleanup(); } catch {} S.cleanup = null; }
  closeSheet();
  if (!S.me) return;
  const path = decodeURIComponent(location.pathname).replace(/\/+$/, '') || '/';
  const params = new URLSearchParams(location.search);
  for (const [re, fn] of routes) { const m = path.match(re); if (m) { window.scrollTo(0, 0); return fn(...m.slice(1), params); } }
  go('/', true);
}

// ---------- sheets ----------
function sheet(html) {
  closeSheet();
  const o = document.createElement('div'); o.className = 'overlay'; o.id = 'sheet';
  o.innerHTML = `<div class="sheet" role="dialog">${html}</div>`;
  o.addEventListener('click', e => { if (e.target === o) closeSheet(); });
  document.body.appendChild(o);
  return o.firstElementChild;
}
function closeSheet() { $('#sheet')?.remove(); $('#viewer')?.remove(); }

// ---------- shared bits ----------
function catPill(c) { return c ? `<span class="pill"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</span>` : ''; }
function thumbHtml(p) { return p ? `<img class="thumb" data-path="${esc(p.thumb_path)}" alt="">` : '<div class="thumb">📦</div>'; }
function highlight(text, toks) {
  let h = esc(text);
  for (const t of toks) { if (!t) continue; h = h.replace(new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`); }
  return h;
}
function boxRow(b, hits = [], toks = []) {
  const c = ix.cat.get(b.category_id); const n = (ix.itemsByBox.get(b.id) || []).length;
  return `<a class="boxrow" href="/b/${esc(b.code)}">${thumbHtml(firstPhoto(b))}
    <div style="min-width:0"><div class="row" style="gap:6px"><span class="code">${highlight(b.code, toks)}</span>${catPill(c)}</div>
    <div class="t">${highlight(b.title || 'Untitled box', toks)}</div>
    <div class="s">${b.location_id ? '📍 ' + esc(whereText(b)) : 'No location'} · ${plural(n, 'item')}</div>
    ${hits.length ? `<div class="hits">${hits.slice(0, 4).map(i => highlight(i.name, toks) + (i.qty > 1 ? ` ×${i.qty}` : '')).join(' · ')}${hits.length > 4 ? ` · +${hits.length - 4} more` : ''}</div>` : ''}
    </div></a>`;
}
function locOptions(selected = '', exclude = null, kinds = null) {
  const ex = exclude ? descendants(exclude) : new Set();
  const out = []; const walk = (pid, depth) => (ix.kids.get(pid) || []).forEach(l => {
    if (!ex.has(l.id) && (!kinds || kinds.includes(l.kind))) out.push(`<option value="${l.id}" ${l.id === selected ? 'selected' : ''}>${esc(locText(l.id))}${l.kind === 'shelf' && levelsOf(l) > 1 ? ` (${levelsOf(l)} levels)` : ''}</option>`);
    if (!ex.has(l.id)) walk(l.id, depth + 1);
  });
  walk('', 0); return out.join('');
}
function levelButtons(total, current) {
  const btns = []; for (let n = total; n >= 1; n--) btns.push(`<button type="button" class="chip lvlbtn" data-lvl="${n}" aria-pressed="${current === n}">${n}${n === total ? ' ▲' : n === 1 ? ' ▼' : ''}</button>`);
  return `<div class="lvlbtns">${btns.join('')}</div>`;
}
function askLevel(l, current = null) {
  return new Promise(resolve => {
    const total = levelsOf(l);
    if (total <= 1) return resolve(null);
    const s = sheet(`<h3>Which level of ${esc(l.name)}?</h3><p class="small muted" style="margin:0">Level 1 is the bottom, ${total} is the top.</p>${levelButtons(total, current)}<button class="btn" id="lvlCancel">Cancel</button>`);
    $$('[data-lvl]', s).forEach(b => b.onclick = () => { closeSheet(); resolve(+b.dataset.lvl); });
    $('#lvlCancel', s).onclick = () => { closeSheet(); resolve(undefined); };
  });
}
function labelCard(kind, rec) {
  const link = kind === 'box' ? boxLink(rec.code) : locLink(rec.code);
  return `<div class="card"><h2>QR label <span class="pill">${rec.labeled ? '✓ Printed' : 'Not printed yet'}</span></h2>
    <div class="linkbox">${esc(link)}</div>
    <div class="small muted">In P-touch Editor: Insert → QR Code, paste this link. Put <b>${esc(rec.code)}</b> in large text beside it.</div>
    <div class="row"><button class="btn sm" data-copy="${esc(link)}">Copy link</button>
    <button class="btn sm" id="toggleLabel">${rec.labeled ? 'Mark as not printed' : 'Mark as printed'}</button></div></div>`;
}
function wireCopy(root) {
  $$('[data-copy]', root).forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Link copied'); }
    catch { prompt('Copy this link:', b.dataset.copy); }
  });
}

// ---------- photos ----------
async function shrink(file, max, quality) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
  } finally { URL.revokeObjectURL(url); }
}
async function uploadPhotos(files, owner) {
  const list = [...files]; let done = 0;
  for (const f of list) {
    toast(`Uploading photo ${done + 1} of ${list.length}…`, 60000);
    try {
      const [full, thumb] = await Promise.all([shrink(f, 1600, 0.82), shrink(f, 420, 0.72)]);
      const folder = owner.box_id ? `boxes/${owner.box_id}` : `places/${owner.location_id}`;
      const id = crypto.randomUUID(); const path = `${folder}/${id}.jpg`; const thumb_path = `${folder}/${id}_t.jpg`;
      await run(sb.storage.from('photos').upload(path, full, { contentType: 'image/jpeg' }));
      await run(sb.storage.from('photos').upload(thumb_path, thumb, { contentType: 'image/jpeg' }));
      const row = await run(sb.from('photos').insert({ ...owner, path, thumb_path }).select().single());
      putLocal('photos', row); done++;
    } catch (e) { console.error(e); toast(`Couldn't upload ${f.name || 'a photo'}`, 4000); }
  }
  if (done) toast(`${plural(done, 'photo')} added`);
}
function photoGrid(list, inputId) {
  return `<div class="photos">${list.map((p, i) => `<button data-photo="${i}"><img data-path="${esc(p.thumb_path)}" alt="Photo ${i + 1}"></button>`).join('')}
    <label class="add" style="aspect-ratio:1;border-radius:10px;cursor:pointer;text-align:center">＋ Add photo<input type="file" id="${inputId}" accept="image/*" multiple hidden></label></div>`;
}
function wirePhotos(root, list, owner, rerender) {
  $$('[data-photo]', root).forEach(b => b.onclick = () => openViewer(list, +b.dataset.photo, rerender));
  const inp = $('input[type=file]', root);
  inp.onchange = async () => { if (inp.files.length) { await uploadPhotos(inp.files, owner); rerender(); } };
}
async function openViewer(list, i, rerender) {
  const v = document.createElement('div'); v.className = 'viewer'; v.id = 'viewer';
  const show = async () => {
    const p = list[i];
    v.innerHTML = `<div class="bar"><button class="btn sm" data-x>Close</button><span style="color:#fff;align-self:center">${i + 1} / ${list.length}</span><button class="btn sm" data-del>Delete</button></div>
      <img data-path="${esc(p.path)}" alt=""><div class="bar b"><button class="btn" data-p ${i === 0 ? 'disabled' : ''}>‹ Prev</button><button class="btn" data-n ${i === list.length - 1 ? 'disabled' : ''}>Next ›</button></div>`;
    $('[data-x]', v).onclick = () => v.remove();
    $('[data-p]', v).onclick = () => { i--; show(); };
    $('[data-n]', v).onclick = () => { i++; show(); };
    $('[data-del]', v).onclick = async () => {
      if (!confirm('Delete this photo?')) return;
      await sb.storage.from('photos').remove([p.path, p.thumb_path]);
      await run(sb.from('photos').delete().eq('id', p.id));
      dropLocal('photos', p.id); v.remove(); toast('Photo deleted'); rerender();
    };
    await hydrate(v);
  };
  document.body.appendChild(v); show();
}

// ---------- SEARCH (home) ----------
function viewHome() {
  header('Home Organizer'); tabs('search');
  const cats = S.categories;
  view().innerHTML = `<div class="search"><input type="search" id="q" placeholder="Search boxes and items…" value="${esc(S.q)}" autocomplete="off" enterkeyhint="search">
    <div class="chips"><button class="chip" data-cat="" aria-pressed="${!S.cat}">All</button>${cats.map(c =>
      `<button class="chip" data-cat="${c.id}" aria-pressed="${S.cat === c.id}"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</button>`).join('')}</div></div>
    <div id="results"></div>`;
  const q = $('#q');
  q.oninput = () => { S.q = q.value; results(); };
  $$('[data-cat]').forEach(b => b.onclick = () => { S.cat = b.dataset.cat; $$('[data-cat]').forEach(x => x.setAttribute('aria-pressed', x === b)); results(); });
  results();
}
function results() {
  const toks = norm(S.q).split(/\s+/).filter(Boolean);
  let boxes = S.boxes.filter(b => !S.cat || b.category_id === S.cat);
  let out;
  if (!toks.length) {
    out = [...boxes].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).map(b => ({ b, hits: [] }));
  } else {
    out = [];
    for (const b of boxes) {
      const its = ix.itemsByBox.get(b.id) || [];
      const c = ix.cat.get(b.category_id);
      const head = norm([b.code, b.title, b.notes, c?.name, locText(b.location_id)].join(' '));
      const hay = head + ' ' + norm(its.map(i => i.name + ' ' + i.notes).join(' '));
      if (!toks.every(t => hay.includes(t))) continue;
      const hits = its.filter(i => toks.some(t => norm(i.name + ' ' + i.notes).includes(t)));
      const score = (norm(b.code) === toks.join('-') || norm(b.code) === toks.join('') ? 1000 : 0) + toks.filter(t => head.includes(t)).length * 10 + hits.length;
      out.push({ b, hits, score });
    }
    out.sort((x, y) => y.score - x.score || x.b.code.localeCompare(y.b.code, undefined, { numeric: true }));
  }
  const total = S.items.reduce((s, i) => s + (i.qty || 0), 0);
  const el = $('#results');
  if (!S.boxes.length) {
    el.innerHTML = `<div class="card center"><h2 style="justify-content:center">Welcome!</h2><p class="muted" style="margin:0">Start by adding the places you store things (garage shelf, attic…), then add boxes.</p>
      <a class="btn primary" href="/new-place">Add a place</a><a class="btn" href="/new">Add a box</a></div>`;
    return;
  }
  el.innerHTML = `<div class="small muted" style="padding:0 2px 6px">${toks.length ? `${plural(out.length, 'box')} found` : `${plural(S.boxes.length, 'box')} · ${total.toLocaleString()} items · most recently updated first`}</div>
    <div class="card" style="padding:4px 14px"><div class="list">${out.slice(0, 300).map(r => boxRow(r.b, r.hits, toks)).join('') || '<p class="muted">Nothing matches that search.</p>'}</div></div>`;
  hydrate(el);
}

// ---------- BOX ----------
async function viewBox(code) {
  code = cleanCode(code);
  const b = ix.boxByCode.get(code);
  tabs('search');
  if (!b) {
    header(code, { backBtn: true });
    const known = ix.locByCode.get(code);
    if (known) return go(`/loc/${code}`, true);
    view().innerHTML = `<div class="card center"><h2 style="justify-content:center">No box ${esc(code)} yet</h2>
      <p class="muted" style="margin:0">This label hasn't been set up. Create the box now and add what's in it.</p>
      <a class="btn primary" href="/new?code=${encodeURIComponent(code)}">Create box ${esc(code)}</a></div>`;
    return;
  }
  header(b.code, { backBtn: true });
  const c = ix.cat.get(b.category_id);
  const items = (ix.itemsByBox.get(b.id) || []).slice().sort((x, y) => x.name.localeCompare(y.name));
  const photos = ix.photosByBox.get(b.id) || [];
  const rerender = () => viewBox(b.code);
  view().innerHTML = `
    <div class="hero"><div class="row"><span class="bigcode">${esc(b.code)}</span><button class="chip" id="catBtn">${c ? `<span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}` : 'Category'}</button></div>
      <input class="title" id="title" value="${esc(b.title)}" placeholder="Name this box (e.g. Tree lights)"></div>
    <div class="where"><div class="grow">${b.location_id ? `<div class="lab">Stored at</div><a href="/loc/${esc(ix.loc.get(b.location_id)?.code)}">📍 ${esc(whereText(b))}</a>` : '<div class="lab">Stored at</div><span class="muted">No location set</span>'}</div>
      <button class="btn sm primary" id="moveBtn">Move</button></div>
    <div class="card"><h2>Photos <span class="muted small">${photos.length || ''}</span></h2>${photoGrid(photos, 'boxPhotos')}</div>
    <div class="card"><h2>Contents <span class="row"><span class="muted small">${plural(items.reduce((s, i) => s + i.qty, 0), 'item')}</span><button class="btn sm" id="pasteBtn">Add a list</button></span></h2>
      <form class="additem" id="addItem"><input id="itemName" placeholder="Add an item…" autocomplete="off" enterkeyhint="done"><input id="itemQty" type="number" min="1" value="1" inputmode="numeric" aria-label="Quantity"><button class="btn primary">Add</button></form>
      <div class="list">${items.map(i => `<div class="item" data-item="${i.id}"><div><div>${esc(i.name)}</div>${i.notes ? `<div class="n">${esc(i.notes)}</div>` : ''}</div><span class="q">×${i.qty}</span></div>`).join('') || '<p class="muted small" style="margin:4px 0">Nothing listed yet.</p>'}</div></div>
    <div class="card"><h2>Notes</h2><textarea id="notes" placeholder="Anything else worth knowing about this box">${esc(b.notes)}</textarea></div>
    ${labelCard('box', b)}
    <details class="card" id="hist"><summary class="lab" style="cursor:pointer">Move history</summary><div class="log small muted">Loading…</div></details>
    <div class="small muted center">Added ${fmtDate(b.created_at)}${b.created_by ? ' by ' + esc(memberName(b.created_by)) : ''} · updated ${fmtDate(b.updated_at)}</div>
    <button class="btn danger" id="delBox">Delete this box</button>`;

  const save = async patch => { const row = await run(sb.from('boxes').update(patch).eq('id', b.id).select().single()); putLocal('boxes', row); return row; };
  $('#title').onchange = async e => { await save({ title: e.target.value.trim() }); toast('Saved'); };
  $('#notes').onchange = async e => { await save({ notes: e.target.value }); toast('Saved'); };
  $('#toggleLabel').onclick = async () => { await save({ labeled: !b.labeled }); rerender(); };
  wireCopy(view());
  wirePhotos(view(), photos, { box_id: b.id }, rerender);
  $('#moveBtn').onclick = () => pickLocation(b);
  $('#catBtn').onclick = () => {
    const s = sheet(`<h3>Category for ${esc(b.code)}</h3><p class="small muted" style="margin:0">The box keeps its number and label.</p>
      <div class="list">${S.categories.map(x => `<button class="btn" style="justify-content:flex-start;border:0" data-c="${x.id}"><span class="dot" style="background:${esc(x.color)}"></span>${esc(x.name)}${x.id === b.category_id ? ' ✓' : ''}</button>`).join('')}</div>`);
    $$('[data-c]', s).forEach(btn => btn.onclick = async () => { await save({ category_id: btn.dataset.c }); closeSheet(); rerender(); });
  };
  $('#addItem').onsubmit = async e => {
    e.preventDefault();
    const name = $('#itemName').value.trim(); const qty = Math.max(1, parseInt($('#itemQty').value) || 1);
    if (!name) return;
    const row = await run(sb.from('items').insert({ box_id: b.id, name, qty }).select().single());
    putLocal('items', row); b.updated_at = new Date().toISOString();
    await rerender(); $('#itemName').focus();
  };
  $('#pasteBtn').onclick = () => {
    const s = sheet(`<h3>Add a list of items</h3><p class="small muted" style="margin:0">One item per line. Put a number in front for quantity, like <b>3 extension cords</b> or <b>ornaments x 24</b>.</p>
      <textarea id="bulk" style="min-height:180px" placeholder="Tree skirt&#10;2 strands white lights&#10;Ornaments x 24"></textarea><button class="btn primary" id="bulkGo">Add items</button>`);
    $('#bulk', s).focus();
    $('#bulkGo', s).onclick = async () => {
      const rows = parseList($('#bulk', s).value).map(r => ({ ...r, box_id: b.id }));
      if (!rows.length) return closeSheet();
      const data = await run(sb.from('items').insert(rows).select());
      S.items.push(...data); reindex(); closeSheet(); toast(`${plural(data.length, 'item')} added`); rerender();
    };
  };
  $$('[data-item]').forEach(el => el.onclick = () => editItem(S.items.find(i => i.id === el.dataset.item), b, rerender));
  $('#hist').ontoggle = async e => {
    if (!e.target.open) return;
    const rows = await run(sb.from('moves').select('*').eq('box_id', b.id).order('moved_at', { ascending: false }).limit(30));
    $('#hist .log').innerHTML = rows.map(m => `<div>${fmtDate(m.moved_at)} — ${m.to_location ? esc(locText(m.to_location) || 'a deleted place') + (m.to_level ? ` · Level ${m.to_level}` : '') : 'location cleared'}${m.moved_by ? ` <span class="muted">(${esc(memberName(m.moved_by))})</span>` : ''}</div>`).join('') || '<div>No moves recorded.</div>';
  };
  $('#delBox').onclick = async () => {
    if (!confirm(`Delete box ${b.code} with its ${plural(items.length, 'item')} and ${plural(photos.length, 'photo')}? This can't be undone.`)) return;
    const paths = photos.flatMap(p => [p.path, p.thumb_path]);
    if (paths.length) await sb.storage.from('photos').remove(paths);
    await run(sb.from('boxes').delete().eq('id', b.id));
    await loadAll(); toast(`${b.code} deleted`); go('/', true);
  };
  hydrate(view());
}
function parseList(text) {
  return text.split(/\n+/).map(l => l.trim().replace(/^[-*•]\s*/, '')).filter(Boolean).map(l => {
    let m = l.match(/^(\d+)\s*[x×]?\s+(.+)$/i); if (m) return { qty: +m[1] || 1, name: m[2].trim() };
    m = l.match(/^(.+?)\s*[x×]\s*(\d+)$/i); if (m) return { qty: +m[2] || 1, name: m[1].trim() };
    m = l.match(/^(.+?)\s*\((\d+)\)$/); if (m) return { qty: +m[2] || 1, name: m[1].trim() };
    return { qty: 1, name: l };
  });
}
function memberName(email) { const m = S.members.find(x => x.email === email); return m?.name || email; }
function editItem(it, b, rerender) {
  const s = sheet(`<h3>Edit item</h3>
    <label class="f">Item<input id="eName" value="${esc(it.name)}"></label>
    <label class="f">Quantity<input id="eQty" type="number" min="0" inputmode="numeric" value="${it.qty}"></label>
    <label class="f">Notes<input id="eNotes" value="${esc(it.notes)}" placeholder="Size, color, condition…"></label>
    <label class="f">In box<select id="eBox">${S.boxes.slice().sort((x, y) => x.code.localeCompare(y.code, undefined, { numeric: true })).map(x => `<option value="${x.id}" ${x.id === b.id ? 'selected' : ''}>${esc(x.code)} — ${esc(x.title)}</option>`).join('')}</select></label>
    <div class="row"><button class="btn primary grow" id="eSave">Save</button><button class="btn danger" id="eDel">Remove</button></div>`);
  $('#eSave', s).onclick = async () => {
    const patch = { name: $('#eName', s).value.trim() || it.name, qty: Math.max(0, parseInt($('#eQty', s).value) || 0), notes: $('#eNotes', s).value.trim(), box_id: $('#eBox', s).value };
    const row = await run(sb.from('items').update(patch).eq('id', it.id).select().single());
    putLocal('items', row); closeSheet();
    if (row.box_id !== b.id) toast(`Moved to ${ix.box.get(row.box_id)?.code}`);
    rerender();
  };
  $('#eDel', s).onclick = async () => { await run(sb.from('items').delete().eq('id', it.id)); dropLocal('items', it.id); closeSheet(); rerender(); };
}
async function moveBox(b, locId, level = null) {
  const l = ix.loc.get(locId);
  const row = await run(sb.from('boxes').update({ location_id: locId, level: levelsOf(l) > 1 ? level : null }).eq('id', b.id).select().single());
  putLocal('boxes', row); return row;
}
function pickLocation(b) {
  const s = sheet(`<h3>Move ${esc(b.code)} to…</h3>
    <a class="btn primary" href="/scan?box=${encodeURIComponent(b.code)}">Scan the shelf's QR label</a>
    <input type="search" id="lq" placeholder="Or search shelves and rooms…" autocomplete="off">
    <div class="list" id="ll"></div>
    ${b.location_id ? '<button class="btn" id="clearLoc">Remove location</button>' : ''}
    <a class="btn" href="/new-place?kind=shelf&box=${encodeURIComponent(b.code)}">＋ New shelf</a>`);
  const draw = () => {
    const t = norm($('#lq', s).value);
    const locs = S.locations.filter(l => l.kind !== 'building' || !(ix.kids.get(l.id) || []).length).map(l => ({ l, txt: locText(l.id) }))
      .filter(x => !t || norm(x.txt + ' ' + x.l.code).includes(t)).sort((x, y) => x.txt.localeCompare(y.txt, undefined, { numeric: true }));
    $('#ll', s).innerHTML = locs.map(x => `<button class="btn" style="justify-content:space-between;border:0;text-align:left" data-l="${x.l.id}"><span>${esc(x.txt)}${levelsOf(x.l) > 1 ? ` <span class="muted small">· ${levelsOf(x.l)} levels</span>` : ''}</span><span class="code muted">${esc(x.l.code)}${x.l.id === b.location_id ? ' ✓' : ''}</span></button>`).join('') || '<p class="muted small">No shelves yet.</p>';
    $$('[data-l]', s).forEach(btn => btn.onclick = async () => {
      const l = ix.loc.get(btn.dataset.l); const lvl = await askLevel(l, l.id === b.location_id ? b.level : null);
      if (lvl === undefined) return;
      await moveBox(b, l.id, lvl); closeSheet(); toast(`${b.code} → ${whereText(ix.box.get(b.id))}`); render();
    });
  };
  $('#lq', s).oninput = draw; draw();
  const c = $('#clearLoc', s); if (c) c.onclick = async () => { await moveBox(b, null); closeSheet(); render(); };
}

// ---------- PLACES ----------
function placeSummary(l) {
  const all = descendants(l.id); const locs = [...all].filter(id => id !== l.id).map(id => ix.loc.get(id)).filter(Boolean);
  const rooms = locs.filter(x => x.kind === 'room').length, shelves = locs.filter(x => x.kind === 'shelf').length;
  const parts = []; if (rooms) parts.push(plural(rooms, 'room')); if (shelves) parts.push(plural(shelves, 'shelf').replace('shelfs', 'shelves'));
  return { text: parts.join(' · '), boxes: boxesIn(all).length };
}
function locRow(l) {
  const sm = placeSummary(l);
  return `<a class="locrow" href="/loc/${esc(l.code)}"><div style="min-width:0"><span class="nm">${esc(l.name)}</span> <span class="code muted small">${esc(l.code)}</span>
    ${l.kind === 'shelf' && levelsOf(l) > 1 ? `<div class="small muted">${levelsOf(l)} levels</div>` : sm.text ? `<div class="small muted">${esc(sm.text)}</div>` : ''}</div><span class="count">${plural(sm.boxes, 'box')}</span></a>`;
}
function viewPlaces() {
  header('Places'); tabs('places');
  const unassigned = S.boxes.filter(b => !b.location_id);
  const blds = buildings(); const others = (ix.kids.get('') || []).filter(l => l.kind !== 'building');
  view().innerHTML = `<div class="card" style="padding:10px 14px 4px"><h2>Buildings <span class="count">${blds.length}</span></h2>
      <div class="list">${blds.map(locRow).join('') || '<p class="muted small">No buildings yet. Run the database update (002) in Supabase.</p>'}</div></div>
    ${S.me.is_admin ? '<a class="btn" href="/new-place?kind=building">＋ Add a building</a>' : ''}
    ${others.length ? `<div class="card" style="padding:10px 14px 4px"><h2>Not in a building</h2><div class="list">${others.map(locRow).join('')}</div></div>` : ''}
    ${unassigned.length ? `<div class="card" style="padding:10px 14px 4px"><div class="lab">Boxes with no place (${unassigned.length})</div><div class="list">${unassigned.map(b => boxRow(b)).join('')}</div></div>` : ''}
    <p class="small muted">Open a building to add rooms (Garage, Loft…) and shelves. Each shelf gets a QR label — scan it to see every box on it, level by level.</p>`;
  hydrate(view());
}
async function viewLoc(code) {
  code = cleanCode(code);
  const l = ix.locByCode.get(code);
  tabs('places');
  if (!l) {
    header(code, { backBtn: true });
    if (ix.boxByCode.get(code)) return go(`/b/${code}`, true);
    view().innerHTML = `<div class="card center"><h2 style="justify-content:center">No shelf ${esc(code)} yet</h2>
      <p class="muted" style="margin:0">This label hasn't been set up yet.</p>
      <a class="btn primary" href="/new-place?kind=shelf&code=${encodeURIComponent(code)}">Create shelf ${esc(code)}</a></div>`;
    return;
  }
  header(l.name, { backBtn: true });
  const trail = locTrail(l.id);
  const kind = l.kind || 'shelf';
  const canEdit = kind !== 'building' || S.me.is_admin;
  const here = S.boxes.filter(b => b.location_id === l.id).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const kids = ix.kids.get(l.id) || [];
  const rooms = kids.filter(k => k.kind === 'room'), shelves = kids.filter(k => k.kind !== 'room' && k.kind !== 'building');
  const photos = ix.photosByLoc.get(l.id) || [];
  const total = levelsOf(l);
  const rerender = () => viewLoc(l.code);
  const boxesCard = () => {
    if (kind !== 'shelf') return here.length ? `<div class="card" style="padding:10px 14px 4px"><h2>Boxes not on a shelf <span class="count">${here.length}</span></h2><div class="list">${here.map(b => boxRow(b)).join('')}</div></div>` : '';
    if (total <= 1) return `<div class="card" style="padding:10px 14px 4px"><h2>Boxes on this shelf <span class="count">${here.length}</span></h2>
      <div class="list">${here.map(b => boxRow(b)).join('') || '<p class="muted small">No boxes on this shelf yet.</p>'}</div>
      <a class="btn sm" style="margin:6px 0 10px" href="/new?loc=${encodeURIComponent(l.code)}">＋ New box here</a></div>`;
    const groups = []; for (let n = total; n >= 1; n--) groups.push(n);
    const unset = here.filter(b => !b.level || b.level > total);
    return `<div class="card" style="padding:10px 14px 4px"><h2>Boxes on this shelf <span class="count">${here.length}</span></h2>
      ${groups.map(n => { const bs = here.filter(b => b.level === n); return `<div class="lvlgrp"><div class="lvlhead"><span>${levelLabel(n, total)}</span><a class="small" href="/new?loc=${encodeURIComponent(l.code)}&level=${n}">＋ box</a></div>
        <div class="list">${bs.map(b => boxRow(b)).join('') || '<p class="muted small" style="margin:2px 0 8px">Empty</p>'}</div></div>`; }).join('')}
      ${unset.length ? `<div class="lvlgrp"><div class="lvlhead"><span>Level not set</span></div><div class="list">${unset.map(b => boxRow(b)).join('')}</div></div>` : ''}</div>`;
  };
  const roomsCard = kind === 'building' ? `<div class="card" style="padding:10px 14px 4px"><h2>Rooms <span class="count">${rooms.length}</span></h2>
      <div class="list">${rooms.map(locRow).join('') || '<p class="muted small" style="margin:4px 0">No rooms. Small buildings can hold shelves directly.</p>'}</div>
      <a class="btn sm" style="margin:6px 0 10px" href="/new-place?kind=room&parent=${encodeURIComponent(l.code)}">＋ Add a room</a></div>` : '';
  const shelvesCard = kind !== 'shelf' ? `<div class="card" style="padding:10px 14px 4px"><h2>Shelves${kind === 'building' && rooms.length ? ' not in a room' : ''} <span class="count">${shelves.length}</span></h2>
      <div class="list">${shelves.map(locRow).join('') || '<p class="muted small" style="margin:4px 0">None yet.</p>'}</div>
      <a class="btn sm" style="margin:6px 0 10px" href="/new-place?kind=shelf&parent=${encodeURIComponent(l.code)}">＋ Add a shelf</a></div>` : '';
  const parentKinds = kind === 'shelf' ? ['building', 'room'] : ['building'];
  view().innerHTML = `
    ${trail.length > 1 ? `<div class="crumbs">${trail.slice(0, -1).map(t => `<a href="/loc/${esc(t.code)}">${esc(t.name)}</a>`).join(' › ')} ›</div>` : ''}
    <div class="hero"><div class="row"><span class="bigcode">${esc(l.code)}</span><span class="pill">${KIND_LABEL[kind]}${kind === 'shelf' && total > 1 ? ` · ${total} levels` : ''}</span></div>
      <input class="title" id="lname" value="${esc(l.name)}" ${canEdit ? '' : 'disabled'}></div>
    ${kind === 'shelf' ? `<div class="row"><a class="btn primary grow" href="/scan?to=${encodeURIComponent(l.code)}">Scan boxes onto this shelf</a><button class="btn" id="pickBoxes">Pick boxes</button></div>` : ''}
    ${roomsCard}${shelvesCard}${boxesCard()}
    <div class="card"><h2>Photos</h2>${photoGrid(photos, 'locPhotos')}</div>
    <div class="card"><h2>Details</h2>
      ${kind === 'shelf' ? `<label class="f">Levels on this shelf (1 = bottom)<input id="llevels" type="number" min="1" max="20" inputmode="numeric" value="${total}"></label>` : ''}
      ${kind !== 'building' ? `<label class="f">Inside of<select id="lparent">${kind === 'shelf' ? '' : ''}${locOptions(l.parent_id || '', l.id, parentKinds)}</select></label>` : ''}
      <label class="f">Notes<textarea id="lnotes" ${canEdit ? '' : 'disabled'}>${esc(l.notes)}</textarea></label></div>
    ${labelCard('loc', l)}
    ${canEdit ? `<button class="btn danger" id="delLoc">Delete this ${KIND_LABEL[kind].toLowerCase()}</button>` : ''}`;
  const save = async patch => { const row = await run(sb.from('locations').update(patch).eq('id', l.id).select().single()); putLocal('locations', row); };
  $('#lname').onchange = async e => { if (e.target.value.trim()) { await save({ name: e.target.value.trim() }); header(e.target.value.trim(), { backBtn: true }); toast('Saved'); } };
  $('#lnotes').onchange = async e => { await save({ notes: e.target.value }); toast('Saved'); };
  const lp = $('#lparent'); if (lp) lp.onchange = async e => { await save({ parent_id: e.target.value || null }); rerender(); };
  const ll = $('#llevels'); if (ll) ll.onchange = async e => {
    const n = Math.min(20, Math.max(1, parseInt(e.target.value) || 1)); await save({ levels: n }); toast(`${plural(n, 'level')}`); rerender();
  };
  $('#toggleLabel').onclick = async () => { await save({ labeled: !l.labeled }); rerender(); };
  wireCopy(view());
  wirePhotos(view(), photos, { location_id: l.id }, rerender);
  const pb = $('#pickBoxes'); if (pb) pb.onclick = () => {
    let lvl = null;
    const s = sheet(`<h3>Put boxes on ${esc(l.name)}</h3>
      ${total > 1 ? `<div class="lab">Level (1 = bottom)</div>${levelButtons(total, null)}` : ''}
      <input type="search" id="bq" placeholder="Search boxes…"><div class="list" id="bl"></div><button class="btn primary" id="bGo">Move selected</button>`);
    $$('[data-lvl]', s).forEach(b => b.onclick = () => { lvl = +b.dataset.lvl; $$('[data-lvl]', s).forEach(x => x.setAttribute('aria-pressed', x === b)); });
    const draw = () => {
      const t = norm($('#bq', s).value);
      $('#bl', s).innerHTML = S.boxes.filter(b => !t || norm(b.code + ' ' + b.title).includes(t))
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
        .map(b => `<label class="chk" style="padding:8px 0"><input type="checkbox" value="${b.id}"><span><b class="code">${esc(b.code)}</b> ${esc(b.title)} <span class="muted small">${b.location_id ? esc(whereText(b)) : ''}</span></span></label>`).join('') || '<p class="muted small">No boxes.</p>';
    };
    $('#bq', s).oninput = draw; draw();
    $('#bGo', s).onclick = async () => {
      const ids = $$('input:checked', s).map(i => i.value); if (!ids.length) return closeSheet();
      if (total > 1 && !lvl) return toast('Tap a level first');
      for (const id of ids) await moveBox(ix.box.get(id), l.id, lvl);
      closeSheet(); toast(`${plural(ids.length, 'box')} moved${lvl ? ` to level ${lvl}` : ' here'}`); rerender();
    };
  };
  const dl = $('#delLoc'); if (dl) dl.onclick = async () => {
    const n = boxesIn(descendants(l.id)).length;
    if (!confirm(`Delete ${l.name}?${n ? ` ${plural(n, 'box')} will be left with no place.` : ''}${kids.length ? ' What\'s inside it moves up a level.' : ''}`)) return;
    const paths = photos.flatMap(p => [p.path, p.thumb_path]); if (paths.length) await sb.storage.from('photos').remove(paths);
    await run(sb.from('locations').delete().eq('id', l.id));
    await loadAll(); toast('Deleted'); go(trail.length > 1 ? `/loc/${trail[trail.length - 2].code}` : '/places', true);
  };
  hydrate(view());
}

// ---------- NEW BOX / NEW PLACE ----------
async function nextCode(prefix) {
  const { data, error } = await sb.rpc('next_code', { p: prefix });
  if (!error && data) return data;
  const nums = [...S.boxes, ...S.locations].map(x => x.code.match(new RegExp(`^${prefix}-(\\d+)$`))).filter(Boolean).map(m => +m[1]);
  return `${prefix}-${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(2, '0')}`;
}
function viewNewBox(params) {
  header('New box', { backBtn: navIdx > 0 }); tabs('add');
  const presetCode = cleanCode(params.get('code') || '');
  const presetLoc = ix.locByCode.get(cleanCode(params.get('loc') || ''));
  let cat = presetCode ? S.categories.find(c => presetCode.startsWith(c.prefix + '-')) : null;
  if (!S.categories.length) { view().innerHTML = '<div class="card">No categories yet — an admin needs to add one under More → Categories.</div>'; return; }
  view().innerHTML = `<div class="card">
    <div class="lab">Category</div><div class="chips" style="flex-wrap:wrap">${S.categories.map(c => `<button type="button" class="chip" data-cat="${c.id}" aria-pressed="${cat?.id === c.id}"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</button>`).join('')}</div>
    <label class="f">Box number<input id="nCode" value="${esc(presetCode)}" placeholder="Pick a category first" autocapitalize="characters"></label>
    <label class="f">Name<input id="nTitle" placeholder="e.g. Tree lights, Drill bits, Camera batteries"></label>
    <label class="f">Where it's stored<select id="nLoc"><option value="">— Decide later —</option>${locOptions(presetLoc?.id || '')}</select></label>
    <div id="nLvlWrap" hidden><div class="lab" style="margin-bottom:6px">Level (1 = bottom)</div><div id="nLvl"></div></div>
    <button class="btn primary" id="nGo">Create box</button></div>
    <p class="small muted">The box number goes on its label. You can add photos and contents on the next screen.</p>`;
  let codeTouched = !!presetCode;
  let nLevel = parseInt(params.get('level')) || null;
  const drawLevels = () => {
    const l = ix.loc.get($('#nLoc').value); const total = levelsOf(l);
    $('#nLvlWrap').hidden = total <= 1; if (total <= 1) { nLevel = null; return; }
    if (nLevel > total) nLevel = null;
    $('#nLvl').innerHTML = levelButtons(total, nLevel);
    $$('#nLvl [data-lvl]').forEach(b => b.onclick = () => { nLevel = +b.dataset.lvl; drawLevels(); });
  };
  $('#nLoc').onchange = () => { nLevel = null; drawLevels(); }; drawLevels();
  $('#nCode').oninput = () => (codeTouched = true);
  $$('[data-cat]').forEach(b => b.onclick = async () => {
    cat = ix.cat.get(b.dataset.cat); $$('[data-cat]').forEach(x => x.setAttribute('aria-pressed', x === b));
    if (!codeTouched) $('#nCode').value = await nextCode(cat.prefix);
  });
  $('#nGo').onclick = async () => {
    const code = cleanCode($('#nCode').value);
    if (!cat) return toast('Pick a category');
    if (!/^[A-Z0-9-]{2,20}$/.test(code)) return toast('Box number: letters, numbers and dashes only');
    if (ix.boxByCode.has(code) || ix.locByCode.has(code)) return toast(`${code} is already used`);
    const locId = $('#nLoc').value || null;
    if (levelsOf(ix.loc.get(locId)) > 1 && !nLevel) return toast('Tap which level the box is on');
    const row = await run(sb.from('boxes').insert({ code, title: $('#nTitle').value.trim(), category_id: cat.id, location_id: locId, level: levelsOf(ix.loc.get(locId)) > 1 ? nLevel : null }).select().single());
    putLocal('boxes', row); toast(`${code} created — add photos and contents`);
    go(`/b/${code}`, true);
  };
}
const ROOM_NAMES = ['Garage', 'Basement', 'Office', 'Craft Room', 'Loft', 'Main Floor'];
function roomNames() {
  const extra = [...new Set(S.locations.filter(l => l.kind === 'room').map(l => l.name.trim()))].filter(n => n && !ROOM_NAMES.some(p => norm(p) === norm(n)))
    .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  return [...ROOM_NAMES, ...extra];
}
function uniqueCode(c) {
  c = cleanCode(c).replace(/-+$/, '').slice(0, 17); if (!c) return '';
  let out = c, n = 2; while (ix.locByCode.has(out) || ix.boxByCode.has(out)) out = `${c}${n++}`;
  return out;
}
function suggestCode(name, parent, kind) {
  const words = cleanCode(name).split('-').filter(Boolean); if (!words.length) return '';
  let part;
  if (kind === 'building') part = words[0].slice(0, 4);
  else if (kind === 'room') part = words[0].slice(0, 3);
  else part = words.length > 1 && words[words.length - 1].length <= 2 ? words[words.length - 1] : words.map(w => w[0]).join('');
  return uniqueCode(parent ? `${parent.code}-${part}` : part);
}
function nextShelfName(parent) {
  const used = new Set((ix.kids.get(parent?.id || '') || []).map(k => norm(k.name)));
  for (let i = 0; i < 26; i++) { const n = `Shelf ${String.fromCharCode(65 + i)}`; if (!used.has(norm(n))) return n; }
  return '';
}
function viewNewLoc(params) {
  const parent = ix.locByCode.get(cleanCode(params.get('parent') || ''));
  const presetCode = cleanCode(params.get('code') || '');
  const forBox = ix.boxByCode.get(cleanCode(params.get('box') || ''));
  const kind = ['building', 'room', 'shelf'].includes(params.get('kind')) ? params.get('kind') : parent ? (parent.kind === 'building' ? 'room' : 'shelf') : 'building';
  header(`New ${KIND_LABEL[kind].toLowerCase()}`, { backBtn: true }); tabs('places');
  if (kind === 'building' && !S.me.is_admin) { view().innerHTML = '<div class="card">Only an admin can add buildings.</div>'; return; }
  const nameField = kind === 'room'
    ? `<label class="f">Room<select id="pPick"><option value="">— Choose a room —</option>${roomNames().map(n => `<option>${esc(n)}</option>`).join('')}<option value="__new">＋ Add a new name…</option></select></label>
       <label class="f" id="pNewWrap" hidden>New room name<input id="pName" placeholder="e.g. Pantry, Mud Room"></label>`
    : `<label class="f">${kind === 'building' ? 'Building name' : 'Shelf name'}<input id="pName" value="${kind === 'shelf' ? esc(nextShelfName(parent)) : ''}" placeholder="${kind === 'building' ? 'e.g. Well House' : 'e.g. Shelf A, Rack 2'}"></label>`;
  const parentField = kind === 'building' ? '' : `<label class="f">${kind === 'room' ? 'In building' : 'In'}<select id="pParent"><option value="">— Choose —</option>${locOptions(parent?.id || '', null, kind === 'room' ? ['building'] : ['building', 'room'])}</select></label>`;
  view().innerHTML = `<div class="card">
    ${parentField}${nameField}
    ${kind === 'shelf' ? `<div><div class="lab" style="margin-bottom:6px">Levels on this shelf</div><div class="lvlbtns" id="pLv">${[1, 2, 3, 4, 5, 6].map(n => `<button type="button" class="chip lvlbtn" data-n="${n}" aria-pressed="${n === 1}">${n}</button>`).join('')}</div>
      <div class="small muted" style="margin-top:6px">Level 1 is the bottom. Choose 1 for a single shelf or a spot on the floor.</div></div>` : ''}
    <label class="f">Label code<input id="pCode" value="${esc(presetCode)}" autocapitalize="characters"></label>
    <div class="small muted">Filled in for you — change it if you like.</div>
    <button class="btn primary" id="pGo">Create ${KIND_LABEL[kind].toLowerCase()}</button></div>`;
  let codeTouched = !!presetCode, levels = 1;
  const pick = $('#pPick');
  const nameVal = () => pick && pick.value !== '__new' ? pick.value : ($('#pName')?.value || '').trim();
  const parentLoc = () => ix.loc.get($('#pParent')?.value || '');
  const refresh = () => { if (!codeTouched) $('#pCode').value = suggestCode(nameVal(), parentLoc(), kind); };
  $('#pCode').oninput = () => (codeTouched = true);
  if (pick) pick.onchange = () => { const isNew = pick.value === '__new'; $('#pNewWrap').hidden = !isNew; if (isNew) $('#pName').focus(); refresh(); };
  const pn = $('#pName'); if (pn) pn.oninput = refresh;
  const pp = $('#pParent'); if (pp) pp.onchange = () => { if (kind === 'shelf' && pn && /^Shelf [A-Z]$/.test(pn.value)) pn.value = nextShelfName(parentLoc()); refresh(); };
  $$('#pLv [data-n]').forEach(b => b.onclick = () => { levels = +b.dataset.n; $$('#pLv [data-n]').forEach(x => x.setAttribute('aria-pressed', x === b)); });
  refresh();
  $('#pGo').onclick = async () => {
    const name = nameVal(); if (!name) return toast(kind === 'room' ? 'Choose a room' : 'Give it a name');
    const par = parentLoc(); if (kind !== 'building' && !par) return toast(kind === 'room' ? 'Choose the building' : 'Choose where the shelf is');
    const code = cleanCode($('#pCode').value) || suggestCode(name, par, kind);
    if (!/^[A-Z0-9-]{2,20}$/.test(code)) return toast('Code: letters, numbers and dashes only');
    if (ix.boxByCode.has(code) || ix.locByCode.has(code)) return toast(`${code} is already used`);
    const row = await run(sb.from('locations').insert({ name, code, kind, levels: kind === 'shelf' ? levels : 1, parent_id: par?.id || null }).select().single());
    putLocal('locations', row);
    if (forBox && kind === 'shelf') {
      const lvl = await askLevel(row); await moveBox(forBox, row.id, lvl ?? null);
      toast(`${forBox.code} → ${whereText(ix.box.get(forBox.id))}`); return go(`/b/${forBox.code}`, true);
    }
    toast(`${name} created`); go(`/loc/${code}`, true);
  };
}

// ---------- SCAN ----------
function parseScan(text) {
  text = String(text || '').trim();
  let m;
  try { const u = new URL(text); m = u.pathname.match(/\/(b|loc)\/([A-Za-z0-9-]+)/); if (m) return { type: m[1] === 'b' ? 'box' : 'loc', code: cleanCode(m[2]) }; } catch {}
  const code = cleanCode(text);
  if (ix.boxByCode.has(code)) return { type: 'box', code };
  if (ix.locByCode.has(code)) return { type: 'loc', code };
  return code ? { type: 'unknown', code } : null;
}
function viewScan(params) {
  tabs('scan');
  let to = ix.locByCode.get(cleanCode(params.get('to') || ''));
  const forBox = ix.boxByCode.get(cleanCode(params.get('box') || ''));
  let lvl = parseInt(params.get('level')) || null;
  header(to ? 'Scan boxes onto shelf' : forBox ? `Scan a shelf for ${forBox.code}` : 'Scan a label', { backBtn: !!(to || forBox) });
  const banner = () => to ? `Putting boxes on <b>${esc(locText(to.id))}</b>. ${levelsOf(to) > 1 ? 'Tap the level, then scan each box.' : 'Scan each box label; they move here one after another.'}`
    : forBox ? `Scan the shelf where <b>${esc(forBox.code)}</b> is going.` : 'Point at a box or shelf label.';
  const drawLvls = () => {
    const w = $('#scanLvls'); if (!w) return;
    if (!to || levelsOf(to) <= 1) { w.innerHTML = ''; return; }
    w.innerHTML = `<div class="lab" style="margin-bottom:6px">Level (1 = bottom)</div>${levelButtons(levelsOf(to), lvl)}`;
    $$('[data-lvl]', w).forEach(b => b.onclick = () => { lvl = +b.dataset.lvl; drawLvls(); toast(`Level ${lvl} — scan boxes`); });
  };
  view().innerHTML = `<div class="banner" id="banner">${banner()}</div><div id="scanLvls"></div>
    <div class="scanner"><video id="vid" playsinline muted></video><div class="frame"></div></div>
    <div id="camErr" class="card" hidden></div>
    <form class="row" id="manual"><input class="grow" id="mCode" placeholder="Or type a code, e.g. XMAS-07" autocapitalize="characters"><button class="btn">Go</button></form>
    ${to ? '<div class="card log" id="log"><div class="lab">Moved here</div></div><a class="btn primary" id="done" href="/loc/' + esc(to.code) + '">Done</a>' : ''}
    <p class="small muted">Your phone's own camera app works too — scanning a label opens that box or shelf right here.</p>`;
  let last = '', lastAt = 0, stream = null, timer = null, busy = false;
  const logLine = html => { const lg = $('#log'); if (lg) lg.insertAdjacentHTML('beforeend', `<div>${html}</div>`); };
  const handle = async text => {
    const r = parseScan(text); if (!r || busy) return;
    const key = r.type + r.code; if (key === last && Date.now() - lastAt < 3000) return;
    last = key; lastAt = Date.now(); busy = true;
    try {
      navigator.vibrate?.(60);
      if (to) {
        if (r.type === 'loc') { const nt = ix.locByCode.get(r.code); if (!nt) { toast(`No shelf ${r.code} yet`); return; } to = nt; lvl = null; history.replaceState(history.state, '', `/scan?to=${to.code}`); $('#banner').innerHTML = banner(); drawLvls(); const d = $('#done'); if (d) d.href = `/loc/${to.code}`; toast(`Now filling ${to.name}`); return; }
        const b = ix.boxByCode.get(r.code);
        if (!b) { toast(`No box ${r.code} yet`); logLine(`⚠️ ${esc(r.code)} isn't set up yet — <a href="/new?code=${esc(r.code)}&loc=${esc(to.code)}${lvl ? `&level=${lvl}` : ''}">create it</a>`); return; }
        if (levelsOf(to) > 1 && !lvl) { toast('Tap the level first, then scan the box'); last = ''; return; }
        const useLvl = levelsOf(to) > 1 ? lvl : null;
        if (b.location_id === to.id && (b.level ?? null) === useLvl) { toast(`${b.code} is already here`); return; }
        await moveBox(b, to.id, useLvl); toast(`✓ ${b.code} → ${useLvl ? `level ${useLvl}` : 'here'}`);
        logLine(`✓ <b class="code">${esc(b.code)}</b> ${esc(b.title)}${useLvl ? ` <span class="muted">· Level ${useLvl}</span>` : ''}`);
      } else if (forBox) {
        if (r.type !== 'loc') { toast('That\'s not a shelf label'); return; }
        const l = ix.locByCode.get(r.code); if (!l) { toast(`No shelf ${r.code} yet`); return; }
        S.cleanup?.(); const lv = await askLevel(l); if (lv === undefined) { go(`/scan?box=${forBox.code}`, true); return; }
        await moveBox(forBox, l.id, lv); toast(`${forBox.code} → ${whereText(ix.box.get(forBox.id))}`); go(`/b/${forBox.code}`, true);
      } else {
        go(r.type === 'loc' ? `/loc/${r.code}` : `/b/${r.code}`);
      }
    } finally { busy = false; }
  };
  drawLvls();
  $('#manual').onsubmit = e => { e.preventDefault(); last = ''; handle($('#mCode').value); $('#mCode').value = ''; };
  S.cleanup = () => { clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()); stream = null; };
  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
      const v = $('#vid'); if (!v) return S.cleanup?.();
      v.srcObject = stream; await v.play();
      const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
      const jsQR = detector ? null : (await import('https://esm.sh/jsqr@1.4.0')).default;
      const c = document.createElement('canvas'); const ctx = c.getContext('2d', { willReadFrequently: true });
      const tick = async () => {
        if (!stream || !v.videoWidth) { timer = setTimeout(tick, 200); return; }
        try {
          if (detector) { const codes = await detector.detect(v); if (codes[0]) await handle(codes[0].rawValue); }
          else {
            const w = 640, h = Math.round(640 * v.videoHeight / v.videoWidth); c.width = w; c.height = h;
            ctx.drawImage(v, 0, 0, w, h); const res = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
            if (res?.data) await handle(res.data);
          }
        } catch (e) { console.warn(e); }
        if (stream) timer = setTimeout(tick, 180);
      };
      tick();
    } catch (e) {
      const el = $('#camErr'); if (!el) return;
      el.hidden = false; $('.scanner').hidden = true;
      el.innerHTML = `<b>Camera isn't available.</b><span class="small muted">Allow camera access for this site in your browser settings, or type the code below.</span>`;
    }
  })();
}

// ---------- MORE / LABELS / CATEGORIES / FAMILY ----------
function viewMore() {
  header('More'); tabs('more');
  const unl = S.boxes.filter(b => !b.labeled).length + S.locations.filter(l => l.kind === 'shelf' && !l.labeled).length;
  view().innerHTML = `<div class="card"><div class="lab">Signed in</div><div><b>${esc(S.me.name || S.me.email)}</b> <span class="muted small">${esc(S.me.email)}</span></div></div>
    <div class="card" style="padding:4px 14px"><div class="list">
      <a class="locrow" href="/labels"><span class="nm">Labels to print</span><span class="count">${unl}</span></a>
      <a class="locrow" href="/categories"><span class="nm">Categories</span><span class="count">${S.categories.length}</span></a>
      <a class="locrow" href="/family"><span class="nm">Family members</span><span class="count">${S.members.length}</span></a>
      <a class="locrow" href="#" id="exp"><span class="nm">Download everything (spreadsheet)</span><span class="muted">CSV</span></a>
    </div></div>
    <details class="card"><summary class="lab" style="cursor:pointer">Put this app on your phone's home screen</summary>
      <p class="small" style="margin:0"><b>iPhone:</b> open this page in Safari → Share button → <i>Add to Home Screen</i>.<br><b>Android:</b> open in Chrome → ⋮ menu → <i>Add to Home screen</i> (or <i>Install app</i>).</p></details>
    <button class="btn" id="refresh">Refresh data</button>
    <button class="btn danger" id="out">Sign out</button>
    <p class="small muted center">Home Organizer ${VERSION}</p>`;
  $('#exp').onclick = e => {
    e.preventDefault();
    const rows = [['Box', 'Box name', 'Category', 'Place', 'Item', 'Qty', 'Item notes', 'Box notes', 'Link']];
    for (const b of [...S.boxes].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))) {
      const its = ix.itemsByBox.get(b.id) || [{ name: '', qty: '', notes: '' }];
      for (const i of its) rows.push([b.code, b.title, ix.cat.get(b.category_id)?.name, whereText(b), i.name, i.qty, i.notes, b.notes, boxLink(b.code)]);
    }
    downloadCsv(`home-organizer-${new Date().toISOString().slice(0, 10)}.csv`, rows);
  };
  $('#refresh').onclick = async () => { await loadAll(); toast('Up to date'); viewMore(); };
  $('#out').onclick = async () => { await sb.auth.signOut(); location.href = '/'; };
}
function downloadCsv(name, rows) {
  const csv = rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })); a.download = name; a.setAttribute('download', name);
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function viewLabels(params) {
  header('Labels to print', { backBtn: true }); tabs('more');
  const all = params.get('all') === '1';
  const boxes = S.boxes.filter(b => all || !b.labeled).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const locs = S.locations.filter(l => l.kind === 'shelf' && (all || !l.labeled)).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const row = (kind, r) => `<div class="locrow" style="grid-template-columns:1fr auto"><div style="min-width:0"><span class="code">${esc(r.code)}</span> ${esc(kind === 'box' ? r.title : locText(r.id))}${r.labeled ? ' <span class="pill">✓ printed</span>' : ''}<div class="small muted" style="word-break:break-all">${esc(kind === 'box' ? boxLink(r.code) : locLink(r.code))}</div></div>
    <div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-copy="${esc(kind === 'box' ? boxLink(r.code) : locLink(r.code))}">Copy</button><button class="btn sm" data-done="${kind}:${r.id}">${r.labeled ? 'Undo' : 'Printed'}</button></div></div>`;
  view().innerHTML = `<div class="card"><h2>Printing on the P-touch</h2>
      <p class="small" style="margin:0"><b>One label:</b> Copy the link, then in P-touch Editor choose Insert → QR Code and paste it. Add the code (like XMAS-07) in big text next to it.<br>
      <b>A batch:</b> Download the file below, then in P-touch Editor use <i>File → Database → Connect</i>, pick the file, and link the QR code to the <i>Link</i> column and the text to the <i>Code</i> column. Print all records at once.</p>
      <button class="btn primary" id="csv">Download label file (${boxes.length + locs.length})</button>
      <a class="small" href="/labels${all ? '' : '?all=1'}">${all ? 'Show only labels not yet printed' : 'Show all labels, including printed'}</a></div>
    <div class="card" style="padding:10px 14px 4px"><h2>Boxes <span class="count">${boxes.length}</span></h2><div class="list">${boxes.map(b => row('box', b)).join('') || '<p class="muted small">All box labels printed.</p>'}</div></div>
    <div class="card" style="padding:10px 14px 4px"><h2>Shelves <span class="count">${locs.length}</span></h2><div class="list">${locs.map(l => row('loc', l)).join('') || '<p class="muted small">All shelf labels printed.</p>'}</div></div>
    ${boxes.length + locs.length && !all ? '<button class="btn" id="allDone">Mark all of these as printed</button>' : ''}`;
  wireCopy(view());
  $('#csv').onclick = () => downloadCsv('ptouch-labels.csv', [['Code', 'Name', 'Link'],
    ...boxes.map(b => [b.code, b.title, boxLink(b.code)]), ...locs.map(l => [l.code, locText(l.id), locLink(l.code)])]);
  const mark = async (kind, id, val) => {
    const t = kind === 'box' ? 'boxes' : 'locations';
    const r = await run(sb.from(t).update({ labeled: val }).eq('id', id).select().single()); putLocal(t, r);
  };
  $$('[data-done]').forEach(b => b.onclick = async () => {
    const [kind, id] = b.dataset.done.split(':'); const rec = (kind === 'box' ? ix.box : ix.loc).get(id);
    await mark(kind, id, !rec.labeled); viewLabels(params);
  });
  const ad = $('#allDone'); if (ad) ad.onclick = async () => {
    if (!confirm(`Mark ${boxes.length + locs.length} labels as printed?`)) return;
    for (const b of boxes) await mark('box', b.id, true); for (const l of locs) await mark('loc', l.id, true);
    toast('All marked printed'); viewLabels(params);
  };
}
function viewCats() {
  header('Categories', { backBtn: true }); tabs('more');
  const admin = S.me.is_admin;
  view().innerHTML = `<div class="card" style="padding:4px 14px"><div class="list">${S.categories.map(c => {
      const n = S.boxes.filter(b => b.category_id === c.id).length;
      return `<div class="locrow" ${admin ? `data-c="${c.id}" style="cursor:pointer"` : ''}><div class="row" style="gap:8px"><span class="dot" style="background:${esc(c.color)};width:14px;height:14px"></span><span class="nm">${esc(c.name)}</span><span class="code muted small">${esc(c.prefix)}</span>${c.is_private ? '<span class="pill">🔒 Private</span>' : ''}</div><span class="count">${plural(n, 'box')}</span></div>`;
    }).join('')}</div></div>
    ${admin ? '<button class="btn primary" id="addCat">＋ Add a category</button>' : '<p class="small muted">Only an admin can change categories.</p>'}
    <p class="small muted">🔒 Private categories are only visible to family members you allow to see them (set under Family members). Use a neutral prefix like STOR so the label doesn't say what's inside.</p>`;
  if (!admin) return;
  const edit = c => {
    const used = c && S.boxes.some(b => b.category_id === c.id);
    const s = sheet(`<h3>${c ? 'Edit category' : 'New category'}</h3>
      <label class="f">Name<input id="cName" value="${esc(c?.name || '')}" placeholder="e.g. Camping gear"></label>
      <label class="f">Box number prefix<input id="cPre" value="${esc(c?.prefix || '')}" placeholder="e.g. CAMP" autocapitalize="characters" ${used ? 'disabled' : ''}></label>
      ${used ? '<div class="small muted">The prefix is locked because boxes already use it.</div>' : '<div class="small muted">2–6 letters or numbers. Boxes will be numbered CAMP-01, CAMP-02…</div>'}
      <label class="f">Color<input id="cCol" type="color" value="${esc(c?.color || '#5b6b73')}" style="height:48px;padding:4px"></label>
      <label class="chk"><input type="checkbox" id="cPriv" ${c?.is_private ? 'checked' : ''}> Private — hide from family members who aren't allowed</label>
      <div class="row"><button class="btn primary grow" id="cSave">Save</button>${c && !used ? '<button class="btn danger" id="cDel">Delete</button>' : ''}</div>`);
    $('#cSave', s).onclick = async () => {
      const row = { name: $('#cName', s).value.trim(), color: $('#cCol', s).value, is_private: $('#cPriv', s).checked };
      if (!used) row.prefix = cleanCode($('#cPre', s).value).replace(/-/g, '');
      if (!row.name) return toast('Give it a name');
      if (!used && !/^[A-Z0-9]{2,6}$/.test(row.prefix)) return toast('Prefix: 2–6 letters or numbers');
      if (!c) row.sort = S.categories.length + 1;
      const saved = await run(c ? sb.from('categories').update(row).eq('id', c.id).select().single() : sb.from('categories').insert(row).select().single());
      putLocal('categories', saved); closeSheet(); viewCats();
    };
    const d = $('#cDel', s); if (d) d.onclick = async () => { await run(sb.from('categories').delete().eq('id', c.id)); dropLocal('categories', c.id); closeSheet(); viewCats(); };
  };
  $('#addCat').onclick = () => edit(null);
  $$('[data-c]').forEach(el => el.onclick = () => edit(ix.cat.get(el.dataset.c)));
}
function viewFamily() {
  header('Family members', { backBtn: true }); tabs('more');
  const admin = S.me.is_admin;
  view().innerHTML = `<div class="card" style="padding:4px 14px"><div class="list">${S.members.map(m => `<div class="locrow" ${admin ? `data-m="${esc(m.email)}" style="cursor:pointer"` : ''}><div><div class="nm">${esc(m.name || m.email)}${m.email === S.me.email ? ' <span class="muted small">(you)</span>' : ''}</div><div class="small muted">${esc(m.email)}</div></div><div class="row" style="gap:4px">${m.is_admin ? '<span class="pill">Admin</span>' : ''}${m.see_private || m.is_admin ? '<span class="pill">🔒 Sees private</span>' : ''}</div></div>`).join('')}</div></div>
    ${admin ? '<button class="btn primary" id="addM">＋ Add a family member</button>' : ''}
    <p class="small muted">Family members sign in with the email listed here — they get a code by email, no password. Send them the app link: <b>${esc(base())}</b></p>`;
  if (!admin) return;
  const edit = m => {
    const self = m?.email === S.me.email;
    const s = sheet(`<h3>${m ? 'Edit family member' : 'Add a family member'}</h3>
      <label class="f">Name<input id="mName" value="${esc(m?.name || '')}"></label>
      <label class="f">Email they sign in with<input id="mEmail" type="email" value="${esc(m?.email || '')}" ${m ? 'disabled' : ''} autocapitalize="none"></label>
      <label class="chk"><input type="checkbox" id="mPriv" ${m?.see_private ? 'checked' : ''}> Can see private categories</label>
      <label class="chk"><input type="checkbox" id="mAdm" ${m?.is_admin ? 'checked' : ''} ${self ? 'disabled' : ''}> Admin (can manage family and categories)</label>
      <div class="row"><button class="btn primary grow" id="mSave">Save</button>${m && !self ? '<button class="btn danger" id="mDel">Remove</button>' : ''}</div>`);
    $('#mSave', s).onclick = async () => {
      const row = { name: $('#mName', s).value.trim(), see_private: $('#mPriv', s).checked };
      if (!self) row.is_admin = $('#mAdm', s).checked;
      if (m) { const r = await run(sb.from('members').update(row).eq('email', m.email).select().single()); Object.assign(m, r); }
      else {
        row.email = $('#mEmail', s).value.trim().toLowerCase();
        if (!/^\S+@\S+\.\S+$/.test(row.email)) return toast('Enter a valid email');
        S.members.push(await run(sb.from('members').insert(row).select().single()));
      }
      closeSheet(); toast('Saved'); viewFamily();
    };
    const d = $('#mDel', s); if (d) d.onclick = async () => {
      if (!confirm(`Remove ${m.name || m.email}? They won't be able to open the app.`)) return;
      await run(sb.from('members').delete().eq('email', m.email)); S.members = S.members.filter(x => x !== m); closeSheet(); viewFamily();
    };
  };
  $('#addM').onclick = () => edit(null);
  $$('[data-m]').forEach(el => el.onclick = () => edit(S.members.find(m => m.email === el.dataset.m)));
}

// ---------- SIGN IN ----------
function viewSignIn(mode = 'in', msg = '') {
  $('#tabs').hidden = true; $('#top').hidden = true;
  const titles = { in: 'Sign in', new: 'First time here? Create your password', reset: 'Reset your password' };
  view().innerHTML = `<div class="signin"><img class="logo" src="/icons/icon-192.png" alt=""><h2>Home Organizer</h2>
    <p class="muted" style="margin:0">${titles[mode]}</p>
    ${msg ? `<div class="card small"><div>${msg}</div></div>` : ''}
    <form id="auth" style="display:flex;flex-direction:column;gap:10px">
      <input id="email" type="email" placeholder="Email" autocomplete="email" autocapitalize="none" required value="${esc(sessionStorage.getItem('ho-email') || '')}">
      ${mode !== 'reset' ? `<input id="pw" type="password" placeholder="${mode === 'new' ? 'Choose a password (8+ characters)' : 'Password'}" autocomplete="${mode === 'new' ? 'new-password' : 'current-password'}" required minlength="${mode === 'new' ? 8 : 1}">` : ''}
      ${mode === 'new' ? '<input id="pw2" type="password" placeholder="Type it again" autocomplete="new-password" required>' : ''}
      <button class="btn primary">${mode === 'in' ? 'Sign in' : mode === 'new' ? 'Create my password' : 'Email me a reset link'}</button>
    </form>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${mode !== 'in' ? '<button class="btn" data-mode="in">Back to sign in</button>' : ''}
      ${mode !== 'new' ? '<button class="btn" data-mode="new">First time here? Create your password</button>' : ''}
      ${mode === 'in' ? '<button class="btn" style="border:0" data-mode="reset">Forgot password?</button>' : ''}
    </div></div>`;
  $$('[data-mode]').forEach(b => b.onclick = () => { sessionStorage.setItem('ho-email', $('#email').value.trim()); viewSignIn(b.dataset.mode); });
  $('#auth').onsubmit = async e => {
    e.preventDefault();
    const email = $('#email').value.trim().toLowerCase(); sessionStorage.setItem('ho-email', email);
    const btn = $('#auth button'); const label = btn.textContent; btn.disabled = true; btn.textContent = 'One moment…';
    const done = () => { btn.disabled = false; btn.textContent = label; };
    if (mode === 'in') {
      const { data, error } = await sb.auth.signInWithPassword({ email, password: $('#pw').value });
      done();
      if (error) {
        if (/confirm/i.test(error.message)) return viewSignIn('in', `Almost there — open the confirmation email sent to <b>${esc(email)}</b> and tap its link, then sign in here.`);
        return toast('Email or password is wrong. First time? Tap "Create your password".', 5000);
      }
      return start(data.session);
    }
    if (mode === 'new') {
      if ($('#pw').value !== $('#pw2').value) { done(); return toast("The two passwords don't match"); }
      const { data, error } = await sb.auth.signUp({ email, password: $('#pw').value, options: { emailRedirectTo: base() + '/' } });
      done();
      if (error) return toast(/registered|exists/i.test(error.message) ? 'That email already has a password. Sign in, or use "Forgot password?".' : error.message, 6000);
      if (data.session) return start(data.session);
      return viewSignIn('in', `Check your email (<b>${esc(email)}</b>) and tap the confirmation link. Then come back here and sign in with your new password. Look in spam if it's not there in a minute.`);
    }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: base() + '/' });
    done();
    if (error) return toast(error.message, 5000);
    viewSignIn('in', `If <b>${esc(email)}</b> has an account, a reset link is on its way. Tap it to choose a new password.`);
  };
}
function viewNewPassword() {
  S.recovering = true;
  $('#tabs').hidden = true; $('#top').hidden = true;
  view().innerHTML = `<div class="signin"><img class="logo" src="/icons/icon-192.png" alt=""><h2>Choose a new password</h2>
    <form id="np" style="display:flex;flex-direction:column;gap:10px"><input id="pw" type="password" placeholder="New password (8+ characters)" autocomplete="new-password" minlength="8" required>
    <input id="pw2" type="password" placeholder="Type it again" autocomplete="new-password" required><button class="btn primary">Save password</button></form></div>`;
  $('#np').onsubmit = async e => {
    e.preventDefault();
    if ($('#pw').value !== $('#pw2').value) return toast("The two passwords don't match");
    const { error } = await sb.auth.updateUser({ password: $('#pw').value });
    if (error) return toast(error.message, 5000);
    S.recovering = false; toast('Password saved');
    const { data: { session } } = await sb.auth.getSession(); history.replaceState(null, '', '/'); start(session);
  };
}

// ---------- boot ----------
async function start(session) {
  if (S.recovering || !session || S.startedFor === session.user.email) return;
  S.startedFor = session.user.email;
  S.email = session.user.email.toLowerCase();
  $('#top').hidden = false;
  try { await loadAll(); } catch (e) { view().innerHTML = `<div class="card">Couldn't load your data: ${esc(e.message)}<button class="btn" onclick="location.reload()">Try again</button></div>`; return; }
  if (!S.me) {
    const { data: claimed } = await sb.rpc('claim_first_admin');
    if (claimed) { await loadAll(); toast('Welcome! You are the admin.'); return render(); }
  }
  if (!S.me) {
    header('Home Organizer'); $('#tabs').hidden = true;
    view().innerHTML = `<div class="card center"><h2 style="justify-content:center">Not on the family list</h2><p class="muted" style="margin:0">${esc(S.email)} hasn't been added yet. Ask whoever runs the app to add you under More → Family members.</p><button class="btn" id="out">Sign out</button></div>`;
    $('#out').onclick = async () => { await sb.auth.signOut(); location.href = '/'; };
    return;
  }
  render();
}
async function boot() {
  if (!configured) {
    $('#top').hidden = true;
    view().innerHTML = '<div class="card"><h2>Almost ready</h2><p>Open <code>js/config.js</code> and paste in your Supabase Project URL and publishable (anon) key.</p></div>';
    return;
  }
  sb.auth.onAuthStateChange((ev, session) => {
    if (ev === 'PASSWORD_RECOVERY') return viewNewPassword();
    if (ev === 'SIGNED_OUT') { S.me = null; S.startedFor = ''; viewSignIn(); }
    else if (ev === 'SIGNED_IN' && session && !S.me && !S.recovering) setTimeout(() => start(session), 0);
  });
  if (recoveryLink) return viewNewPassword();
  const { data: { session } } = await sb.auth.getSession();
  if (session) start(session); else viewSignIn();
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !S.me || Date.now() - S.loadedAt < 30000) return;
  if (document.activeElement?.matches('input,textarea,select') || $('#sheet') || $('#viewer') || location.pathname === '/scan') return;
  try { await loadAll(); render(); } catch {}
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
boot();
