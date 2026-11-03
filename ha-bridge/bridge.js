// McDonald Home Bridge — runs as a Home Assistant add-on on the Raspberry Pi.
// Talks to Home Assistant locally and to Supabase over an outgoing connection only.
//  • Sends cameras, switches, lights, locks, covers and selected sensors that have an Area in HA
//  • Uploads camera snapshots (every N minutes, on motion, or when asked from the app)
//  • Carries out commands from the app (switch/light on/off/toggle, take snapshot)
import fs from 'node:fs';
import WebSocket from 'ws';
import { createClient } from '@supabase/supabase-js';

const VERSION = '0.5.1';
const opts = JSON.parse(fs.readFileSync(process.env.OPTIONS_FILE || '/data/options.json', 'utf8'));
// The add-on's Home Assistant token: in the environment, or (under s6-overlay) in its container-environment file
const readFile = f => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
const TOKEN = process.env.SUPERVISOR_TOKEN || readFile('/run/s6/container_environment/SUPERVISOR_TOKEN')
  || readFile('/var/run/s6/container_environment/SUPERVISOR_TOKEN') || process.env.HASSIO_TOKEN || '';
const HA_WS = process.env.HA_WS_URL || 'ws://supervisor/core/websocket';
const HA_API = process.env.HA_API_URL || 'http://supervisor/core/api';

const COMMAND_MAX_AGE_MS = 2 * 60 * 1000;   // never run a stale "turn on" after an outage
const MOTION_SNAPSHOT_GAP_MS = 5 * 60 * 1000;
const SENSOR_CLASSES = new Set(['temperature', 'humidity', 'moisture', 'illuminance', 'pressure',
  'wind_speed', 'precipitation', 'precipitation_intensity', 'irradiance', 'atmospheric_pressure']);   // incl. weather station
const BINARY_CLASSES = new Set(['door', 'window', 'opening', 'garage_door', 'moisture', 'motion', 'smoke', 'gas',
  'cold', 'heat', 'problem', 'safety', 'lock', 'occupancy', 'presence', 'vibration', 'tamper']);
const KEEP_ATTRS = ['unit_of_measurement', 'device_class', 'friendly_name', 'brightness', 'battery_level', 'current_position',
  // thermostats
  'current_temperature', 'temperature', 'target_temp_low', 'target_temp_high', 'hvac_action', 'hvac_modes', 'preset_mode', 'preset_modes',
  'current_humidity', 'min_temp', 'max_temp', 'target_temp_step', 'fan_mode'];

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

