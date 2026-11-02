// McDonald Home Bridge — runs as a Home Assistant add-on on the Raspberry Pi.
// Talks to Home Assistant locally and to Supabase over an outgoing connection only.
//  • Sends cameras, switches, lights, locks, covers and selected sensors that have an Area in HA
//  • Uploads camera snapshots (every N minutes, on motion, or when asked from the app)
//  • Carries out commands from the app (switch/light on/off/toggle, take snapshot)
import fs from 'node:fs';
import WebSocket from 'ws';
import { createClient } from '@supabase/supabase-js';

const VERSION = '0.2.0';
const opts = JSON.parse(fs.readFileSync(process.env.OPTIONS_FILE || '/data/options.json', 'utf8'));
// The add-on's Home Assistant token: in the environment, or (under s6-overlay) in its container-environment file
const readFile = f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
const TOKEN = process.env.SUPERVISOR_TOKEN || readFile('/run/s6/container_environment/SUPERVISOR_TOKEN')
  || readFile('/var/run/s6/container_environment/SUPERVISOR_TOKEN') || process.env.HASSIO_TOKEN || '';
const HA_WS = process.env.HA_WS_URL || 'ws://supervisor/core/websocket';
const HA_API = process.env.HA_API_URL || 'http://supervisor/core/api';

const COMMAND_MAX_AGE_MS = 2 * 60 * 1000;   // never run a stale "turn on" after an outage
const MOTION_SNAPSHOT_GAP_MS = 5 * 60 * 1000;
const SENSOR_CLASSES = new Set(['temperature', 'humidity', 'moisture', 'illuminance', 'pressure']);
const BINARY_CLASSES = new Set(['door', 'window', 'opening', 'garage_door', 'moisture', 'motion', 'smoke', 'gas',
  'cold', 'heat', 'problem', 'safety', 'lock', 'occupancy', 'presence', 'vibration', 'tamper']);
const KEEP_ATTRS = ['unit_of_measurement', 'device_class', 'friendly_name', 'brightness', 'battery_level', 'current_position'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
process.on('unhandledRejection', e => log('Unexpected error:', e?.message || e));
process.on('SIGTERM', () => { log('Stopping'); process.exit(0); });

if (!opts.bridge_password) { log('Set bridge_password on the Configuration tab, then restart the add-on.'); await sleep(3600e3); process.exit(1); }

// ---------------------------------------------------------------- Supabase
const sb = createClient(opts.supabase_url, opts.supabase_key, {
  auth: { persistSession: false, autoRefreshToken: true },
  realtime: { transport: WebSocket },
});
let signingIn = null;
function signIn() {
  if (signingIn) return signingIn;
  signingIn = (async () => {
    for (;;) {
      const { error } = await sb.auth.signInWithPassword({ email: opts.bridge_email, password: opts.bridge_password });
      if (!error) { log('Signed in to the app database as', opts.bridge_email); return; }
      log('App sign-in failed:', error.message, '— trying again in 60 s');
      await sleep(60e3);
    }
  })().finally(() => { signingIn = null; });
  return signingIn;
}
sb.auth.onAuthStateChange(ev => { if (ev === 'SIGNED_OUT') signIn(); });
function ok(res, what) {
  if (res.error) {
    log(what + ':', res.error.message);
    if (/jwt|token|401/i.test(res.error.message)) signIn();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- Home Assistant
let ws = null, haReady = false, haVersion = '', msgId = 0;
const pending = new Map();

function haConnect() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(HA_WS);
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: TOKEN }));
      else if (m.type === 'auth_ok') { haReady = true; resolve(m.ha_version); }
      else if (m.type === 'auth_invalid') reject(new Error('Home Assistant refused the add-on token'));
      else if (m.type === 'result') {
        const p = pending.get(m.id); if (!p) return; pending.delete(m.id);
        m.success ? p.res(m.result) : p.rej(new Error(m.error?.message || 'Home Assistant error'));
      } else if (m.type === 'event') onHaEvent(m.event);
    });
    ws.on('error', e => log('Home Assistant connection error:', e.message));
    ws.on('close', () => {
      haReady = false;
      for (const p of pending.values()) p.rej(new Error('Home Assistant connection closed'));
      pending.clear();
      reject(new Error('closed'));
      log('Home Assistant connection closed — reconnecting in 10 s');
      setTimeout(startHa, 10e3);
    });
  });
}
function haCall(msg) {
  return new Promise((res, rej) => {
    if (!haReady) return rej(new Error('Not connected to Home Assistant'));
    const id = ++msgId; pending.set(id, { res, rej });
    ws.send(JSON.stringify({ ...msg, id }));
    setTimeout(() => { if (pending.delete(id)) rej(new Error('Home Assistant did not answer')); }, 30e3);
  });
}
async function startHa() {
  try {
    haVersion = await haConnect();
    log('Connected to Home Assistant', haVersion);
    await haCall({ type: 'subscribe_events', event_type: 'state_changed' });
    for (const t of ['area_registry_updated', 'device_registry_updated', 'entity_registry_updated'])
      await haCall({ type: 'subscribe_events', event_type: t });
    await buildCatalog();
  } catch (e) {
    if (e.message !== 'closed') { log('Home Assistant setup failed:', e.message); scheduleCatalog(60e3); }
  }
}

