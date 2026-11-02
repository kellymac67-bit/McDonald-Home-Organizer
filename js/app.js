// Home Organizer — single-page app (no build step).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_KEY, PUBLIC_URL } from './config.js';

const VERSION = '2.2.0';
const recoveryLink = /type=recovery/.test(location.hash);
const configured = /^https:\/\//.test(SUPABASE_URL) && SUPABASE_KEY && !SUPABASE_KEY.startsWith('PASTE');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' }
}) : null;

// ---------- state ----------
const S = {
  email: '', me: null,
  members: [], categories: [], locations: [], boxes: [], items: [], photos: [], devices: [], bridge: null, areaLinks: [], scenes: [], prefsRaw: {},
  loadedAt: 0, q: '', cat: '', sub: '', cleanup: null, urls: new Map(),
};
const ix = { catKids: new Map(), cat: new Map(), loc: new Map(), box: new Map(), boxByCode: new Map(), locByCode: new Map(),
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
  S.categories.forEach(c => { const k = c.parent_id || ''; if (!ix.catKids.has(k)) ix.catKids.set(k, []); ix.catKids.get(k).push(c); });
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
  try { await Promise.all([loadDevices(), loadPrefs()]); } catch {}
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
  const bucketOf = i => i.dataset.bucket || 'photos';
  const key = (b, p) => `${b}|${p}`;
  const byBucket = new Map();
  for (const i of imgs) {
    const b = bucketOf(i), c = S.urls.get(key(b, i.dataset.path));
    if (c && c.exp > Date.now()) continue;
    if (!byBucket.has(b)) byBucket.set(b, new Set());
    byBucket.get(b).add(i.dataset.path);
  }
  for (const [b, set] of byBucket) {
    const need = [...set];
    for (let i = 0; i < need.length; i += 100) {
      const { data } = await sb.storage.from(b).createSignedUrls(need.slice(i, i + 100), 6 * 3600);
      (data || []).forEach(d => d.signedUrl && S.urls.set(key(b, d.path), { url: d.signedUrl, exp: Date.now() + 5.5 * 3600e3 }));
    }
  }
  imgs.forEach(i => {
    const c = S.urls.get(key(bucketOf(i), i.dataset.path));
    if (c) i.src = c.url + (i.dataset.ver ? `&v=${encodeURIComponent(i.dataset.ver)}` : '');
  });
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
  home: '<svg viewBox="0 0 24 24"><path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/></svg>',
  lights: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/></svg>',
  cams: '<svg viewBox="0 0 24 24"><path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  org: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 11h18M10 15h4M7 7l2-3h6l2 3"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
};
function tabs(active) {
  const t = [['/', 'Home', 'home'], ['/lights', 'Lights', 'lights'], ...(canCams() ? [['/cameras', 'Cameras', 'cams']] : []), ['/organizer', 'Organizer', 'org'], ['/more', 'More', 'more']];
  const nav = $('#tabs'); nav.hidden = false;
  nav.innerHTML = `<div class="in">${t.map(([href, label, ic]) =>
    `<a href="${href}" class="t-${ic}" ${active === ic ? 'aria-current="page"' : ''}>${ICON[ic]}${label}</a>`).join('')}</div>`;
}
function header(title, { backBtn = false, right = '' } = {}) {
  $('#top').innerHTML = `${backBtn ? '<button class="back" aria-label="Back">‹</button>' : ''}<h1>${esc(title)}</h1>${right}`;
  const b = $('#top .back'); if (b) b.onclick = () => back();
}
const view = () => $('#view');