let hasPlatform = null, hasClimate = null;
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
    // a real battery camera reports a numeric battery level and isn't a plug-in model
    const model = devById.get(e.device_id)?.model || '';
    if (e.entity_id.startsWith('sensor.') && s.attributes.device_class === 'battery' && !isNaN(parseFloat(s.state))
        && !/floodlight|indoor|pan-tilt|wired|elite|\bpro\b/i.test(model)) batteryDevs.add(e.device_id);
    if (e.entity_id.startsWith('camera.') && !e.disabled_by) cameraDevs.add(e.device_id);
  }

  const rows = new Map(), dOf = new Map(), cOf = new Map(), mOf = new Map(), defaults = new Map();
  for (const e of entities) {
    if (e.disabled_by || e.hidden_by) continue;
    const dev = devById.get(e.device_id);
    const areaId = e.area_id || dev?.area_id;
    const domain0 = e.entity_id.split('.')[0];
    // cameras and sensors only when they have an Area (keeps the Salem Center cameras out);
    // lights, switches, locks and garage doors always, so every lamp can go in a scene
    if (!areaId && !['switch', 'light', 'lock', 'cover', 'input_boolean', 'fan', 'climate'].includes(domain0)) continue;
    const s = stateOf.get(e.entity_id); if (!s) continue;
    const domain = e.entity_id.split('.')[0];
    const dc = s.attributes.device_class || '';

    // motion triggers (Ring motion/ding events, camera motion sensors) — used for snapshots
    if (e.device_id && cameraDevs.has(e.device_id) &&
        ((domain === 'event' && ['motion', 'doorbell'].includes(dc)) || (domain === 'binary_sensor' && dc === 'motion')
         // Ring "Last activity" is polled, so it still works when Ring's instant push is broken
         || (domain === 'sensor' && dc === 'timestamp' && /_last_activity$/.test(e.entity_id))))
      mOf.set(e.entity_id, e.device_id);

    if (e.entity_category) continue;              // skip settings / diagnostics
    let kind = null;
    if (['camera', 'switch', 'light', 'lock', 'cover', 'climate'].includes(domain)) kind = domain;
    else if (e.platform === 'ambient_station' && (domain === 'sensor' || domain === 'binary_sensor')) kind = domain;   // every weather reading
    else if (domain === 'input_boolean' || domain === 'fan') kind = 'switch';   // on/off helpers ("Boiler alerts") and fans (Dreo)
    else if (domain === 'sensor' && SENSOR_CLASSES.has(dc)) kind = 'sensor';
    else if (domain === 'binary_sensor' && BINARY_CLASSES.has(dc)) kind = 'binary_sensor';
    if (!kind) continue;

    rows.set(e.entity_id, {
      entity_id: e.entity_id, kind,
      name: s.attributes.friendly_name || e.entity_id,
      device_name: dev ? (dev.name_by_user || dev.name || '') : '',
      ha_area: areaId ? areaName.get(areaId) || '' : '',
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
  // thermostats need supabase/010_thermostat.sql; until it's run, leave them out instead of failing the whole list
  if (hasClimate === null) hasClimate = !/ha_devices_kind_check/.test((await sb.from('ha_devices').insert({ entity_id: 'climate.__probe', kind: 'climate', enabled: false })).error?.message || '');
  if (hasClimate) await sb.from('ha_devices').delete().eq('entity_id', 'climate.__probe');
  else for (const [id, r] of rows) if (r.kind === 'climate') { rows.delete(id); log(`Thermostat ${r.name} skipped — run supabase/010_thermostat.sql in Supabase`); }
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
  // plug-in cameras that were set to "motion only" before 0.2.3 and never had a picture → every 15 min
  const fix = [...rows.values()].filter(r => r.kind === 'camera' && !r.on_battery && !r.snapshot_at && settings.get(r.entity_id)?.snapshot_minutes === 0).map(r => r.entity_id);
  if (fix.length && ok(await sb.from('ha_devices').update({ snapshot_minutes: 15 }).in('entity_id', fix), 'Setting camera schedule')) {
    log(`Plug-in cameras set to a picture every 15 minutes: ${fix.length}`); await loadSettings();
  }
  const n = k => [...rows.values()].filter(r => r.kind === k).length;
  log(`Device list: ${rows.size} items (${n('camera')} cameras, ${n('switch') + n('light')} switches/lights, ` +
      `${n('sensor') + n('binary_sensor')} sensors${n('climate') ? `, ${n('climate')} thermostat` : ''}). Added ${fresh.length}, removed ${gone.length}.`);
}

let hasAlerts = true;
async function loadSettings() {
  let r = hasAlerts ? await sb.from('ha_devices').select('entity_id, enabled, snapshot_minutes, alert_low, alert_high') : null;
  if (!r || r.error) { if (r?.error && /alert_/.test(r.error.message)) hasAlerts = false; r = await sb.from('ha_devices').select('entity_id, enabled, snapshot_minutes'); }
  if (ok(r, 'Reading device settings')) settings = new Map(r.data.map(d => [d.entity_id, d]));
  if (haReady) await syncTempAlerts().catch(e => log("Couldn't save thermostat alerts into Home Assistant:", e.message));
}

// ---------------------------------------------------------------- Thermostat alerts
// Too cold / too hot → phone alert. Saved into Home Assistant as one automation per thermostat.
const ALERT_FILE = process.env.ALERT_FILE || '/data/temp_alerts.json';
const notifyTargets = () => String(opts.alert_notify || 'mobile_app_km_s24_ultra').split(',').map(x => x.trim().replace(/^notify\./, '')).filter(Boolean);
let alertsHash = '';
async function syncTempAlerts() {
  const want = [...catalog.values()].filter(r => r.kind === 'climate' && settings.get(r.entity_id)?.enabled)
    .map(r => ({ r, lo: settings.get(r.entity_id)?.alert_low, hi: settings.get(r.entity_id)?.alert_high }))
    .filter(x => x.lo != null || x.hi != null);
  const hash = JSON.stringify([want.map(x => [x.r.entity_id, x.r.name, x.lo, x.hi]), notifyTargets()]);
  if (hash === alertsHash) return;
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(ALERT_FILE, 'utf8')); } catch {}
  const made = [];
  for (const { r, lo, hi } of want) {
    const aid = `mh_temp_alert_${r.entity_id.split('.')[1]}`, name = r.name.replace(/ thermostat$/i, '') || 'House';
    const triggers = [], choose = [];
    const send = (title, message) => notifyTargets().map(t => ({ action: `notify.${t}`, data: { title, message,
      data: { tag: aid, priority: 'high', ttl: 0, channel: 'Home alerts' } } }));
    const now = `{{ state_attr('${r.entity_id}', 'current_temperature') | round(0) }}°`;
    if (lo != null) {
      triggers.push({ trigger: 'numeric_state', entity_id: r.entity_id, attribute: 'current_temperature', below: Number(lo), for: '00:10:00', id: 'cold' });
      choose.push({ conditions: [{ condition: 'trigger', id: 'cold' }], sequence: send('🥶 House is too cold', `${name} reads ${now} — below your ${lo}° alert. Check the heat.`) });
    }
    if (hi != null) {
      triggers.push({ trigger: 'numeric_state', entity_id: r.entity_id, attribute: 'current_temperature', above: Number(hi), for: '00:10:00', id: 'hot' });
      choose.push({ conditions: [{ condition: 'trigger', id: 'hot' }], sequence: send('🥵 House is too hot', `${name} reads ${now} — above your ${hi}° alert.`) });
    }
    await haConfig('POST', 'automation', aid, { id: aid, alias: `Alert: ${r.name} too cold / too hot`, mode: 'single',
      description: 'Made by the McDonald Home app — change the temperatures in the app (tap the thermostat > Alerts), not here.',
      triggers, conditions: [], actions: [{ choose }] });
    made.push(aid);
  }
  for (const id of prev.filter(x => !made.includes(x))) await haConfig('DELETE', 'automation', id);
  fs.writeFileSync(ALERT_FILE, JSON.stringify(made));
  alertsHash = hash;
  if (want.length) log(`Thermostat alerts saved: ${want.map(x => `${x.r.name} below ${x.lo ?? '–'}° / above ${x.hi ?? '–'}°`).join(', ')} → ${notifyTargets().join(', ')}`);
}