// ---------------------------------------------------------------- Catalog
let catalog = new Map();        // entity_id → row (metadata + state) as stored in ha_devices
let deviceOf = new Map();       // entity_id → HA device id
let camerasOf = new Map();      // HA device id → [camera entity ids]
let motionOf = new Map();       // motion event / binary_sensor entity → HA device id
let settings = new Map();       // entity_id → { enabled, snapshot_minutes } (set in the app)
let catalogTimer = null;

function scheduleCatalog(ms = 15e3) {
  clearTimeout(catalogTimer);
  catalogTimer = setTimeout(() => buildCatalog().catch(e => { log('Device list update failed:', e.message); scheduleCatalog(60e3); }), ms);
}
const pickAttrs = s => Object.fromEntries(KEEP_ATTRS.filter(k => s.attributes[k] !== undefined).map(k => [k, s.attributes[k]]));

let hasPlatform = null;
async function buildCatalog() {
  if (hasPlatform === null) hasPlatform = !(await sb.from('ha_devices').select('platform').limit(1)).error;
  const [areas, devices, entities, states] = await Promise.all([
    haCall({ type: 'config/area_registry/list' }),
    haCall({ type: 'config/device_registry/list' }),
    haCall({ type: 'config/entity_registry/list' }),
    haCall({ type: 'get_states' }),
  ]);
  const areaName = new Map(areas.map(a => [a.area_id, a.name]));
  const devById = new Map(devices.map(d => [d.id, d]));
  const stateOf = new Map(states.map(s => [s.entity_id, s]));

  const batteryDevs = new Set(), cameraDevs = new Set();
  for (const e of entities) {
    const s = stateOf.get(e.entity_id); if (!e.device_id || !s) continue;
    if (e.entity_id.startsWith('sensor.') && s.attributes.device_class === 'battery') batteryDevs.add(e.device_id);
    if (e.entity_id.startsWith('camera.') && !e.disabled_by) cameraDevs.add(e.device_id);
  }

  const rows = new Map(), dOf = new Map(), cOf = new Map(), mOf = new Map(), defaults = new Map();
  for (const e of entities) {
    if (e.disabled_by || e.hidden_by) continue;
    const dev = devById.get(e.device_id);
    const areaId = e.area_id || dev?.area_id;
    if (!areaId) continue;                       // only devices with an Area are ever sent
    const s = stateOf.get(e.entity_id); if (!s) continue;
    const domain = e.entity_id.split('.')[0];
    const dc = s.attributes.device_class || '';

    // motion triggers (Ring motion/ding events, camera motion sensors) — used for snapshots
    if (e.device_id && cameraDevs.has(e.device_id) &&
        ((domain === 'event' && ['motion', 'doorbell'].includes(dc)) || (domain === 'binary_sensor' && dc === 'motion')))
      mOf.set(e.entity_id, e.device_id);

    if (e.entity_category) continue;              // skip settings / diagnostics
    let kind = null;
    if (['camera', 'switch', 'light', 'lock', 'cover'].includes(domain)) kind = domain;
    else if (domain === 'sensor' && SENSOR_CLASSES.has(dc)) kind = 'sensor';
    else if (domain === 'binary_sensor' && BINARY_CLASSES.has(dc)) kind = 'binary_sensor';
    if (!kind) continue;

    rows.set(e.entity_id, {
      entity_id: e.entity_id, kind,
      name: s.attributes.friendly_name || e.entity_id,
      device_name: dev ? (dev.name_by_user || dev.name || '') : '',
      ha_area: areaName.get(areaId) || '',
      device_class: dc, unit: s.attributes.unit_of_measurement || '',
      on_battery: batteryDevs.has(e.device_id),
      ...(hasPlatform ? { platform: e.platform || '' } : {}),
      state: s.state, attributes: pickAttrs(s), last_changed: s.last_changed,
    });
    defaults.set(e.entity_id, {
      // switches on camera devices (motion detection, privacy…) start hidden; so do things that are offline
      enabled: s.state !== 'unavailable' && !(kind === 'switch' && cameraDevs.has(e.device_id)),
      snapshot_minutes: kind === 'camera' && !batteryDevs.has(e.device_id) ? 15 : 0,
    });
    if (e.device_id) {
      dOf.set(e.entity_id, e.device_id);
      if (kind === 'camera') cOf.set(e.device_id, [...(cOf.get(e.device_id) || []), e.entity_id]);
    }
  }

  // sync with the app database (keeping snapshot/motion info we already have)
  const ex = await sb.from('ha_devices').select('entity_id, snapshot_path, snapshot_at, last_motion');
  if (!ok(ex, 'Reading device list')) throw new Error('database not reachable');
  const inDb = new Map(ex.data.map(r => [r.entity_id, r]));
  const existing = new Set(inDb.keys());
  for (const [id, r] of rows) {
    const old = catalog.get(id), db = inDb.get(id);
    for (const k of ['snapshot_path', 'snapshot_at', 'last_motion']) r[k] = old?.[k] ?? db?.[k] ?? null;
  }
  const fresh = [...rows.values()].filter(r => !existing.has(r.entity_id)).map(r => ({ ...r, ...defaults.get(r.entity_id) }));
  const known = [...rows.values()].filter(r => existing.has(r.entity_id));
  const gone = [...existing].filter(id => !rows.has(id) && !MONNIT_ID.test(id));   // Monnit sensors are managed below
  for (let i = 0; i < fresh.length; i += 200) ok(await sb.from('ha_devices').insert(fresh.slice(i, i + 200)), 'Adding devices');
  for (let i = 0; i < known.length; i += 200) ok(await sb.from('ha_devices').upsert(known.slice(i, i + 200), { onConflict: 'entity_id' }), 'Updating devices');
  for (let i = 0; i < gone.length; i += 100) ok(await sb.from('ha_devices').delete().in('entity_id', gone.slice(i, i + 100)), 'Removing devices');

  catalog = rows; deviceOf = dOf; camerasOf = cOf; motionOf = mOf;
  await loadSettings();
  const n = k => [...rows.values()].filter(r => r.kind === k).length;
  log(`Device list: ${rows.size} items (${n('camera')} cameras, ${n('switch') + n('light')} switches/lights, ` +
      `${n('sensor') + n('binary_sensor')} sensors). Added ${fresh.length}, removed ${gone.length}.`);
}