const routes = [
  [/^\/$/, viewHomeDash], [/^\/organizer$/, viewOrganizer], [/^\/lights$/, viewLights], [/^\/cameras$/, viewCameras],
  [/^\/edit-home$/, viewEditHome], [/^\/weather$/, viewWeather], [/^\/scene\/([^/]+)$/, viewSceneEditor], [/^\/home$/, () => go('/', true)],
  [/^\/b\/([^/]+)$/, viewBox], [/^\/loc\/([^/]+)$/, viewLoc],
  [/^\/places$/, viewPlaces], [/^\/scan$/, viewScan], [/^\/new$/, viewNewBox], [/^\/new-place$/, viewNewLoc],
  [/^\/devices$/, viewDeviceAdmin],
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
function closeSheet() { stopLive(); $('#sheet')?.remove(); $('#viewer')?.remove(); }

// ---------- shared bits ----------
const topCats = () => ix.catKids.get('') || [];
const subCats = c => ix.catKids.get(c.id) || [];
const catPath = c => !c ? '' : c.parent_id && ix.cat.get(c.parent_id) ? `${ix.cat.get(c.parent_id).name} › ${c.name}` : c.name;
const inCat = (b, id) => { const c = ix.cat.get(b.category_id); return !!c && (c.id === id || c.parent_id === id); };
function catChip(c, pressed, attr = 'data-cat') { return `<button type="button" class="chip" ${attr}="${c.id}" aria-pressed="${pressed}"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</button>`; }
// Every category a box can go in, grouped: main categories with subs get their own row
function catPickerHtml(selectedId) {
  const withSubs = topCats().filter(c => subCats(c).length), plain = topCats().filter(c => !subCats(c).length);
  return withSubs.map(m => `<div class="lab" style="margin-top:4px">${esc(m.name)}</div><div class="chips" style="flex-wrap:wrap">${subCats(m).map(c => catChip(c, c.id === selectedId)).join('')}</div>`).join('')
    + (plain.length ? `<div class="lab" style="margin-top:4px">${withSubs.length ? 'Other' : 'Category'}</div><div class="chips" style="flex-wrap:wrap">${plain.map(c => catChip(c, c.id === selectedId)).join('')}</div>` : '');
}
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

// ---------- HOME DEVICES (cameras, switches, sensors from Home Assistant) ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const canCams = () => !!(S.me?.is_admin || S.me?.see_cameras);
const canControl = () => !!(S.me?.is_admin || S.me?.can_control);
const canUnlock = () => !!(S.me?.is_admin || S.me?.can_unlock);
async function loadDevices() {
  const [d, st, al, sc] = await Promise.all([
    sb.from('ha_devices').select('*').order('name'),
    sb.from('ha_bridge_status').select('*').eq('id', 1).maybeSingle(),
    sb.from('ha_area_links').select('*'),
    sb.from('ha_scenes').select('*').order('sort'),
  ]);
  S.scenes = sc.error ? [] : sc.data;
  S.devices = d.error ? [] : d.data;
  S.bridge = st.error ? null : st.data;
  S.areaLinks = al.error ? [] : al.data;
  S.devicesAt = Date.now();
}
const shownDevices = () => (S.devices || []).filter(d => d.enabled);
const bridgeOnline = () => !!S.bridge?.last_seen && Date.now() - Date.parse(S.bridge.last_seen) < 3 * 60e3;
function relTime(t) {
  if (!t) return 'never';
  const s = (Date.now() - Date.parse(t)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return fmtDate(t);
}
const devName = d => d.display_name || d.name.replace(/\s+live view$/i, '').trim() || d.entity_id;
// name without the device's own name in front ("Tallman WS Wind Speed" → "Wind Speed")
const shortName = d => { const n = devName(d), pre = (d.device_name || '').trim(); return !d.display_name && pre && n.toLowerCase().startsWith(pre.toLowerCase() + ' ') ? n.slice(pre.length + 1) : n; };
const DEV_ICON = { camera: '📷', switch: '🔌', light: '💡', lock: '🔒', cover: '🚪', sensor: '🌡️', binary_sensor: '◉' };
function devIcon(d) {
  if (d.kind === 'sensor') return { humidity: '💧', moisture: '💧', illuminance: '☀️', pressure: '⏲️' }[d.device_class] || '🌡️';
  if (d.kind === 'binary_sensor') return { moisture: '💧', door: '🚪', window: '🪟', garage_door: '🚗', opening: '🚪', motion: '🏃', smoke: '🔥', gas: '⚠️' }[d.device_class] || '◉';
  if (d.kind === 'lock') return d.state === 'locked' ? '🔒' : '🔓';
  if (d.kind === 'cover') return /garage/.test(d.device_class + d.entity_id + d.name.toLowerCase()) ? '🚗' : '🚪';
  return DEV_ICON[d.kind] || '•';
}
const BIN_TEXT = { door: ['Open', 'Closed'], window: ['Open', 'Closed'], opening: ['Open', 'Closed'], garage_door: ['Open', 'Closed'],
  moisture: ['Water!', 'Dry'], motion: ['Motion', 'Clear'], occupancy: ['Occupied', 'Clear'], presence: ['Home', 'Away'], smoke: ['Smoke!', 'Clear'],
  gas: ['Gas!', 'Clear'], cold: ['Cold!', 'OK'], heat: ['Hot!', 'OK'], problem: ['Problem', 'OK'], safety: ['Unsafe', 'OK'], lock: ['Unlocked', 'Locked'],
  vibration: ['Vibration', 'Still'], tamper: ['Tampered', 'OK'] };
const ALARM_CLASSES = ['moisture', 'smoke', 'gas', 'cold', 'heat', 'problem', 'safety', 'tamper'];
function devValue(d) {
  const st = d.state;
  if (!st || st === 'unavailable' || st === 'unknown') return { text: 'Offline', cls: 'off' };
  if (d.kind === 'sensor' && d.device_class === 'timestamp') return { text: relTime(st) };
  if (d.kind === 'sensor' && /wind.*dir/i.test(d.name) && !isNaN(parseFloat(st))) return { text: `${compass(+st)} (${Math.round(+st)}°)` };
  if (d.kind === 'sensor') {
    const n = parseFloat(st);
    if (isNaN(n)) return { text: st };
    const u = d.unit || d.attributes?.unit_of_measurement || '';
    const dec = /inhg/i.test(u) ? 100 : 10;
    return { text: `${Math.round(n * dec) / dec}${u === '%' ? '%' : u ? ' ' + u : ''}` };
  }
  if (d.kind === 'binary_sensor') {
    const on = st === 'on'; const t = BIN_TEXT[d.device_class] || ['On', 'Off'];
    return { text: on ? t[0] : t[1], cls: on && ALARM_CLASSES.includes(d.device_class) ? 'alarm' : on ? 'on' : '' };
  }
  if (d.kind === 'lock') return { text: { locked: 'Locked', unlocked: 'Unlocked', locking: 'Locking…', unlocking: 'Unlocking…', jammed: 'JAMMED', open: 'Open' }[st] || st,
    cls: st === 'jammed' ? 'alarm' : st === 'unlocked' || st === 'open' ? 'on' : '' };
  if (d.kind === 'cover') return { text: { open: 'Open', closed: 'Closed', opening: 'Opening…', closing: 'Closing…' }[st] || st[0].toUpperCase() + st.slice(1), cls: st === 'open' || st === 'opening' ? 'on' : '' };
  return { text: st };
}
function devPlace(d) { return d.location_id ? locTrail(d.location_id) : []; }
const compass = deg => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

function camTile(d) {
  const recent = d.last_motion && Date.now() - Date.parse(d.last_motion) < 15 * 60e3;
  return `<button class="camtile" data-cam="${esc(d.entity_id)}">
    ${d.snapshot_path ? `<img data-bucket="cams" data-path="${esc(d.snapshot_path)}" data-ver="${esc(d.snapshot_at || '')}" alt="">` : '<div class="ph">No picture yet — tap to take one</div>'}
    ${recent ? `<span class="mot">Motion ${esc(relTime(d.last_motion))}</span>` : ''}
    <span class="cap">${esc(devName(d))}${d.snapshot_at ? ` · ${esc(relTime(d.snapshot_at))}` : ''}</span></button>`;
}
function devRow(d, showRoom) {
  const room = showRoom ? devPlace(d).slice(1).map(l => l.name).join(' › ') : '';
  const sub = [room, d.kind === 'switch' || d.kind === 'light' ? (d.last_changed ? `changed ${relTime(d.last_changed)}` : '') : d.last_changed ? `updated ${relTime(d.last_changed)}` : '']
    .filter(Boolean).join(' · ');
  let right;
  if (d.kind === 'switch' || d.kind === 'light') {
    const off = !d.state || d.state === 'unavailable';
    right = off ? '<span class="val off">Offline</span>'
      : `<button class="tgl" role="switch" aria-label="${esc(devName(d))}" aria-checked="${d.state === 'on'}" data-tgl="${esc(d.entity_id)}" ${canControl() ? '' : 'disabled'}></button>`;
  } else if (d.kind === 'lock' && canUnlock() && ['locked', 'unlocked', 'jammed', 'open'].includes(d.state)) {
    const v = devValue(d), act = d.state === 'locked' ? 'unlock' : 'lock';
    right = `<span class="row" style="gap:6px;flex-wrap:nowrap"><span class="val ${v.cls || ''}">${esc(v.text)}</span><button class="btn sm ${act === 'lock' ? 'primary' : ''}" data-lock="${esc(d.entity_id)}" data-act="${act}">${act === 'lock' ? 'Lock' : 'Unlock'}</button></span>`;
  } else if (d.kind === 'cover' && canUnlock() && ['open', 'closed'].includes(d.state)) {
    const v = devValue(d), act = d.state === 'closed' ? 'open' : 'close';
    right = `<span class="row" style="gap:6px;flex-wrap:nowrap"><span class="val ${v.cls || ''}">${esc(v.text)}</span><button class="btn sm ${act === 'close' ? 'primary' : ''}" data-cover="${esc(d.entity_id)}" data-act="${act}">${act === 'open' ? 'Open' : 'Close'}</button></span>`;
  } else { const v = devValue(d); right = `<span class="val ${v.cls || ''}">${esc(v.text)}</span>`; }
  return `<div class="devrow"><span class="ic">${devIcon(d)}</span><div class="grow"><div class="nm">${esc(devName(d))}</div>${sub ? `<div class="small muted">${esc(sub)}</div>` : ''}</div>${right}</div>`;
}
const KIND_ORDER = { lock: 0, cover: 0, switch: 1, light: 1, binary_sensor: 3, sensor: 4 };
function devicesBlock(list, { showRoom = true } = {}) {
  const cams = list.filter(d => d.kind === 'camera' && canCams());
  const rest = list.filter(d => d.kind !== 'camera').sort((a, b) => (KIND_ORDER[a.kind] || 9) - (KIND_ORDER[b.kind] || 9) || devName(a).localeCompare(devName(b)));
  return `${cams.length ? `<div class="cams">${cams.map(camTile).join('')}</div>` : ''}
    ${rest.length ? `<div class="list">${rest.map(d => devRow(d, showRoom)).join('')}</div>` : ''}`;
}
function wireDevices(root, redraw) {
  $$('[data-cam]', root).forEach(b => b.onclick = () => openCamera(S.devices.find(d => d.entity_id === b.dataset.cam), redraw));
  $$('[data-tgl]', root).forEach(b => b.onclick = async () => {
    const d = S.devices.find(x => x.entity_id === b.dataset.tgl); if (!d || b.classList.contains('busy')) return;
    const want = d.state === 'on' ? 'turn_off' : 'turn_on';
    b.classList.add('busy'); b.setAttribute('aria-checked', String(want === 'turn_on'));
    const ok = await sendCommand(d, want);
    if (ok) { d.state = want === 'turn_on' ? 'on' : 'off'; d.last_changed = new Date().toISOString(); }
    await sleep(ok ? 2500 : 0); await loadDevices().catch(() => {}); redraw();
  });
  $$('[data-lock]', root).forEach(b => b.onclick = () => {
    const d = S.devices.find(x => x.entity_id === b.dataset.lock); if (!d) return;
    const act = b.dataset.act;
    const go_ = async () => {
      closeSheet(); b.disabled = true; b.textContent = act === 'lock' ? 'Locking…' : 'Unlocking…';
      const ok = await sendCommand(d, act);
      if (ok) toast(act === 'lock' ? `${devName(d)} locked` : `${devName(d)} unlocked`);
      await sleep(ok ? 3000 : 0); await loadDevices().catch(() => {}); redraw();
    };
    if (act === 'lock') return go_();
    const s = sheet(`<h3>Unlock ${esc(devName(d))}?</h3><p class="small muted" style="margin:0">The door unlocks right away. You'll get a phone alert saying who unlocked it.</p>
      <button class="btn primary" id="uYes">Unlock</button><button class="btn" id="uNo">Cancel</button>`);
    $('#uYes', s).onclick = go_; $('#uNo', s).onclick = closeSheet;
  });
  $$('[data-cover]', root).forEach(b => b.onclick = () => {
    const d = S.devices.find(x => x.entity_id === b.dataset.cover); if (!d) return;
    const act = b.dataset.act;
    const s = sheet(`<h3>${act === 'open' ? 'Open' : 'Close'} ${esc(devName(d))}?</h3>
      <p class="small muted" style="margin:0">${act === 'close' ? 'Make sure nothing and nobody is in the doorway. ' : ''}You'll get a phone alert saying who ${act === 'open' ? 'opened' : 'closed'} it.</p>
      <button class="btn primary" id="cYes">${act === 'open' ? 'Open' : 'Close'} the door</button><button class="btn" id="cNo">Cancel</button>`);
    $('#cNo', s).onclick = closeSheet;
    $('#cYes', s).onclick = async () => {
      closeSheet(); b.disabled = true; b.textContent = act === 'open' ? 'Opening…' : 'Closing…';
      const ok = await sendCommand(d, act);
      if (ok) toast(`${devName(d)} ${act === 'open' ? 'opening' : 'closing'}`);
      await sleep(ok ? 4000 : 0); await loadDevices().catch(() => {}); redraw();
      if (ok) setTimeout(async () => { await loadDevices().catch(() => {}); redraw(); }, 15000);   // doors take a while
    };
  });
  hydrate(root);
}
async function sendCommand(d, action) {
  if (!bridgeOnline()) toast('The house looks offline — trying anyway…', 3000);
  let row;
  try { row = await run(sb.from('ha_commands').insert({ entity_id: d.entity_id, action }).select().single()); } catch { return false; }
  for (let i = 0; i < (action === 'snapshot' ? 50 : 20); i++) {
    await sleep(1000);
    const { data } = await sb.from('ha_commands').select('status, result').eq('id', row.id).maybeSingle();
    if (data?.status === 'done') return true;
    if (data?.status === 'failed') { toast(data.result || "That didn't work", 4000); return false; }
  }
  toast('No answer from the house yet — it may be offline', 4000);
  return false;
}
function openImage(path, caption) {
  const v = document.createElement('div'); v.className = 'viewer'; v.id = 'viewer';
  v.innerHTML = `<div class="bar"><button class="btn sm" data-x>Close</button><span style="color:#fff;align-self:center">${esc(caption || '')}</span><span></span></div><img data-bucket="cams" data-path="${esc(path)}" alt="">`;
  $('[data-x]', v).onclick = () => v.remove();
  document.body.appendChild(v); hydrate(v);
}
async function openCamera(d, redraw) {
  if (!d) return;
  const live = d.platform === 'ring' ? '<button class="btn" id="camLive">▶ Live</button>' : '';
  const s = sheet(`<h3>${esc(devName(d))}</h3>
    <div class="camview" id="camImg"></div>
    <div class="small muted" id="camMeta"></div><div class="small" id="liveState" hidden></div>
    <div class="row"><button class="btn primary grow" id="camRef">Take a new picture</button>${live}</div>
    ${d.on_battery ? '<div class="small muted">Battery camera — pictures are taken on motion or when you ask, to save its battery.</div>' : ''}
    <div class="lab">Recent motion</div><div class="photos" id="camHist"><p class="muted small">Loading…</p></div>`);
  const draw = () => {
    const cur = S.devices.find(x => x.entity_id === d.entity_id) || d;
    $('#camImg', s).innerHTML = cur.snapshot_path ? `<img data-bucket="cams" data-path="${esc(cur.snapshot_path)}" data-ver="${esc(cur.snapshot_at || '')}" alt="">` : '<div class="camph">No picture yet</div>';
    $('#camMeta', s).textContent = [cur.snapshot_at ? `Picture taken ${relTime(cur.snapshot_at)}` : '', cur.last_motion ? `last motion ${relTime(cur.last_motion)}` : ''].filter(Boolean).join(' · ');
    hydrate(s);
  };
  draw();
  const lb = $('#camLive', s);
  if (lb) lb.onclick = () => live_ && live_.entity === d.entity_id ? (stopLive(), lb.textContent = '▶ Live', draw()) : startLive(d, s, draw);
  $('#camRef', s).onclick = async () => {
    const b = $('#camRef', s); b.disabled = true; b.textContent = 'Asking the camera…';
    const ok = await sendCommand(d, 'snapshot');
    await loadDevices().catch(() => {});
    if ($('#camRef', s)) { b.disabled = false; b.textContent = 'Take a new picture'; draw(); }
    if (ok) toast('New picture'); redraw?.();
  };
  const { data } = await sb.from('ha_snapshots').select('*').eq('entity_id', d.entity_id).order('taken_at', { ascending: false }).limit(12);
  const h = $('#camHist', s); if (!h) return;
  h.innerHTML = (data || []).map((p, i) => `<button data-snap="${i}"><img data-bucket="cams" data-path="${esc(p.path)}" alt=""></button>`).join('')
    || '<p class="muted small" style="grid-column:1/-1">No motion pictures in the last few days.</p>';
  $$('[data-snap]', h).forEach(b => b.onclick = () => { const p = data[+b.dataset.snap]; openImage(p.path, `${devName(d)} · ${new Date(p.taken_at).toLocaleString()}`); });
  hydrate(h);
}
// ---------- Ring live view (server function "ring"; keys and tokens never reach the app) ----------
const RING_FN = SUPABASE_URL + '/functions/v1/ring';
let live_ = null;
async function callRing(body) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Sign in again');
  const r = await fetch(RING_FN, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.access_token, apikey: SUPABASE_KEY }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || j.message || `error ${r.status}`); e.status = r.status; throw e; }
  return j;
}
const ringKey = t => String(t || '').trim().toLowerCase().replace(/\s+(live view|live|snapshot|camera)$/, '').trim();
async function ringDeviceFor(d) {
  if (!S.ringDevs || Date.now() - S.ringDevs.at > 10 * 60000) {
    const r = await callRing({ action: 'devices' });
    S.ringDevs = { at: Date.now(), list: r.devices || [], errors: r.errors || [] };
  }
  const keys = [d.device_name, d.name, devName(d)].map(ringKey).filter(Boolean);
  return S.ringDevs.list.find(x => keys.includes(ringKey(x.name)));
}
function setLive(t) { const el = $('#liveState'); if (el) { el.hidden = !t; el.textContent = t; } }
async function startLive(d, s, redraw) {
  stopLive();
  if (!('RTCPeerConnection' in window)) return toast("This browser can't show live video", 4000);
  const lb = $('#camLive', s); if (lb) lb.textContent = '■ Stop';
  const box = $('#camImg', s);
  box.innerHTML = '<video id="liveVid" autoplay playsinline muted></video>';
  setLive('Connecting to the camera…');
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const mine = live_ = { entity: d.entity_id, pc, id: '', session: '', timer: setTimeout(() => { if (live_ === mine) { stopLive(); if (lb) lb.textContent = '▶ Live'; redraw?.(); toast('Live view stopped after 5 minutes'); } }, 5 * 60000) };
  const fail = msg => { if (live_ !== mine) return; stopLive(); if (lb) lb.textContent = '▶ Live'; redraw?.(); setLive(msg); };
  try {
    const rd = await ringDeviceFor(d);
    if (live_ !== mine) return;
    if (!rd) return fail("Couldn't find this camera on the Ring connection. An admin can check More → Home devices → Ring live view.");
    mine.id = rd.id;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = ev => {
      if (live_ !== mine || ev.track.kind !== 'video') return;
      const v = $('#liveVid'); if (v) v.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      setLive('● Live');
    };
    pc.onconnectionstatechange = () => { if (live_ === mine && ['failed', 'disconnected'].includes(pc.connectionState)) fail('The live connection dropped. Tap Live to try again.'); };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(res => { if (pc.iceGatheringState === 'complete') return res(); const t = setTimeout(res, 2500); pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } }); });
    const r = await callRing({ action: 'whep', device_id: rd.id, sdp: pc.localDescription.sdp });
    if (live_ !== mine) { callRing({ action: 'whep_stop', device_id: rd.id, session: r.session }).catch(() => {}); return; }
    mine.session = r.session;
    await pc.setRemoteDescription({ type: 'answer', sdp: r.answer });
    setLive('Starting video…');
  } catch (e) { console.error(e); fail(`Live view didn't start: ${e.message}`); }
}
function stopLive() {
  if (!live_) return; const l = live_; live_ = null; clearTimeout(l.timer);
  try { l.pc.close(); } catch {}
  if (l.session) callRing({ action: 'whep_stop', device_id: l.id, session: l.session }).catch(() => {});
}
// Ring sends the admin back to /ring-link.html after they allow the app; that page hands the one-time details over here.
async function handleRingLink() {
  const m = location.hash.match(/ring-link=([^&]+)&time=(\d+)/);
  let p = m ? { nonce: decodeURIComponent(m[1]), time: m[2] } : null;
  if (!p) try { p = JSON.parse(sessionStorage.getItem('ringLink') || 'null'); } catch {}
  if (!p) return;
  const clear = () => { try { sessionStorage.removeItem('ringLink'); } catch {} if (location.hash) history.replaceState(history.state, '', location.pathname + location.search); };
  if (!S.me?.is_admin) { clear(); return toast('Only an admin can connect Ring', 4000); }
  toast('Finishing the Ring connection…', 20000);
  for (let i = 0; i < 6; i++) {
    try { await callRing({ action: 'link', nonce: p.nonce, time: p.time }); clear(); S.ringDevs = null; toast('Ring is connected'); if (location.pathname === '/devices') render(); return; }
    catch (e) { if (e.status !== 409 || i === 5) { clear(); return toast(`Ring connection didn't finish: ${e.message}`, 6000); } await new Promise(r => setTimeout(r, 3000)); }
  }
}
async function ringCard(el) {
  el.innerHTML = '<h2>Ring live view</h2><p class="small muted" style="margin:0">Checking…</p>';
  let st;
  try { st = await callRing({ action: 'status' }); }
  catch (e) { el.innerHTML = `<h2>Ring live view</h2><p class="small muted" style="margin:0">${e.status === 404 ? 'The "ring" server function isn\'t deployed yet.' : esc(e.message)}</p>`; return; }
  let body;
  if (!st.configured) body = '<p class="small muted" style="margin:0">The Ring app keys haven\'t been added to Supabase yet (RING_CLIENT_ID, RING_CLIENT_SECRET, RING_HMAC_KEY).</p>';
  else if (!st.linked && st.waiting) body = '<p class="small muted" style="margin:0">Ring approved the connection. Tap below to finish.</p><button class="btn primary" id="ringClaim">Finish connecting Ring</button>';
  else if (!st.linked) body = '<p class="small muted" style="margin:0">Not connected yet. In the Ring app on your phone, open Control Center → Authorized Client Services (or the developer console\'s test link) and allow <b>McDonald Home Cameras</b>. Ring brings you back here and it finishes on its own.</p>';
  else {
    let list = '';
    try { const r = await callRing({ action: 'devices' }); S.ringDevs = { at: Date.now(), list: r.devices || [], errors: r.errors || [] };
      list = S.ringDevs.list.map(x => `<div class="small">${x.online === false ? '⚪' : '🟢'} ${esc(x.name)}</div>`).join('') || '<div class="small muted">No home cameras matched. Ring camera names must match the camera names in Home Assistant.</div>';
    } catch (e) { list = `<div class="small muted">${esc(e.message)}</div>`; }
    body = `<p class="small muted" style="margin:0 0 6px">Connected. Live view works on these cameras (Salem Center cameras are always left out):</p>${list}`;
  }
  el.innerHTML = `<h2>Ring live view</h2>${body}`;
  const c = $('#ringClaim', el);
  if (c) c.onclick = async () => { c.disabled = true; try { await callRing({ action: 'claim' }); toast('Ring is connected'); S.ringDevs = null; ringCard(el); } catch (e) { c.disabled = false; toast(e.message, 5000); } };
}
function statusLine() {
  if (!S.bridge) return '<div class="hstatus bad"><span class="sdot"></span>The house hasn\'t connected yet</div>';
  const on = bridgeOnline();
  return `<div class="hstatus ${on ? 'ok' : 'bad'}"><span class="sdot"></span>${on ? 'House connected' : 'House offline'} <span class="muted small">· ${on ? 'checked' : 'last heard'} ${esc(relTime(S.bridge.last_seen))}</span></div>`;
}
function pollDevices(redraw, ms = 10000) {
  const t = setInterval(async () => { if (document.visibilityState !== 'visible' || $('#sheet')) return; try { await loadDevices(); redraw(); } catch {} }, ms);
  return () => clearInterval(t);
}
function locDevicesCard(l) {
  const ids = descendants(l.id);
  const list = shownDevices().filter(d => ids.has(d.location_id) && (d.kind !== 'camera' || canCams()));
  if (!list.length) return '';
  return `<div class="card"><h2>Cameras &amp; devices <span class="count">${list.length}</span></h2>${devicesBlock(list, { showRoom: l.kind === 'building' })}</div>`;
}