// ---------------------------------------------------------------- State changes → app
const dirty = new Set();
function onHaEvent(ev) {
  if (ev.event_type !== 'state_changed') { if (ev.event_type?.endsWith('_registry_updated')) scheduleCatalog(); return; }
  const { entity_id, new_state, old_state } = ev.data;
  if (!new_state) return;

  if (motionOf.has(entity_id)) {
    const isEvent = entity_id.startsWith('event.') || entity_id.startsWith('sensor.');
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

const firstTried = new Set();
async function snapshotRound() {
  if (!haReady) return;
  for (const row of catalog.values()) {
    if (row.kind !== 'camera') continue;
    const s = settings.get(row.entity_id);
    if (!s?.enabled) continue;
    if (!s.snapshot_minutes) {                 // motion-only cameras still get one starting picture
      if (row.snapshot_at || firstTried.has(row.entity_id)) continue;
      firstTried.add(row.entity_id);
      try { await takeSnapshot(row.entity_id, 'interval'); } catch (e) { log('Snapshot', row.entity_id, 'failed:', e.message); }
      continue;
    }
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
        const maxAge = ['unlock', 'open'].includes(c.action) ? 30e3 : COMMAND_MAX_AGE_MS;   // a late unlock/open is never carried out
        if (Date.now() - Date.parse(c.requested_at) > maxAge) throw new Error('Expired — the house was offline');
        if (c.action.startsWith('scene_')) {
          await runSceneCommand(c);
        } else if (c.action.startsWith('bulk_')) {
          const ids = (c.payload?.entity_ids || []).filter(id => ['switch', 'light'].includes(catalog.get(id)?.kind) && settings.get(id)?.enabled);
          if (!ids.length) throw new Error('Nothing to switch');
          await haCall({ type: 'call_service', domain: 'homeassistant', service: c.action === 'bulk_on' ? 'turn_on' : 'turn_off', target: { entity_id: ids } });
        } else if (!row || !s?.enabled) { throw new Error('Device not available');
        } else if (c.action === 'snapshot') {
          if (row.kind !== 'camera') throw new Error('Not a camera');
          await takeSnapshot(c.entity_id, 'request');
        } else if (c.action === 'open' || c.action === 'close') {
          if (row.kind !== 'cover') throw new Error('Not a garage door');
          await haCall({ type: 'call_service', domain: 'cover', service: c.action === 'open' ? 'open_cover' : 'close_cover', target: { entity_id: c.entity_id } });
        } else if (c.action === 'climate_set') {
          if (row.kind !== 'climate') throw new Error('Not a thermostat');
          const p = c.payload || {}, target = { entity_id: c.entity_id };
          if (p.hvac_mode) await haCall({ type: 'call_service', domain: 'climate', service: 'set_hvac_mode', service_data: { hvac_mode: p.hvac_mode }, target });
          if (p.preset_mode) await haCall({ type: 'call_service', domain: 'climate', service: 'set_preset_mode', service_data: { preset_mode: p.preset_mode }, target });
          const temps = Object.fromEntries(['temperature', 'target_temp_low', 'target_temp_high'].filter(k => p[k] != null).map(k => [k, Number(p[k])]));
          if (Object.keys(temps).length) await haCall({ type: 'call_service', domain: 'climate', service: 'set_temperature', service_data: temps, target });
        } else if (c.action === 'lock' || c.action === 'unlock') {
          if (row.kind !== 'lock') throw new Error('Not a lock');
          await haCall({ type: 'call_service', domain: 'lock', service: c.action, target: { entity_id: c.entity_id } });
        } else {
          if (!['switch', 'light'].includes(row.kind)) throw new Error('Not a switch');
          await haCall({ type: 'call_service', domain: c.entity_id.split('.')[0], service: c.action, target: { entity_id: c.entity_id } });
        }
        log(`Done: ${c.action} ${c.entity_id || scenes.get(c.scene_id)?.name || c.scene_id || (c.payload?.entity_ids || []).length + ' devices'} (asked by ${c.requested_by})`);
        // tell Home Assistant who did what (an automation turns lock/unlock/open/close into a phone alert)
        if (row) haCall({ type: 'fire_event', event_type: 'mcdonald_home_command',
          event_data: { entity_id: c.entity_id, action: c.action, by: c.requested_by, name: row.name } }).catch(() => {});
      } catch (e) { status = 'failed'; result = e.message; log(`Failed: ${c.action} ${c.entity_id} — ${e.message}`); }
      ok(await sb.from('ha_commands').update({ status, result, done_at: new Date().toISOString() }).eq('id', c.id), 'Finishing command');
    }
  } finally { polling = false; }
}