async function loadSettings() {
  const r = await sb.from('ha_devices').select('entity_id, enabled, snapshot_minutes');
  if (ok(r, 'Reading device settings')) settings = new Map(r.data.map(d => [d.entity_id, d]));
}

// ---------------------------------------------------------------- State changes → app
const dirty = new Set();
function onHaEvent(ev) {
  if (ev.event_type !== 'state_changed') { if (ev.event_type?.endsWith('_registry_updated')) scheduleCatalog(); return; }
  const { entity_id, new_state, old_state } = ev.data;
  if (!new_state) return;

  if (motionOf.has(entity_id)) {
    const isEvent = entity_id.startsWith('event.');
    const fired = isEvent
      ? old_state && !['unavailable', 'unknown'].includes(old_state.state) && new_state.state !== old_state.state && new_state.state !== 'unavailable'
      : new_state.state === 'on' && old_state?.state === 'off';
    if (fired) onMotion(motionOf.get(entity_id));
  }

  const row = catalog.get(entity_id);
  if (!row) return;
  row.state = new_state.state;
  row.attributes = pickAttrs(new_state);
  row.last_changed = new_state.last_changed;
  dirty.add(entity_id);
}

async function flush() {
  if (!dirty.size) return;
  const rows = [...dirty].map(id => catalog.get(id)).filter(Boolean);
  dirty.clear();
  for (let i = 0; i < rows.length; i += 200)
    if (!ok(await sb.from('ha_devices').upsert(rows.slice(i, i + 200), { onConflict: 'entity_id' }), 'Sending states'))
      rows.slice(i).forEach(r => dirty.add(r.entity_id));
}