// Admin: which devices show, where they go, names, camera picture schedule
function viewDeviceAdmin(params) {
  header('Home devices', { backBtn: true }); tabs('more');
  if (!S.me.is_admin) { view().innerHTML = '<div class="card">Only an admin can change device settings.</div>'; return; }
  let q = '', showHidden = params.get('hidden') === '1';
  view().innerHTML = `<div class="card">${statusLine()}
      ${S.bridge ? `<div class="small muted">Bridge ${esc(S.bridge.version)} · Home Assistant ${esc(S.bridge.ha_version)} · ${esc(S.bridge.message)}</div>` : ''}</div>
    <div class="card" id="ringCard" style="padding:10px 14px"></div>
    <div class="card" style="padding:10px 14px 4px"><h2>Home Assistant areas</h2>
      <p class="small muted" style="margin:0">Link each area to a building or room. Everything in that area — now and later — shows on that page.</p>
      <div class="list" id="areas"></div></div>
    <div class="card" style="padding:10px 14px 4px"><h2>Devices <span class="count" id="dcount"></span></h2>
      <input type="search" id="dq" placeholder="Search devices…">
      <label class="chk"><input type="checkbox" id="dHidden" ${showHidden ? 'checked' : ''}> Include hidden devices</label>
      <div class="list" id="dlist"></div></div>
    <p class="small muted">Only devices that have an Area in Home Assistant are sent to the app. To add or remove one entirely, set or clear its Area in Home Assistant.</p>`;
  ringCard($('#ringCard'));
  const placeOpts = sel => `<option value="">— Not linked —</option>${locOptions(sel || '', null, ['building', 'room'])}`;
  const draw = () => {
    if (!$('#dlist')) return;
    const areas = [...new Set((S.devices || []).map(d => d.ha_area).filter(Boolean))].sort();
    $('#areas').innerHTML = areas.map(a => {
      const link = S.areaLinks.find(x => x.ha_area.toLowerCase() === a.toLowerCase());
      const devs = S.devices.filter(d => d.ha_area === a);
      const cur = link?.location_id || (devs.every(d => d.location_id === devs[0].location_id) ? devs[0].location_id : '');
      return `<div class="locrow"><div><div class="nm">${esc(a)}</div><div class="small muted">${plural(devs.length, 'device')}</div></div>
        <select data-area="${esc(a)}" style="max-width:200px">${placeOpts(cur)}</select></div>`;
    }).join('') || '<p class="muted small">No areas yet.</p>';
    $$('[data-area]').forEach(sel => sel.onchange = async () => {
      const a = sel.dataset.area, loc = sel.value || null;
      if (loc) await run(sb.from('ha_area_links').upsert({ ha_area: a, location_id: loc }));
      else await run(sb.from('ha_area_links').delete().eq('ha_area', a));
      await run(sb.from('ha_devices').update({ location_id: loc }).eq('ha_area', a));
      await loadDevices(); toast(loc ? `${a} → ${locText(loc)}` : `${a} unlinked`); draw();
    });
    const t = norm(q);
    const list = (S.devices || []).filter(d => (showHidden || d.enabled) && (!t || norm([devName(d), d.name, d.entity_id, d.ha_area, d.device_name].join(' ')).includes(t)))
      .sort((a, b) => (a.ha_area || '').localeCompare(b.ha_area || '') || (KIND_ORDER[a.kind] || 0) - (KIND_ORDER[b.kind] || 0) || devName(a).localeCompare(devName(b)));
    $('#dcount').textContent = list.length;
    $('#dlist').innerHTML = list.map(d => `<div class="devrow" data-dev="${esc(d.entity_id)}" style="cursor:pointer${d.enabled ? '' : ';opacity:.55'}"><span class="ic">${devIcon(d)}</span>
      <div class="grow" style="min-width:0"><div class="nm">${esc(devName(d))}</div><div class="small muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc([d.location_id ? locText(d.location_id) : d.ha_area || 'No area', d.kind === 'camera' ? (d.snapshot_minutes ? `picture every ${d.snapshot_minutes} min` : 'pictures on motion only') : ''].filter(Boolean).join(' · '))}</div></div>
      <span class="pill">${d.enabled ? 'Shown' : 'Hidden'}</span></div>`).join('') || '<p class="muted small">No devices match.</p>';
    $$('[data-dev]').forEach(el => el.onclick = () => editDevice(S.devices.find(d => d.entity_id === el.dataset.dev), draw));
  };
  $('#dq').oninput = e => { q = e.target.value; draw(); };
  $('#dHidden').onchange = e => { showHidden = e.target.checked; history.replaceState(history.state, '', showHidden ? '/devices?hidden=1' : '/devices'); draw(); };
  draw();
  loadDevices().then(draw).catch(() => {});
}
function editDevice(d, done) {
  const s = sheet(`<h3>${esc(devName(d))}</h3>
    <div class="small muted">${esc(d.entity_id)}${d.device_name ? ` · ${esc(d.device_name)}` : ''}${d.ha_area ? ` · HA area: ${esc(d.ha_area)}` : ''}</div>
    <label class="chk"><input type="checkbox" id="vEn" ${d.enabled ? 'checked' : ''}> Show in the app</label>
    <label class="f">Name in the app<input id="vName" value="${esc(d.display_name)}" placeholder="${esc(d.name.replace(/\s+live view$/i, ''))}"></label>
    <label class="f">Building or room<select id="vLoc"><option value="">— Not linked —</option>${locOptions(d.location_id || '', null, ['building', 'room'])}</select></label>
    ${d.kind === 'camera' ? `<label class="f">Take a picture<select id="vSnap">${[[0, 'Only on motion or when asked'], [5, 'Every 5 minutes'], [10, 'Every 10 minutes'], [15, 'Every 15 minutes'], [30, 'Every 30 minutes'], [60, 'Every hour']]
      .map(([v, l]) => `<option value="${v}" ${d.snapshot_minutes === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${d.on_battery ? '<div class="small muted">Battery camera — frequent pictures drain its battery.</div>' : ''}` : ''}
    <button class="btn primary" id="vSave">Save</button>`);
  $('#vSave', s).onclick = async () => {
    const patch = { enabled: $('#vEn', s).checked, display_name: $('#vName', s).value.trim(), location_id: $('#vLoc', s).value || null };
    const snap = $('#vSnap', s); if (snap) patch.snapshot_minutes = +snap.value;
    const row = await run(sb.from('ha_devices').update(patch).eq('entity_id', d.entity_id).select().single());
    Object.assign(d, row); closeSheet(); toast('Saved'); done();
  };
}

// ---------- APP 2.0: Home dashboard, Lights, Cameras, Edit Home, scene editor ----------
const SCENE_ICONS = {
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  sun: '<path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2"/><circle cx="12" cy="12" r="4"/>',
  lamp: '<path d="M8 3h8l3 8H5z"/><path d="M12 11v8M8 21h8"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/>',
  bed: '<path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 15h18M7 10V7h4v3"/>',
  house: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  leave: '<path d="M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10"/>',
};
const sicon = (k, size = 22) => `<svg class="sic" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${SCENE_ICONS[k] || SCENE_ICONS.bulb}</svg>`;
const sortedScenes = () => [...(S.scenes || [])].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
const sceneById = id => (S.scenes || []).find(x => x.id === id);
const switchables = () => shownDevices().filter(d => ['switch', 'light'].includes(d.kind));
function placeName(d) { const t = devPlace(d); return t.length ? t.map(l => l.name).join(' › ') : d.ha_area || 'No area'; }
function groupByPlace(list) {
  const order = buildings().map(b => b.name);
  const g = new Map();
  for (const d of list) { const k = placeName(d); if (!g.has(k)) g.set(k, []); g.get(k).push(d); }
  return [...g.entries()].sort(([a], [b]) => {
    const ia = order.indexOf(a.split(' › ')[0]), ib = order.indexOf(b.split(' › ')[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a === 'No area') - (b === 'No area') || a.localeCompare(b);
  });
}

// ---- each person's Home settings ----
const SECTIONS = [['doors', 'Doors'], ['scenes', 'Scenes'], ['glance', 'At a glance & weather'], ['cameras', 'Cameras'], ['boxes', 'Recent boxes']];
const GLANCE_MAX = 8;
const weatherDevices = () => shownDevices().filter(d => d.platform === 'ambient_station' && ['sensor', 'binary_sensor'].includes(d.kind));
function outdoorTemp() {
  const w = weatherDevices().filter(d => d.device_class === 'temperature');
  return w.find(d => /^(outdoor )?temp(erature)?$/i.test(devName(d).replace(/^.*?\b(temp)/i, '$1'))) || w.find(d => !/indoor|inside|feels|dew|chill|heat|max|min|in /i.test(devName(d))) || w[0];
}
async function loadPrefs() {
  const { data, error } = await sb.from('home_prefs').select('prefs').eq('email', S.email).maybeSingle();
  S.prefsRaw = error ? {} : data?.prefs || {};
}
function prefs() {
  const p = S.prefsRaw || {};
  const order = (p.sections || []).filter(s => SECTIONS.some(([k]) => k === s.key));
  for (const [k] of SECTIONS) if (!order.some(s => s.key === k)) order.push({ key: k, show: k !== 'boxes' || !S.devices?.length });
  const glanceDefault = shownDevices().filter(d => d.kind === 'sensor' && d.device_class === 'temperature').sort((a, b) => (b.platform === 'monnit') - (a.platform === 'monnit') || devName(a).localeCompare(devName(b))).slice(0, 3).map(d => d.entity_id);
  const camDefault = shownDevices().filter(d => d.kind === 'camera' && d.snapshot_path).slice(0, 2).map(d => d.entity_id);
  return {
    sections: order,
    scenes: (p.scenes || sortedScenes().map(s => s.id)).filter(id => sceneById(id)),
    lights: (p.lights || []).filter(id => S.devices.some(d => d.entity_id === id)),
    glance: (p.glance || glanceDefault).filter(id => S.devices.some(d => d.entity_id === id)),
    cameras: (p.cameras || camDefault).filter(id => S.devices.some(d => d.entity_id === id)),
  };
}
async function savePrefs(patch) {
  S.prefsRaw = { ...prefs(), ...patch };
  const { error } = await sb.from('home_prefs').upsert({ email: S.email, prefs: S.prefsRaw, updated_at: new Date().toISOString() });
  if (error) toast(error.message, 4000);
}

// ---- commands for scenes and groups ----
async function sendRaw(row, label) {
  if (!bridgeOnline()) toast('The house looks offline — trying anyway…', 3000);
  let ins;
  try { ins = await run(sb.from('ha_commands').insert(row).select('id').single()); } catch { return false; }
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const { data } = await sb.from('ha_commands').select('status, result').eq('id', ins.id).maybeSingle();
    if (data?.status === 'done') { if (label) toast(label); return true; }
    if (data?.status === 'failed') { toast(data.result || "That didn't work", 4000); return false; }
  }
  toast('No answer from the house yet — it may be offline', 4000);
  return false;
}
function sceneRow(sc) {
  const n = (sc.items || []).length;
  const sub = sc.mode === 'single' ? `${plural(n, 'device')}${(sc.extras || []).length ? ' + doors' : ''}` : plural(n, 'light') + (n ? '' : ' — tap to set up');
  const dis = canControl() ? '' : 'disabled';
  const btns = sc.mode === 'single'
    ? `<button class="btn sm primary sbtn" data-scene="${sc.id}" data-act="run" ${dis}>Run</button>`
    : `<button class="btn sm primary sbtn" data-scene="${sc.id}" data-act="on" ${dis}>On</button><button class="btn sm sbtn" data-scene="${sc.id}" data-act="off" ${dis}>Off</button>`;
  return `<div class="scrow">${sicon(sc.icon)}<div class="grow" style="min-width:0">${canControl() ? `<a class="nm" href="/scene/${sc.id}">${esc(sc.name)}</a>` : `<span class="nm">${esc(sc.name)}</span>`}<div class="small muted">${esc(sub)}</div></div>${btns}</div>`;
}
function wireScenes(root, redraw) {
  $$('[data-scene]', root).forEach(b => b.onclick = async () => {
    const sc = sceneById(b.dataset.scene); if (!sc) return;
    const act = b.dataset.act, label = b.textContent;
    $$(`[data-scene="${sc.id}"]`, root).forEach(x => x.disabled = true); b.textContent = '…';
    const ok = await sendRaw({ scene_id: sc.id, action: `scene_${act}` }, `${sc.name}${act === 'run' ? '' : act === 'on' ? ' on' : ' off'}`);
    b.textContent = label;
    await sleep(ok ? 2500 : 0); await loadDevices().catch(() => {}); redraw();
  });
  $$('[data-bulk]', root).forEach(b => b.onclick = async () => {
    const ids = b.dataset.ids.split(',').filter(Boolean); if (!ids.length) return;
    const act = b.dataset.bulk; b.disabled = true;
    const ok = await sendRaw({ action: `bulk_${act}`, payload: { entity_ids: ids } }, act === 'on' ? 'Turned on' : 'Turned off');
    await sleep(ok ? 2500 : 0); await loadDevices().catch(() => {}); redraw();
  });
}

// ---- Home ----
function doorTile(d) {
  const v = devValue(d);
  let btn = '';
  if (d.kind === 'lock' && canUnlock() && ['locked', 'unlocked', 'jammed', 'open'].includes(d.state)) {
    const act = d.state === 'locked' ? 'unlock' : 'lock';
    btn = `<button class="btn sm ${act === 'lock' ? 'primary' : ''}" data-lock="${esc(d.entity_id)}" data-act="${act}">${act === 'lock' ? 'Lock' : 'Unlock'}</button>`;
  } else if (d.kind === 'cover' && canUnlock() && ['open', 'closed'].includes(d.state)) {
    const act = d.state === 'closed' ? 'open' : 'close';
    btn = `<button class="btn sm ${act === 'close' ? 'primary' : ''}" data-cover="${esc(d.entity_id)}" data-act="${act}">${act === 'open' ? 'Open' : 'Close'}</button>`;
  }
  return `<div class="card dtile ${v.cls === 'on' || v.cls === 'alarm' ? 'warn' : ''}"><div class="row" style="gap:10px;flex-wrap:nowrap"><span class="ic">${devIcon(d)}</span><div style="min-width:0"><div style="font-weight:700">${esc(devName(d))}</div><div class="small" style="font-weight:600">${esc(v.text)}</div></div></div>${btn}</div>`;
}
function homeAlerts() {
  const out = [];
  if (S.bridge && !bridgeOnline()) out.push({ text: `House offline — last heard ${relTime(S.bridge.last_seen)}` });
  for (const d of shownDevices()) {
    if (d.kind === 'lock' && d.state === 'jammed') out.push({ text: `${devName(d)} is jammed`, sub: 'Check the lock' });   // unlocked/open doors show in the Doors section
    if (d.kind === 'binary_sensor' && devValue(d).cls === 'alarm') out.push({ text: d.device_class === 'moisture' ? 'Water detected' : `${devName(d)}: ${devValue(d).text.replace(/!$/, '')}`, sub: `${devName(d)} · ${placeName(d)}` });
  }
  return out;
}
function viewHomeDash() {
  header('McDonald Home', { right: '<a class="hdr-link" href="/edit-home">Edit</a>' }); tabs('home');
  view().innerHTML = '<div id="hd" style="display:flex;flex-direction:column;gap:16px"></div>';
  const draw = () => {
    const el = $('#hd'); if (!el) return;
    const p = prefs();
    const parts = [statusLine()];
    const al = homeAlerts();
    if (al.length) parts.push(al.map(a => `<div class="alert"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17.5v.01"/></svg><div class="grow"><b>${esc(a.text)}</b>${a.sub ? `<br><span class="small">${esc(a.sub)}</span>` : ''}</div>${a.btn || ''}</div>`).join(''));
    for (const s of p.sections.filter(s => s.show)) {
      if (s.key === 'doors') {
        const doors = shownDevices().filter(d => ['lock', 'cover'].includes(d.kind));
        if (doors.length) parts.push(`<section class="hsec"><div class="lab">Doors</div><div class="grid2">${doors.map(doorTile).join('')}</div></section>`);
      } else if (s.key === 'scenes') {
        const list = p.scenes.map(sceneById).filter(Boolean);
        parts.push(`<section class="hsec"><div class="row" style="justify-content:space-between"><div class="lab">Scenes</div><a class="small" href="/lights">All lights ›</a></div>
          ${list.length ? `<div class="card" style="padding:4px 14px">${list.map(sceneRow).join('')}</div>` : `<div class="card small muted">No scenes on your Home yet. ${canControl() ? '<a href="/scene/new">Make one</a> or pick some under <a href="/edit-home">Edit</a>.' : ''}</div>`}</section>`);
      } else if (s.key === 'glance') {
        const list = p.glance.map(id => S.devices.find(d => d.entity_id === id)).filter(Boolean);
        const ot = outdoorTemp(), wind = weatherDevices().find(d => /wind.*speed|^wind$/i.test(devName(d)));
        const wbtn = weatherDevices().length ? `<a class="wbtn" href="/weather"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/></svg><span class="grow"><b>Weather</b>${ot ? `<br><span class="small">${esc(devValue(ot).text)}${wind ? ` · wind ${esc(devValue(wind).text)}` : ''}</span>` : ''}</span><span aria-hidden="true">›</span></a>` : '';
        if (list.length || wbtn) parts.push(`<section class="hsec"><div class="lab">At a glance</div>${list.length ? `<div class="card glance" style="grid-template-columns:repeat(${Math.min(list.length, 4)},minmax(0,1fr))">${list.map(d => { const v = devValue(d); const n = parseFloat(d.state); const u = d.unit || ''; const deg = /°/.test(u), pct = u === '%'; const num = d.kind === 'sensor' && !isNaN(n) && d.device_class !== 'timestamp';
          const big = num ? (deg || pct ? `${Math.round(n)}${deg ? '°' : '%'}` : `${/inhg/i.test(u) ? Math.round(n * 100) / 100 : Math.abs(n) < 10 ? Math.round(n * 10) / 10 : Math.round(n)}`) : v.text;
          const unit = num && !deg && !pct && u ? `<span class="gu">${esc(u)}</span>` : '';
          const label = shortName(d).replace(/ (temperature|temp)$/i, '');
          return `<div><div class="gv ${v.cls || ''}">${esc(big)}${unit}</div><div class="small muted">${esc(label)}</div></div>`; }).join('')}</div>` : ''}${wbtn}</section>`);
      } else if (s.key === 'cameras' && canCams()) {
        const list = p.cameras.map(id => S.devices.find(d => d.entity_id === id)).filter(d => d && d.enabled);
        if (list.length) parts.push(`<section class="hsec"><div class="row" style="justify-content:space-between"><div class="lab">Cameras</div><a class="small" href="/cameras">All cameras ›</a></div><div class="cams">${list.map(camTile).join('')}</div></section>`);
      } else if (s.key === 'boxes') {
        const bs = [...S.boxes].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, 4);
        parts.push(`<section class="hsec"><div class="row" style="justify-content:space-between"><div class="lab">Recent boxes</div><a class="small" href="/organizer">Organizer ›</a></div><div class="card" style="padding:4px 14px"><div class="list">${bs.map(b => boxRow(b)).join('') || '<p class="muted small">No boxes yet.</p>'}</div></div></section>`);
      }
    }
    el.innerHTML = parts.join('');
    wireDevices(el, draw); wireScenes(el, draw);
  };
  draw();
  S.cleanup = pollDevices(draw);
  Promise.all([loadDevices(), loadPrefs()]).then(draw).catch(() => {});
}