// ---------------------------------------------------------------- Scenes
// Scenes live in the app's database. The bridge runs them when someone taps one, and saves each
// one into Home Assistant as a script (plus an automation for its schedule) so schedules run on
// the Pi even when the internet is down.
let scenes = new Map(), scenesHash = '';
const SYNC_FILE = process.env.SYNC_FILE || '/data/ha_synced.json';
const SEED_FILE = process.env.SEED_FILE || '/data/scenes_seeded';
const short = id => String(id).replace(/-/g, '');
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function sceneSteps(sc, btn, withExtras, by) {
  const known = (sc.items || []).filter(i => catalog.has(i.entity_id));
  const steps = [];
  const on = sc.mode === 'single' ? known.filter(i => (i.target || 'on') === 'on') : btn === 'on' ? known : [];
  const off = sc.mode === 'single' ? known.filter(i => i.target === 'off') : btn === 'off' ? known : [];
  if (on.length) steps.push({ action: 'homeassistant.turn_on', target: { entity_id: on.map(i => i.entity_id) } });
  if (off.length) steps.push({ action: 'homeassistant.turn_off', target: { entity_id: off.map(i => i.entity_id) } });
  const extrasNow = sc.mode === 'single' || btn === sc.extras_with;
  if (withExtras && extrasNow) for (const x of sc.extras || []) {
    if (!catalog.has(x.entity_id)) continue;
    if (x.action === 'lock') steps.push({ action: 'lock.lock', target: { entity_id: x.entity_id } });
    else if (x.action === 'close') steps.push({ action: 'cover.close_cover', target: { entity_id: x.entity_id } });
    else continue;
    steps.push({ event: 'mcdonald_home_command', event_data: { entity_id: x.entity_id, action: x.action, by, name: catalog.get(x.entity_id)?.name || x.entity_id } });
  }
  return steps;
}
async function runSceneCommand(c) {
  const r = await sb.from('ha_scenes').select('*').eq('id', c.scene_id).maybeSingle();
  if (!r.data) throw new Error('That scene no longer exists');
  const sc = r.data, btn = c.action.slice(6);
  const hasDoorSteps = (sc.extras || []).length && (sc.mode === 'single' || btn === sc.extras_with);
  const steps = sceneSteps(sc, btn, c.allow_doors, `${c.requested_by} (scene ${sc.name})`);
  for (const st of steps) {
    if (st.event) await haCall({ type: 'fire_event', event_type: st.event, event_data: st.event_data });
    else { const [domain, service] = st.action.split('.'); await haCall({ type: 'call_service', domain, service, target: st.target }); }
  }
  if (hasDoorSteps && !c.allow_doors) log(`Scene ${sc.name}: door/garage steps skipped (${c.requested_by} isn't allowed to use doors)`);
}