// ---------------------------------------------------------------- Cameras
const lastMotionSnap = new Map(), busy = new Set();
function onMotion(deviceId) {
  const now = new Date().toISOString();
  for (const cam of camerasOf.get(deviceId) || []) {
    const row = catalog.get(cam); if (!row) continue;
    row.last_motion = now; dirty.add(cam);
    if (!opts.motion_snapshots || !settings.get(cam)?.enabled) continue;
    if (Date.now() - (lastMotionSnap.get(cam) || 0) < MOTION_SNAPSHOT_GAP_MS) continue;
    lastMotionSnap.set(cam, Date.now());
    setTimeout(() => takeSnapshot(cam, 'motion').catch(e => log('Motion snapshot', cam, 'failed:', e.message)), 2000);
  }
}

async function takeSnapshot(entityId, reason) {
  if (busy.has(entityId)) return;
  busy.add(entityId);
  try {
    const r = await fetch(`${HA_API}/camera_proxy/${entityId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(45e3) });
    if (!r.ok) throw new Error(`camera answered ${r.status}`);
    const img = Buffer.from(await r.arrayBuffer());
    const contentType = r.headers.get('content-type') || 'image/jpeg';
    const latest = `${entityId}/latest.jpg`;
    const up = await sb.storage.from('cams').upload(latest, img, { contentType, upsert: true, cacheControl: '60' });
    if (!ok(up, 'Uploading snapshot')) throw new Error('upload failed');
    if (reason !== 'interval') {
      const path = `${entityId}/${Date.now()}.jpg`;
      if (ok(await sb.storage.from('cams').upload(path, img, { contentType }), 'Saving snapshot'))
        ok(await sb.from('ha_snapshots').insert({ entity_id: entityId, path, reason }), 'Recording snapshot');
    }
    const row = catalog.get(entityId);
    if (row) { row.snapshot_path = latest; row.snapshot_at = new Date().toISOString(); dirty.add(entityId); }
  } finally { busy.delete(entityId); }
}

async function snapshotRound() {
  if (!haReady) return;
  for (const row of catalog.values()) {
    if (row.kind !== 'camera') continue;
    const s = settings.get(row.entity_id);
    if (!s?.enabled || !s.snapshot_minutes) continue;
    const age = row.snapshot_at ? Date.now() - Date.parse(row.snapshot_at) : Infinity;
    if (age < s.snapshot_minutes * 60e3) continue;
    try { await takeSnapshot(row.entity_id, 'interval'); }
    catch (e) { log('Snapshot', row.entity_id, 'failed:', e.message); row.snapshot_at = new Date().toISOString(); }
  }
}

// ---------------------------------------------------------------- Commands from the app
let polling = false;
async function pollCommands() {
  if (!haReady || polling) return;
  polling = true;
  try {
    const r = await sb.from('ha_commands').select('*').eq('status', 'pending').order('id').limit(20);
    if (!ok(r, 'Reading commands')) return;
    for (const c of r.data) {
      let status = 'done', result = '';
      try {
        const row = catalog.get(c.entity_id), s = settings.get(c.entity_id);
        if (Date.now() - Date.parse(c.requested_at) > COMMAND_MAX_AGE_MS) throw new Error('Expired — the house was offline');
        if (!row || !s?.enabled) throw new Error('Device not available');
        if (c.action === 'snapshot') {
          if (row.kind !== 'camera') throw new Error('Not a camera');
          await takeSnapshot(c.entity_id, 'request');
        } else {
          if (!['switch', 'light'].includes(row.kind)) throw new Error('Not a switch');
          await haCall({ type: 'call_service', domain: row.kind, service: c.action, target: { entity_id: c.entity_id } });
        }
        log(`Done: ${c.action} ${c.entity_id} (asked by ${c.requested_by})`);
      } catch (e) { status = 'failed'; result = e.message; log(`Failed: ${c.action} ${c.entity_id} — ${e.message}`); }
      ok(await sb.from('ha_commands').update({ status, result, done_at: new Date().toISOString() }).eq('id', c.id), 'Finishing command');
    }
  } finally { polling = false; }
}

// ---------------------------------------------------------------- Monnit (iMonnit Online)
// Reads every sensor from iMonnit every 5 minutes, sends it to the app, and creates a matching
// sensor in Home Assistant (e.g. sensor.monnit_coop_temperature) so automations can use it.
const MONNIT_ID = /^(sensor|binary_sensor)\.monnit_/;
const useMonnit = !!(opts.monnit_api_key_id && opts.monnit_api_secret);
const slug = t => String(t).toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'sensor';
const monnitDate = d => { const m = String(d || '').match(/Date\((\d+)/); return m ? new Date(+m[1]).toISOString() : null; };
function parseMonnit(m) {
  const reading = String(m.CurrentReading ?? '').trim();
  const num = reading.match(/^-?\d+(\.\d+)?/);
  let kind = 'sensor', state = reading, unit = '', dc = '';
  if (!num && /water/i.test(reading)) {
    kind = 'binary_sensor'; dc = 'moisture';
    state = /not\s+present|no\s+water|dry/i.test(reading) ? 'off' : 'on';
  } else if (num) {
    state = num[0];
    if (/^-?[\d.]+\s*%/.test(reading)) { unit = '%'; dc = 'humidity'; }
    else if (/^-?[\d.]+\s*°\s*F/i.test(reading)) { unit = '°F'; dc = 'temperature'; }
    else if (/^-?[\d.]+\s*°\s*C/i.test(reading)) { unit = '°C'; dc = 'temperature'; }
    else unit = reading.slice(num[0].length).trim().split(/\s+/)[0] || '';
  }
  const last = monnitDate(m.LastCommunicationDate);
  if (last && Date.now() - Date.parse(last) > 6 * 3600e3) state = 'unavailable';   // silent for 6 h
  const name = m.SensorName || `Monnit ${m.SensorID}`;
  return {
    entity_id: `${kind}.monnit_${slug(name)}`, kind, name, device_name: 'Monnit', ha_area: '',
    device_class: dc, unit, on_battery: true, ...(hasPlatform ? { platform: 'monnit' } : {}),
    state, last_changed: last,
    attributes: { reading, battery_level: m.BatteryLevel, signal: m.SignalStrength, monnit_id: m.SensorID,
      ...(unit ? { unit_of_measurement: unit } : {}), ...(dc ? { device_class: dc } : {}), friendly_name: name },
  };
}
let monnitCount = -1;
async function monnitRound() {
  if (!useMonnit) return;
  const r = await fetch(process.env.MONNIT_URL || 'https://www.imonnit.com/json/SensorList', {
    method: 'POST', headers: { APIKeyID: opts.monnit_api_key_id, APISecretKey: opts.monnit_api_secret },
    signal: AbortSignal.timeout(30e3) });
  if (!r.ok) throw new Error(`iMonnit answered ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j.Result)) throw new Error('iMonnit: ' + (typeof j.Result === 'string' ? j.Result : 'unexpected answer — check the API keys'));
  const rows = j.Result.map(parseMonnit);
  if (hasPlatform === null) hasPlatform = !(await sb.from('ha_devices').select('platform').limit(1)).error;
  ok(await sb.from('ha_devices').upsert(rows, { onConflict: 'entity_id' }), 'Sending Monnit sensors');
  const ex = await sb.from('ha_devices').select('entity_id');
  if (ok(ex, 'Reading Monnit list')) {
    const keep = new Set(rows.map(x => x.entity_id));
    const gone = ex.data.map(x => x.entity_id).filter(id => MONNIT_ID.test(id) && !keep.has(id));
    if (gone.length) ok(await sb.from('ha_devices').delete().in('entity_id', gone), 'Removing old Monnit sensors');
  }
  for (const x of rows) {                      // mirror into Home Assistant for automations
    try {
      await fetch(`${HA_API}/states/${x.entity_id}`, { method: 'POST', signal: AbortSignal.timeout(10e3),
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: x.state, attributes: { ...x.attributes, source: 'Monnit via McDonald Home Bridge' } }) });
    } catch (e) { log('Could not update', x.entity_id, 'in Home Assistant:', e.message); }
  }
  if (rows.length !== monnitCount) { monnitCount = rows.length; log(`Monnit: ${rows.length} sensors — ${rows.map(x => `${x.name} ${x.state}${x.unit}`).join(', ')}`); }
}