// ---- Lights ----
function viewLights() {
  header('Lights'); tabs('lights');
  view().innerHTML = '<div id="lv" style="display:flex;flex-direction:column;gap:16px"></div>';
  const draw = () => {
    const el = $('#lv'); if (!el) return;
    const all = switchables(), onIds = all.filter(d => d.state === 'on').map(d => d.entity_id);
    header('Lights', { right: `<span class="hdr-note">${onIds.length} on</span>` });
    const sc = sortedScenes();
    el.innerHTML = `<section class="hsec"><div class="row" style="justify-content:space-between"><div class="lab">Scenes</div>${canControl() ? '<a class="small" href="/scene/new">＋ New scene</a>' : ''}</div>
        ${sc.length ? `<div class="card" style="padding:4px 14px">${sc.map(sceneRow).join('')}</div>` : '<div class="card small muted">No scenes yet.</div>'}
        ${canControl() && onIds.length ? `<button class="btn" data-bulk="off" data-ids="${onIds.join(',')}">Turn off every light (${onIds.length})</button>` : ''}</section>
      ${groupByPlace(all).map(([place, list]) => {
        const on = list.filter(d => d.state === 'on').map(d => d.entity_id), offl = list.filter(d => d.state === 'off').map(d => d.entity_id);
        const bulk = !canControl() ? '' : on.length ? `<button class="btn sm" data-bulk="off" data-ids="${on.join(',')}">All off</button>` : offl.length > 1 ? `<button class="btn sm" data-bulk="on" data-ids="${offl.join(',')}">All on</button>` : '';
        return `<section class="hsec"><div class="row" style="justify-content:space-between"><div class="lab">${esc(place)}</div>${bulk}</div><div class="card" style="padding:2px 14px"><div class="list">${list.sort((a, b) => devName(a).localeCompare(devName(b))).map(d => devRow(d, false)).join('')}</div></div></section>`;
      }).join('') || '<div class="card muted">No lights or switches yet.</div>'}`;
    wireDevices(el, draw); wireScenes(el, draw);
  };
  draw();
  S.cleanup = pollDevices(draw);
  loadDevices().then(draw).catch(() => {});
}