const haConfig = async (method, kind, id, body) => {
  const r = await fetch(`${HA_API}/config/${kind}/config/${id}`, { method, signal: AbortSignal.timeout(20e3),
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok && !(method === 'DELETE' && r.status === 404)) throw new Error(`Home Assistant answered ${r.status} for ${kind} ${id}`);
};
function trigFor(sch) {
  if (sch.kind === 'time' && /^\d{1,2}:\d{2}$/.test(sch.time || '')) return { trigger: 'time', at: `${sch.time.padStart(5, '0')}:00` };
  if (sch.kind === 'sunset' || sch.kind === 'sunrise') {
    const m = Math.round(+sch.offset || 0), a = Math.abs(m);
    return { trigger: 'sun', event: sch.kind, offset: `${m < 0 ? '-' : ''}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}:00` };
  }
  return null;
}
let syncWarned = false;
async function syncScenesToHA() {
  let prev = { scripts: [], automations: [] };
  try { prev = JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8')); } catch {}
  const scripts = [], autos = [];
  for (const sc of scenes.values()) {
    for (const btn of sc.mode === 'single' ? ['run'] : ['on', 'off']) {
      const sid = `mh_scene_${short(sc.id)}_${btn}`;
      const label = sc.mode === 'single' ? sc.name : `${sc.name} ${btn === 'on' ? 'On' : 'Off'}`;
      await haConfig('POST', 'script', sid, { alias: `Scene: ${label}`, icon: 'mdi:lightbulb-group', mode: 'single',
        description: 'Made by the McDonald Home app — edit it in the app, not here.', sequence: sceneSteps(sc, btn, true, `Schedule (scene ${sc.name})`) });
      scripts.push(sid);
      const sch = (sc.schedule || {})[btn], trig = sch && trigFor(sch);
      if (trig) {
        const aid = `mh_sched_${short(sc.id)}_${btn}`;
        const days = Array.isArray(sch.days) ? sch.days : [0, 1, 2, 3, 4, 5, 6];
        await haConfig('POST', 'automation', aid, { id: aid, alias: `Schedule: ${label}`, mode: 'single',
          description: 'Made by the McDonald Home app — edit it in the app, not here.',
          triggers: [trig], conditions: days.length && days.length < 7 ? [{ condition: 'time', weekday: days.map(d => DAYS[d]) }] : [],
          actions: [{ action: 'script.turn_on', target: { entity_id: `script.${sid}` } }] });
        autos.push(aid);
      }
    }
  }
  for (const id of prev.scripts.filter(x => !scripts.includes(x))) await haConfig('DELETE', 'script', id);
  for (const id of prev.automations.filter(x => !autos.includes(x))) await haConfig('DELETE', 'automation', id);
  fs.writeFileSync(SYNC_FILE, JSON.stringify({ scripts, automations: autos }));
  log(`Scenes saved to Home Assistant: ${scenes.size} scenes, ${autos.length} schedules`);
}
async function loadScenes() {
  const r = await sb.from('ha_scenes').select('*').order('sort');
  if (!ok(r, 'Reading scenes')) return;
  scenes = new Map(r.data.map(x => [x.id, x]));
  const hash = JSON.stringify(r.data.map(x => [x.id, x.name, x.mode, x.items, x.extras, x.extras_with, x.schedule])) + catalog.size;
  if (hash === scenesHash || !haReady) return;
  try { await syncScenesToHA(); scenesHash = hash; syncWarned = false; }
  catch (e) { if (!syncWarned) log("Couldn't save scenes into Home Assistant (schedules won't run until this works):", e.message); syncWarned = true; }
}
// First run: rebuild the Kasa app groups as scenes so there's something to start from
async function seedScenes() {
  if (fs.existsSync(SEED_FILE)) return;
  const r = await sb.from('ha_scenes').select('id').limit(1);
  if (!ok(r, 'Checking scenes') ) return;
  if (r.data.length) { fs.writeFileSync(SEED_FILE, 'existing'); return; }
  const sw = [...catalog.values()].filter(d => ['switch', 'light'].includes(d.kind));
  const pick = test => sw.filter(test).map(d => ({ entity_id: d.entity_id }));
  const seeds = [
    { name: 'Outside', icon: 'sun', items: pick(d => /^(yard lights|cigar lights|porch light|porch string)$/i.test(d.name)) },
    { name: 'Lamps', icon: 'lamp', items: pick(d => /lamp/i.test(d.name) && !/man ?cave/i.test(d.name + ' ' + d.ha_area)) },
    { name: 'Man Cave', icon: 'tv', items: pick(d => /man ?cave/i.test(d.name + ' ' + d.ha_area) || /^tp-link_power strip/i.test(d.name)) },
    { name: 'Bedroom', icon: 'bed', items: pick(d => /^(kelly bed|cherie bed|bedroom mirror lamp|bedroom shelf lamp)$/i.test(d.name) || /circulat/i.test(d.name)) },
  ].filter(x => x.items.length).map((x, i) => ({ ...x, mode: 'pair', sort: i + 1 }));
  if (seeds.length && ok(await sb.from('ha_scenes').insert(seeds), 'Creating starter scenes'))
    log(`Starter scenes created from your Kasa groups: ${seeds.map(x => `${x.name} (${x.items.length})`).join(', ')}`);
  fs.writeFileSync(SEED_FILE, new Date().toISOString());
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
    else unit = reading.slice(num[0].length).trim().split(/[\s,]+/)[0] || '';
  }
  const last = monnitDate(m.LastCommunicationDate);
  if (last && Date.now() - Date.parse(last) > 6 * 3600e3) state = 'unavailable';   // silent for 6 h
  const name = String(m.SensorName || `Monnit ${m.SensorID}`).replace(new RegExp(`\\s*[-–]\\s*${m.SensorID}\\s*$`), '').trim();
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
setTimeout(async () => { try { await seedScenes(); await loadScenes(); } catch (e) { log('Scenes:', e.message); } }, 5000);
every(30e3, loadScenes);
if (useMonnit) { monnitRound().catch(e => log('Monnit:', e.message)); every(5 * 60e3, monnitRound); }
else log('Monnit not set up (add the iMonnit API key ID and secret on the Configuration tab to turn it on)');
heartbeat().catch(() => {});