// ---------------------------------------------------------------- Housekeeping
async function heartbeat() {
  ok(await sb.from('ha_bridge_status').upsert({
    id: 1, last_seen: new Date().toISOString(), version: VERSION, ha_version: haVersion,
    message: haReady ? `OK — ${catalog.size} devices` : 'Not connected to Home Assistant',
  }), 'Heartbeat');
}

async function cleanup() {
  const cutoff = new Date(Date.now() - opts.keep_snapshot_days * 86400e3).toISOString();
  const r = await sb.from('ha_snapshots').select('id, path').lt('taken_at', cutoff).limit(500);
  if (!ok(r, 'Finding old snapshots') || !r.data.length) return;
  await sb.storage.from('cams').remove(r.data.map(s => s.path));
  ok(await sb.from('ha_snapshots').delete().in('id', r.data.map(s => s.id)), 'Removing old snapshots');
  log(`Removed ${r.data.length} snapshots older than ${opts.keep_snapshot_days} days`);
}

const every = (ms, fn) => setInterval(() => fn().catch(e => log(e.message)), ms);

// ---------------------------------------------------------------- Start
log(`McDonald Home Bridge ${VERSION} starting`);
if (!TOKEN) log('No Home Assistant token found — check that the add-on has Home Assistant API access.');
await signIn();
await startHa();
every(2e3, pollCommands);
every(3e3, flush);
every(60e3, heartbeat);
every(60e3, loadSettings);
every(60e3, snapshotRound);
every(3600e3, cleanup);
every(3600e3, async () => { if (haReady) await buildCatalog(); });
if (useMonnit) { monnitRound().catch(e => log('Monnit:', e.message)); every(5 * 60e3, monnitRound); }
else log('Monnit not set up (add the iMonnit API key ID and secret on the Configuration tab to turn it on)');
heartbeat().catch(() => {});