// ---- Cameras ----
function viewCameras(params) {
  header('Cameras'); tabs('cams');
  if (!canCams()) { view().innerHTML = '<div class="card">Ask an admin to turn on <b>Can see cameras</b> for you.</div>'; return; }
  let f = params.get('show') || 'all';
  view().innerHTML = '<div class="chips" id="cf" style="flex-wrap:wrap"></div><div id="cv" style="display:flex;flex-direction:column;gap:16px"></div>';
  const draw = () => {
    const el = $('#cv'); if (!el) return;
    const cams = shownDevices().filter(d => d.kind === 'camera');
    header('Cameras', { right: `<span class="hdr-note">${plural(cams.length, 'camera')}</span>` });
    const groups = groupByPlace(cams).map(([k, v]) => [k.split(' › ')[0], v]).reduce((m, [k, v]) => (m.set(k, [...(m.get(k) || []), ...v]), m), new Map());
    const opts = [['all', 'All'], ['motion', 'Motion today'], ...[...groups.keys()].map(k => [k, k])];
    $('#cf').innerHTML = opts.map(([k, l]) => `<button class="chip" data-f="${esc(k)}" aria-pressed="${f === k}">${esc(l)}</button>`).join('');
    $$('#cf [data-f]').forEach(b => b.onclick = () => { f = b.dataset.f; history.replaceState(history.state, '', f === 'all' ? '/cameras' : `/cameras?show=${encodeURIComponent(f)}`); draw(); });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const keep = d => f === 'all' || (f === 'motion' ? d.last_motion && Date.parse(d.last_motion) >= today : true);
    el.innerHTML = [...groups.entries()].filter(([k]) => f === 'all' || f === 'motion' || f === k).map(([k, list]) => {
      const l = list.filter(keep).sort((a, b) => devName(a).localeCompare(devName(b)));
      return l.length ? `<section class="hsec"><div class="lab">${esc(k)}</div><div class="cams">${l.map(camTile).join('')}</div></section>` : '';
    }).join('') || '<div class="card muted">No cameras match.</div>';
    wireDevices(el, draw);
  };
  draw();
  S.cleanup = pollDevices(draw, 20000);
  loadDevices().then(draw).catch(() => {});
}

// ---- Edit Home ----
function viewEditHome() {
  header('Edit Home', { backBtn: true, right: '<a class="hdr-link" href="/">Done</a>' }); tabs('home');
  view().innerHTML = '<div id="eh" style="display:flex;flex-direction:column;gap:18px"></div>';
  const move = (arr, i, d) => { const a = [...arr]; const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; };
  const upDown = (i, n, key) => `<button class="icb" data-mv="${key}:${i}:-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>▲</button><button class="icb" data-mv="${key}:${i}:1" aria-label="Move down" ${i === n - 1 ? 'disabled' : ''}>▼</button>`;
  const draw = () => {
    const el = $('#eh'); if (!el) return;
    const p = prefs();
    const sens = shownDevices().filter(d => ['sensor', 'binary_sensor'].includes(d.kind));
    const cams = shownDevices().filter(d => d.kind === 'camera');
    el.innerHTML = `<p class="small muted" style="margin:0">This is your own Home screen — other family members set up theirs.</p>
      <section class="hsec"><div class="lab">Sections</div><div class="card" style="padding:2px 14px"><div class="list">
        ${p.sections.map((s, i) => `<div class="erow">${upDown(i, p.sections.length, 'sections')}<span class="grow" style="font-weight:650">${esc(SECTIONS.find(([k]) => k === s.key)[1])}</span><button class="tgl" role="switch" aria-checked="${s.show}" data-sec="${s.key}" aria-label="Show ${esc(s.key)}"></button></div>`).join('')}
      </div></div><div class="small muted">Alerts (an unlocked door, water, an open garage) always show at the top.</div></section>

      <section class="hsec"><div class="lab">Scenes on my Home</div><div class="card" style="padding:2px 14px"><div class="list">
        ${p.scenes.map((id, i) => { const sc = sceneById(id); return `<div class="erow">${upDown(i, p.scenes.length, 'scenes')}<span class="grow" style="font-weight:650">${canControl() ? `<a href="/scene/${sc.id}" style="color:inherit">${esc(sc.name)}</a>` : esc(sc.name)}</span><button class="icb" data-rm="scenes:${i}" aria-label="Take ${esc(sc.name)} off my Home">✕</button></div>`; }).join('') || '<p class="small muted">None.</p>'}
      </div></div><div class="grid2"><button class="add" id="addScene">＋ Add a scene</button>${canControl() ? '<a class="add" href="/scene/new">＋ New scene</a>' : ''}</div></section>

      <section class="hsec"><div class="lab">At a glance — pick up to ${GLANCE_MAX}</div><div class="chips" style="flex-wrap:wrap">
        ${sens.map(d => `<button class="chip" data-gl="${esc(d.entity_id)}" aria-pressed="${p.glance.includes(d.entity_id)}">${esc(devName(d))}</button>`).join('') || '<span class="small muted">No sensors yet.</span>'}</div></section>

      ${canCams() ? `<section class="hsec"><div class="lab">Cameras — pick up to 2</div><div class="chips" style="flex-wrap:wrap">
        ${cams.map(d => `<button class="chip" data-cm="${esc(d.entity_id)}" aria-pressed="${p.cameras.includes(d.entity_id)}">${esc(devName(d))}</button>`).join('')}</div></section>` : ''}

      <section class="hsec"><div class="lab">More</div><div class="card" style="padding:4px 14px"><div class="list">
        ${S.me.is_admin ? '<a class="locrow" href="/devices"><span class="nm">Home devices &amp; areas</span><span>›</span></a>' : ''}
        <a class="locrow" href="/family"><span class="nm">Family members</span><span>›</span></a></div></div></section>`;
    $$('[data-mv]', el).forEach(b => b.onclick = async () => { const [k, i, d] = b.dataset.mv.split(':'); await savePrefs({ [k]: move(prefs()[k], +i, +d) }); draw(); });
    $$('[data-rm]', el).forEach(b => b.onclick = async () => { const [k, i] = b.dataset.rm.split(':'); const a = [...prefs()[k]]; a.splice(+i, 1); await savePrefs({ [k]: a }); draw(); });
    $$('[data-sec]', el).forEach(b => b.onclick = async () => { await savePrefs({ sections: prefs().sections.map(s => s.key === b.dataset.sec ? { ...s, show: !s.show } : s) }); draw(); });
    $$('[data-gl]', el).forEach(b => b.onclick = async () => { let g = [...prefs().glance]; const id = b.dataset.gl; g = g.includes(id) ? g.filter(x => x !== id) : g.length >= GLANCE_MAX ? (toast(`Up to ${GLANCE_MAX} — take one off first`), g) : [...g, id]; await savePrefs({ glance: g }); draw(); });
    $$('[data-cm]', el).forEach(b => b.onclick = async () => { let g = [...prefs().cameras]; const id = b.dataset.cm; g = g.includes(id) ? g.filter(x => x !== id) : g.length >= 2 ? (toast('Up to 2 — take one off first'), g) : [...g, id]; await savePrefs({ cameras: g }); draw(); });
    $('#addScene').onclick = () => {
      const left = sortedScenes().filter(s => !prefs().scenes.includes(s.id));
      const s = sheet(`<h3>Add a scene to my Home</h3><div class="list">${left.map(x => `<button class="btn" style="justify-content:flex-start;border:0" data-pick="${x.id}">${sicon(x.icon)} ${esc(x.name)}</button>`).join('') || '<p class="muted small">Every scene is already on your Home.</p>'}</div>${canControl() ? '<a class="btn" href="/scene/new">＋ New scene</a>' : ''}`);
      $$('[data-pick]', s).forEach(b => b.onclick = async () => { await savePrefs({ scenes: [...prefs().scenes, b.dataset.pick] }); closeSheet(); draw(); });
    };
  };
  draw();
  Promise.all([loadDevices(), loadPrefs()]).then(draw).catch(() => {});
}


// ---- Weather (everything from the Ambient station) ----
const W_GROUPS = [['Indoor', /indoor|inside|\bin\b/i], ['Temperature', /temp|feels|dew|chill|heat ?index/i], ['Wind', /wind|gust/i], ['Rain', /rain|precip/i],
  ['Humidity & pressure', /humid|press|baro/i], ['Sun', /solar|uv|lux|radiat|sun/i], ['Other', /./]];
function viewWeather() {
  header('Weather', { backBtn: true }); tabs('home');
  view().innerHTML = '<div id="wv" style="display:flex;flex-direction:column;gap:16px"></div>';
  const draw = () => {
    const el = $('#wv'); if (!el) return;
    const all = weatherDevices();
    if (!all.length) { el.innerHTML = '<div class="card muted">No weather station yet. Add the Ambient Weather Station integration in Home Assistant and give the station an Area.</div>'; return; }
    const short = shortName;
    const find = re => all.find(d => re.test(short(d)));
    const ot = outdoorTemp(), feels = find(/feels/i), hum = all.find(d => d.device_class === 'humidity' && !/indoor|inside|\bin\b/i.test(short(d))), wind = find(/wind.*speed|^wind$/i), dir = find(/wind.*dir/i);
    const latest = all.reduce((m, d) => d.last_changed && d.last_changed > m ? d.last_changed : m, '');
    const val = d => d ? esc(devValue(d).text) : '';
    const groups = new Map();
    for (const d of all.sort((a, b) => short(a).localeCompare(short(b)))) { const g = W_GROUPS.find(([, re]) => re.test(short(d)))[0]; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(d); }
    el.innerHTML = `<div class="card whero">
        <div class="wbig">${ot ? esc(devValue(ot).text.replace(/ ?°F$/, '°')) : '—'}</div>
        <div class="grow" style="display:flex;flex-direction:column;gap:2px">
          ${feels ? `<div>Feels like <b>${val(feels)}</b></div>` : ''}
          ${hum ? `<div>Humidity <b>${val(hum)}</b></div>` : ''}
          ${wind ? `<div>Wind <b>${val(wind)}</b>${dir && !isNaN(parseFloat(dir.state)) ? ` from the ${compass(+dir.state)}` : ''}</div>` : ''}
          <div class="small muted">${esc(all[0].device_name || 'Ambient Weather')} · updated ${esc(relTime(latest))}</div>
        </div></div>
      ${W_GROUPS.map(([g]) => g).filter(g => groups.has(g)).map(g => `<section class="hsec"><div class="lab">${esc(g)}</div><div class="card" style="padding:2px 14px"><div class="list">
        ${groups.get(g).map(d => { const v = devValue(d); return `<div class="devrow" style="min-height:48px;padding:6px 0"><span class="grow" style="font-weight:600">${esc(short(d))}</span><span class="val ${v.cls || ''}">${esc(v.text)}</span></div>`; }).join('')}
      </div></div></section>`).join('')}`;
  };
  draw();
  S.cleanup = pollDevices(draw, 30000);
  loadDevices().then(draw).catch(() => {});
}

// ---- Scene editor ----
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
function viewSceneEditor(id) {
  const existing = id !== 'new' ? sceneById(id) : null;
  header(existing ? 'Edit scene' : 'New scene', { backBtn: true }); tabs('lights');
  if (!canControl()) { view().innerHTML = '<div class="card">Ask an admin to turn on <b>Can use switches and lights</b> for you.</div>'; return; }
  if (id !== 'new' && !existing) { view().innerHTML = '<div class="card">That scene was deleted.</div>'; return; }
  const sc = existing ? JSON.parse(JSON.stringify(existing)) : { name: '', icon: 'bulb', mode: 'pair', items: [], extras: [], extras_with: 'off', schedule: {} };
  let onHome = existing ? prefs().scenes.includes(existing.id) : true, q = '';
  view().innerHTML = `<label class="f">Name<input id="sName" value="${esc(sc.name)}" placeholder="e.g. Outside, Good night"></label>
    <div><div class="lab" style="margin-bottom:6px">Icon</div><div class="row" id="sIcons"></div></div>
    <section class="hsec"><div class="lab" id="sCount"></div><input type="search" id="sq" placeholder="Search lights and switches…"><div id="sItems"></div></section>
    <section class="hsec"><div class="lab">Buttons</div><div class="card" style="padding:2px 14px" id="sMode"></div></section>
    <section class="hsec" id="sExtrasWrap"></section>
    <section class="hsec"><div class="lab">Schedule</div><div id="sSched" style="display:flex;flex-direction:column;gap:10px"></div></section>
    <label class="chk"><input type="checkbox" id="sHome" ${onHome ? 'checked' : ''}> Show on my Home screen</label>
    <button class="btn primary" id="sSave">Save scene</button>
    ${existing ? '<button class="btn danger" id="sDel">Delete scene</button>' : ''}`;
  const icons = () => { $('#sIcons').innerHTML = Object.keys(SCENE_ICONS).map(k => `<button type="button" class="icpick" aria-pressed="${sc.icon === k}" data-ic="${k}" aria-label="${k}">${sicon(k, 20)}</button>`).join('');
    $$('#sIcons [data-ic]').forEach(b => b.onclick = () => { sc.icon = b.dataset.ic; icons(); }); };
  const items = () => {
    const t = norm(q), sel = new Map(sc.items.map(i => [i.entity_id, i]));
    $('#sCount').textContent = `What it controls · ${sc.items.length} selected`;
    const list = switchables().filter(d => sel.has(d.entity_id) || !t || norm(devName(d) + ' ' + placeName(d)).includes(t));
    $('#sItems').innerHTML = groupByPlace(list).map(([place, ds]) => `<div class="lab" style="margin:10px 0 4px">${esc(place)}</div><div class="card" style="padding:2px 14px"><div class="list">${ds.sort((a, b) => devName(a).localeCompare(devName(b))).map(d => {
      const it = sel.get(d.entity_id);
      return `<div class="erow"><label class="chk grow"><input type="checkbox" data-it="${esc(d.entity_id)}" ${it ? 'checked' : ''}> ${esc(devName(d))}</label>${it && sc.mode === 'single' ? `<select data-tg="${esc(d.entity_id)}" style="width:auto;min-height:36px"><option value="on" ${(it.target || 'on') === 'on' ? 'selected' : ''}>Turn on</option><option value="off" ${it.target === 'off' ? 'selected' : ''}>Turn off</option></select>` : ''}</div>`;
    }).join('')}</div></div>`).join('') || '<p class="muted small">No lights match.</p>';
    $$('[data-it]').forEach(c => c.onchange = () => { if (c.checked) sc.items.push({ entity_id: c.dataset.it, target: 'on' }); else sc.items = sc.items.filter(i => i.entity_id !== c.dataset.it); items(); });
    $$('[data-tg]').forEach(s => s.onchange = () => { sc.items.find(i => i.entity_id === s.dataset.tg).target = s.value; });
  };
  const mode = () => {
    $('#sMode').innerHTML = `<label class="erow"><input type="radio" name="sm" value="pair" ${sc.mode === 'pair' ? 'checked' : ''} style="width:22px;height:22px;min-height:0"><span class="grow"><b>On and Off</b><br><span class="small muted">Off turns the same things off</span></span></label>
      <label class="erow"><input type="radio" name="sm" value="single" ${sc.mode === 'single' ? 'checked' : ''} style="width:22px;height:22px;min-height:0"><span class="grow"><b>One button</b><br><span class="small muted">A mix — some things on, some off (like Good night)</span></span></label>`;
    $$('#sMode input').forEach(r => r.onchange = () => { sc.mode = r.value; const s = sc.schedule || {}; sc.schedule = sc.mode === 'single' ? { run: s.run || s.on || { kind: 'none' } } : { on: s.on || s.run || { kind: 'none' }, off: s.off || { kind: 'none' } }; items(); extras(); sched(); });
  };
  const extras = () => {
    const doors = shownDevices().filter(d => ['lock', 'cover'].includes(d.kind));
    if (!canUnlock() || !doors.length) { $('#sExtrasWrap').innerHTML = sc.extras.length ? '<div class="small muted">This scene also locks or closes doors — only people allowed to use doors can change that.</div>' : ''; return; }
    const has = (id, a) => sc.extras.some(x => x.entity_id === id && x.action === a);
    $('#sExtrasWrap').innerHTML = `<div class="lab">Also (optional)</div><div class="card" style="padding:2px 14px"><div class="list">${doors.map(d => {
      const a = d.kind === 'lock' ? 'lock' : 'close';
      return `<label class="erow"><input type="checkbox" data-ex="${esc(d.entity_id)}|${a}" ${has(d.entity_id, a) ? 'checked' : ''} style="width:22px;height:22px;min-height:0"><span class="grow" style="font-weight:650">${a === 'lock' ? 'Lock' : 'Close'} ${esc(devName(d))}</span></label>`;
    }).join('')}</div></div>${sc.mode === 'pair' ? `<label class="f">Do these with the<select id="sWith"><option value="off" ${sc.extras_with === 'off' ? 'selected' : ''}>Off button</option><option value="on" ${sc.extras_with === 'on' ? 'selected' : ''}>On button</option></select></label>` : ''}<div class="small muted">You'll get a phone alert whenever a scene locks a door or closes the garage.</div>`;
    $$('[data-ex]').forEach(c => c.onchange = () => { const [eid, a] = c.dataset.ex.split('|'); sc.extras = sc.extras.filter(x => !(x.entity_id === eid && x.action === a)); if (c.checked) sc.extras.push({ entity_id: eid, action: a }); });
    const w = $('#sWith'); if (w) w.onchange = () => (sc.extras_with = w.value);
  };
  const sched = () => {
    const btns = sc.mode === 'single' ? [['run', 'Run']] : [['on', 'Turn on'], ['off', 'Turn off']];
    sc.schedule = sc.schedule || {};
    $('#sSched').innerHTML = btns.map(([k, label]) => {
      const s = sc.schedule[k] || { kind: 'none' }; const days = s.days || [0, 1, 2, 3, 4, 5, 6];
      return `<div class="card" style="gap:8px"><div class="row" style="justify-content:space-between;flex-wrap:nowrap"><b>${label}</b>
        <select data-sk="${k}" style="width:auto"><option value="none" ${s.kind === 'none' ? 'selected' : ''}>No schedule</option><option value="time" ${s.kind === 'time' ? 'selected' : ''}>At a time</option><option value="sunset" ${s.kind === 'sunset' ? 'selected' : ''}>At sunset</option><option value="sunrise" ${s.kind === 'sunrise' ? 'selected' : ''}>At sunrise</option></select></div>
        ${s.kind === 'time' ? `<input type="time" data-st="${k}" value="${esc(s.time || '22:00')}">` : ''}
        ${s.kind === 'sunset' || s.kind === 'sunrise' ? `<select data-so="${k}">${[-60, -30, -15, 0, 15, 30, 60].map(m => `<option value="${m}" ${(+s.offset || 0) === m ? 'selected' : ''}>${m === 0 ? `Right at ${s.kind}` : `${Math.abs(m)} min ${m < 0 ? 'before' : 'after'} ${s.kind}`}</option>`).join('')}</select>` : ''}
        ${s.kind !== 'none' ? `<div class="row" style="gap:6px">${DAY_LETTERS.map((L, i) => `<button type="button" class="chip day" data-sd="${k}:${i}" aria-pressed="${days.includes(i)}" aria-label="${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i]}">${L}</button>`).join('')}</div>` : ''}</div>`;
    }).join('') + '<div class="small muted">Schedules run on the Pi at home, even if the internet is down.</div>';
    $$('[data-sk]').forEach(s => s.onchange = () => { const k = s.dataset.sk; sc.schedule[k] = { ...(sc.schedule[k] || {}), kind: s.value, days: (sc.schedule[k] || {}).days || [0, 1, 2, 3, 4, 5, 6], time: (sc.schedule[k] || {}).time || '22:00', offset: (sc.schedule[k] || {}).offset || 0 }; sched(); });
    $$('[data-st]').forEach(i => i.onchange = () => (sc.schedule[i.dataset.st].time = i.value));
    $$('[data-so]').forEach(i => i.onchange = () => (sc.schedule[i.dataset.so].offset = +i.value));
    $$('[data-sd]').forEach(b => b.onclick = () => { const [k, d] = b.dataset.sd.split(':'); const s = sc.schedule[k]; const days = new Set(s.days || [0, 1, 2, 3, 4, 5, 6]); days.has(+d) ? days.delete(+d) : days.add(+d); if (!days.size) return toast('Pick at least one day'); s.days = [...days].sort(); sched(); });
  };
  $('#sName').oninput = e => (sc.name = e.target.value);
  $('#sq').oninput = e => { q = e.target.value; items(); };
  $('#sHome').onchange = e => (onHome = e.target.checked);
  icons(); items(); mode(); extras(); sched();
  $('#sSave').onclick = async () => {
    sc.name = sc.name.trim();
    if (!sc.name) return toast('Give the scene a name');
    if (!sc.items.length && !sc.extras.length) return toast('Pick at least one light or switch');
    const row = { name: sc.name, icon: sc.icon, mode: sc.mode, items: sc.items.map(i => sc.mode === 'single' ? { entity_id: i.entity_id, target: i.target || 'on' } : { entity_id: i.entity_id }), extras: sc.extras, extras_with: sc.extras_with, schedule: sc.schedule };
    if (!existing) row.sort = (S.scenes || []).reduce((m, x) => Math.max(m, x.sort || 0), 0) + 1;
    const saved = await run(existing ? sb.from('ha_scenes').update(row).eq('id', existing.id).select().single() : sb.from('ha_scenes').insert(row).select().single());
    S.scenes = [...(S.scenes || []).filter(x => x.id !== saved.id), saved];
    const list = prefs().scenes.filter(x => x !== saved.id);
    await savePrefs({ scenes: onHome ? (existing && prefs().scenes.includes(saved.id) ? prefs().scenes : [...list, saved.id]) : list });
    toast(`${saved.name} saved`); back('/lights');
  };
  const del = $('#sDel'); if (del) del.onclick = async () => {
    if (!confirm(`Delete the scene "${existing.name}" for everyone?`)) return;
    await run(sb.from('ha_scenes').delete().eq('id', existing.id));
    S.scenes = S.scenes.filter(x => x.id !== existing.id);
    toast('Scene deleted'); back('/lights');
  };
}

// ---------- ORGANIZER (search) ----------
function viewOrganizer() {
  header('Organizer'); tabs('org');
  view().innerHTML = `<div class="search"><input type="search" id="q" placeholder="Search boxes and items…" value="${esc(S.q)}" autocomplete="off" enterkeyhint="search">
    <div class="chips" id="catRow"></div><div class="chips" id="subRow"></div></div>
    <div class="qa"><a class="qbtn primary" href="/scan">${ICON.scan}Scan label</a><a class="qbtn" href="/new">${ICON.add}New box</a><a class="qbtn" href="/labels"><svg viewBox="0 0 24 24"><path d="M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z"/></svg>Labels</a></div>
    <section class="hsec" id="blds"><div class="row" style="justify-content:space-between"><div class="lab">Buildings</div><a class="small" href="/places">All places ›</a></div>
      <div class="grid2">${buildings().map(l => { const sm = placeSummary(l); return `<a class="bld" href="/loc/${esc(l.code)}"><span class="nm">${esc(l.name)}</span><span class="small muted">${esc(sm.text || ' ')}</span><span class="count" style="align-self:flex-start">${plural(sm.boxes, 'box')}</span></a>`; }).join('')}</div></section>
    <div id="results"></div>`;
  const q = $('#q');
  q.oninput = () => { S.q = q.value; results(); };
  const drawChips = () => {
    if (S.cat && !ix.cat.get(S.cat)) S.cat = '';
    $('#catRow').innerHTML = `<button class="chip" data-cat="" aria-pressed="${!S.cat}">All</button>${topCats().map(c => catChip(c, S.cat === c.id)).join('')}`;
    const main = ix.cat.get(S.cat); const subs = main ? subCats(main) : [];
    if (!subs.some(c => c.id === S.sub)) S.sub = '';
    $('#subRow').hidden = !subs.length;
    $('#subRow').innerHTML = subs.length ? `<button class="chip" data-sub="" aria-pressed="${!S.sub}">All ${esc(main.name)}</button>${subs.map(c => catChip(c, S.sub === c.id, 'data-sub')).join('')}` : '';
    $$('#catRow [data-cat]').forEach(b => b.onclick = () => { S.cat = b.dataset.cat; S.sub = ''; drawChips(); results(); });
    $$('#subRow [data-sub]').forEach(b => b.onclick = () => { S.sub = b.dataset.sub; drawChips(); results(); });
  };
  drawChips();
  results();
}
function results() {
  const toks = norm(S.q).split(/\s+/).filter(Boolean);
  const bl = $('#blds'); if (bl) bl.hidden = !!(toks.length || S.cat);
  let boxes = S.boxes.filter(b => S.sub ? b.category_id === S.sub : !S.cat || inCat(b, S.cat));
  let out;
  if (!toks.length) {
    out = [...boxes].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).map(b => ({ b, hits: [] }));
  } else {
    out = [];
    for (const b of boxes) {
      const its = ix.itemsByBox.get(b.id) || [];
      const c = ix.cat.get(b.category_id);
      const head = norm([b.code, b.title, b.notes, catPath(c), locText(b.location_id)].join(' '));
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
  tabs('org');
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
    <div class="hero"><div class="row"><span class="bigcode">${esc(b.code)}</span><button class="chip" id="catBtn">${c ? `<span class="dot" style="background:${esc(c.color)}"></span>${esc(catPath(c))}` : 'Category'}</button></div>
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
    const s = sheet(`<h3>Category for ${esc(b.code)}</h3><p class="small muted" style="margin:0">The box keeps its number and label.</p>${catPickerHtml(b.category_id)}`);
    $$('[data-cat]', s).forEach(btn => btn.onclick = async () => { await save({ category_id: btn.dataset.cat }); closeSheet(); rerender(); });
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
  header('Places'); tabs('org');
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
  tabs('org');
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
    <div id="ldevs"></div>
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
  const drawDevs = () => { const el = $('#ldevs'); if (!el) return; el.innerHTML = locDevicesCard(l); el.hidden = !el.innerHTML; wireDevices(el, drawDevs); };
  drawDevs();
  if (kind !== 'shelf' && shownDevices().some(d => descendants(l.id).has(d.location_id))) S.cleanup = pollDevices(drawDevs);
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
  header('New box', { backBtn: navIdx > 0 }); tabs('org');
  const presetCode = cleanCode(params.get('code') || '');
  const presetLoc = ix.locByCode.get(cleanCode(params.get('loc') || ''));
  let cat = presetCode ? S.categories.find(c => presetCode.startsWith(c.prefix + '-') && !subCats(c).length) : null;
  if (!S.categories.length) { view().innerHTML = '<div class="card">No categories yet — an admin needs to add one under More → Categories.</div>'; return; }
  view().innerHTML = `<div class="card">
    <div id="nCats">${catPickerHtml(cat?.id)}</div>
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
  header(`New ${KIND_LABEL[kind].toLowerCase()}`, { backBtn: true }); tabs('org');
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
  tabs('org');
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
      <a class="locrow" href="/edit-home"><span class="nm">Edit my Home screen</span><span class="muted">›</span></a>
      ${S.me.is_admin ? `<a class="locrow" href="/devices"><span class="nm">Home devices &amp; cameras</span><span class="count">${(S.devices || []).filter(d => d.enabled).length}</span></a>` : ''}
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
      for (const i of its) rows.push([b.code, b.title, catPath(ix.cat.get(b.category_id)), whereText(b), i.name, i.qty, i.notes, b.notes, boxLink(b.code)]);
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
  header('Labels to print', { backBtn: true }); tabs('org');
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
  const count = c => S.boxes.filter(b => b.category_id === c.id).length;
  const row = (c, sub) => `<div class="locrow" ${admin ? `data-c="${c.id}"` : ''} style="${sub ? 'padding-left:22px;' : ''}${admin ? 'cursor:pointer' : ''}"><div class="row" style="gap:8px">${sub ? '<span class="muted">└</span>' : ''}<span class="dot" style="background:${esc(c.color)};width:14px;height:14px"></span><span class="nm">${esc(c.name)}</span><span class="code muted small">${esc(c.prefix)}</span>${c.is_private ? '<span class="pill">🔒 Private</span>' : ''}</div><span class="count">${subCats(c).length && !sub ? plural(subCats(c).length, 'sub') : plural(count(c), 'box')}</span></div>`;
  view().innerHTML = `<div class="card" style="padding:4px 14px"><div class="list">${topCats().map(c => row(c, false) + subCats(c).map(x => row(x, true)).join('')).join('')}</div></div>
    ${admin ? '<div class="row"><button class="btn primary grow" id="addCat">＋ Main category</button><button class="btn grow" id="addSub">＋ Sub-category</button></div>' : '<p class="small muted">Only an admin can change categories.</p>'}
    <p class="small muted">Boxes go in a sub-category (Decorations › Christmas) or in a main category that has no subs. Box numbers use the prefix: XMAS-01, HALL-03.<br>🔒 Private on a main category hides everything under it from family members you haven't allowed (Family members). Use a neutral prefix like STOR so labels don't say what's inside.</p>`;
  if (!admin) return;
  const edit = (c, asSub) => {
    const used = c && S.boxes.some(b => b.category_id === c.id);
    const hasKids = c && subCats(c).length;
    const isSub = c ? !!c.parent_id : asSub;
    const mains = topCats().filter(m => m.id !== c?.id);
    const s = sheet(`<h3>${c ? 'Edit category' : isSub ? 'New sub-category' : 'New main category'}</h3>
      ${!hasKids ? `<label class="f">Main category<select id="cPar">${isSub ? '' : '<option value="">— None (this is a main category) —</option>'}${mains.map(m => `<option value="${m.id}" ${c?.parent_id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>` : ''}
      <label class="f">Name<input id="cName" value="${esc(c?.name || '')}" placeholder="${isSub ? 'e.g. Valentine\'s Day' : 'e.g. Camping gear'}"></label>
      <label class="f">Box number prefix<input id="cPre" value="${esc(c?.prefix || '')}" placeholder="e.g. ${isSub ? 'VAL' : 'CAMP'}" autocapitalize="characters" ${used ? 'disabled' : ''}></label>
      ${used ? '<div class="small muted">The prefix is locked because boxes already use it.</div>' : '<div class="small muted">2–6 letters or numbers. Boxes will be numbered like CAMP-01, CAMP-02…</div>'}
      <label class="f">Color<input id="cCol" type="color" value="${esc(c?.color || '#0076B6')}" style="height:48px;padding:4px"></label>
      <label class="chk" id="cPrivWrap"><input type="checkbox" id="cPriv" ${c?.is_private ? 'checked' : ''}> Private — hide from family members who aren't allowed</label>
      <div class="row"><button class="btn primary grow" id="cSave">Save</button>${c && !used && !hasKids ? '<button class="btn danger" id="cDel">Delete</button>' : ''}</div>
      ${c && hasKids ? '<div class="small muted">To delete this, first delete or move its sub-categories.</div>' : ''}`);
    const par = $('#cPar', s);
    const syncPriv = () => { $('#cPrivWrap', s).hidden = !!(par && par.value); };
    if (par) par.onchange = syncPriv; syncPriv();
    $('#cSave', s).onclick = async () => {
      const parent_id = par ? (par.value || null) : (c?.parent_id || null);
      if (asSub && !parent_id) return toast('Choose the main category');
      const row = { name: $('#cName', s).value.trim(), color: $('#cCol', s).value, is_private: parent_id ? false : $('#cPriv', s).checked, parent_id };
      if (!used) row.prefix = cleanCode($('#cPre', s).value).replace(/-/g, '');
      if (!row.name) return toast('Give it a name');
      if (!used && !/^[A-Z0-9]{2,6}$/.test(row.prefix)) return toast('Prefix: 2–6 letters or numbers');
      if (!used && S.categories.some(x => x.prefix === row.prefix && x.id !== c?.id)) return toast(`${row.prefix} is already used`);
      if (!c) row.sort = (parent_id ? subCats(ix.cat.get(parent_id)).length : topCats().length) + 1;
      const saved = await run(c ? sb.from('categories').update(row).eq('id', c.id).select().single() : sb.from('categories').insert(row).select().single());
      putLocal('categories', saved); closeSheet(); viewCats();
    };
    const d = $('#cDel', s); if (d) d.onclick = async () => { if (!confirm(`Delete ${c.name}?`)) return; await run(sb.from('categories').delete().eq('id', c.id)); dropLocal('categories', c.id); closeSheet(); viewCats(); };
  };
  $('#addCat').onclick = () => edit(null, false);
  $('#addSub').onclick = () => edit(null, true);
  $$('[data-c]').forEach(el => el.onclick = () => edit(ix.cat.get(el.dataset.c)));
}
function viewFamily() {
  header('Family members', { backBtn: true }); tabs('more');
  const admin = S.me.is_admin;
  view().innerHTML = `<div class="card" style="padding:4px 14px"><div class="list">${S.members.map(m => `<div class="locrow" ${admin ? `data-m="${esc(m.email)}" style="cursor:pointer"` : ''}><div><div class="nm">${esc(m.name || m.email)}${m.email === S.me.email ? ' <span class="muted small">(you)</span>' : ''}</div><div class="small muted">${esc(m.email)}</div></div><div class="row" style="gap:4px">${m.is_admin ? '<span class="pill">Admin</span>' : ''}${m.see_private || m.is_admin ? '<span class="pill">🔒 Sees private</span>' : ''}${m.see_cameras || m.is_admin ? '<span class="pill">📷</span>' : ''}${m.can_control || m.is_admin ? '<span class="pill">🔌</span>' : ''}${m.can_unlock || m.is_admin ? '<span class="pill">🔑</span>' : ''}</div></div>`).join('')}</div></div>
    ${admin ? '<button class="btn primary" id="addM">＋ Add a family member</button>' : ''}
    <p class="small muted">Family members sign in with the email listed here — they get a code by email, no password. Send them the app link: <b>${esc(base())}</b></p>`;
  if (!admin) return;
  const edit = m => {
    const self = m?.email === S.me.email;
    const s = sheet(`<h3>${m ? 'Edit family member' : 'Add a family member'}</h3>
      <label class="f">Name<input id="mName" value="${esc(m?.name || '')}"></label>
      <label class="f">Email they sign in with<input id="mEmail" type="email" value="${esc(m?.email || '')}" ${m ? 'disabled' : ''} autocapitalize="none"></label>
      <label class="chk"><input type="checkbox" id="mPriv" ${m?.see_private ? 'checked' : ''}> Can see private categories</label>
      <label class="chk"><input type="checkbox" id="mCam" ${m?.see_cameras ? 'checked' : ''}> Can see cameras</label>
      <label class="chk"><input type="checkbox" id="mCtl" ${m?.can_control ? 'checked' : ''}> Can use switches and lights</label>
      <label class="chk"><input type="checkbox" id="mUnl" ${m?.can_unlock ? 'checked' : ''}> Can lock/unlock doors and open the garage</label>
      <label class="chk"><input type="checkbox" id="mAdm" ${m?.is_admin ? 'checked' : ''} ${self ? 'disabled' : ''}> Admin (can manage family and categories)</label>
      <div class="row"><button class="btn primary grow" id="mSave">Save</button>${m && !self ? '<button class="btn danger" id="mDel">Remove</button>' : ''}</div>`);
    $('#mSave', s).onclick = async () => {
      const row = { name: $('#mName', s).value.trim(), see_private: $('#mPriv', s).checked, see_cameras: $('#mCam', s).checked, can_control: $('#mCtl', s).checked };
      if ('can_unlock' in (S.me || {})) row.can_unlock = $('#mUnl', s).checked;
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
  handleRingLink();
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
