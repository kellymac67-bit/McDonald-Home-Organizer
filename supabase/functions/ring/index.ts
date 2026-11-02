// McDonald Home: Ring live view (Supabase Edge Function "ring") — adapted from the Salem Center Staff app.
// Deploy: home Supabase project > Edge Functions > Deploy a new function > Via Editor > name it "ring" > paste > Deploy,
// then turn OFF "Verify JWT" (Ring's servers call /ring/token and /ring/webhook without a Supabase sign-in).
//
// Secrets (Edge Functions > Secrets), from the Ring developer console app "McDonald Home Cameras":
//   RING_CLIENT_ID, RING_CLIENT_SECRET, RING_HMAC_KEY
//
// Addresses to give Ring:
//   Token Exchange URL  https://linamgjcynivkfkvghhk.supabase.co/functions/v1/ring/token
//   Webhook URL         https://linamgjcynivkfkvghhk.supabase.co/functions/v1/ring/webhook
//   Account Link URL    https://mcdonald-home-organizer.netlify.app/ring-link.html
//
// Only HOME cameras are reachable: a Ring camera must match (by name) a camera the Home Assistant
// bridge put in the app (ha_devices, enabled). The Salem Center cameras on the same Ring account can't be opened.
// App actions (POST JSON with the signed-in member's token): status, link, claim (admins), devices, whep, whep_stop.

import postgres from "npm:postgres@3.4.5";
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const ALLOWED_ORIGINS = ["https://mcdonald-home-organizer.netlify.app"];
const RING_API = Deno.env.get("RING_API_BASE") || "https://api.amazonvision.com";
const RING_OAUTH = Deno.env.get("RING_OAUTH_URL") || "https://oauth.ring.com/oauth/token";
const CLIENT_ID = Deno.env.get("RING_CLIENT_ID") || "";
const CLIENT_SECRET = Deno.env.get("RING_CLIENT_SECRET") || "";
const HMAC_KEY = Deno.env.get("RING_HMAC_KEY") || "";
const WEBHOOK_KEY = Deno.env.get("RING_WEBHOOK_KEY") || HMAC_KEY;
const LINK_WINDOW_S = 600;               // Ring: reject account-link redirects older than 10 minutes

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3, idle_timeout: 20 });

function publishableKey(): string {
  try { const k = JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}"); if (k.default) return k.default; } catch (_) { /* fall through */ }
  return Deno.env.get("SUPABASE_ANON_KEY") || "";
}
const auth = createClient(Deno.env.get("SUPABASE_URL")!, publishableKey(), { auth: { persistSession: false } });

function cors(origin: string | null) {
  const allow = origin && (ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) ? origin : ALLOWED_ORIGINS[0];
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
           "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin" };
}
const json = (body: unknown, status: number, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...h, "Content-Type": "application/json" } });

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

// ---------------------------------------------------------------- crypto helpers
const enc = new TextEncoder();
async function hmac(key: string, data: Uint8Array | string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, typeof data === "string" ? enc.encode(data) : data));
}
const b64urlNoPad = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function linkNonce(time: string, accountId: string, key = HMAC_KEY) {
  return b64urlNoPad(await hmac(key, `${time}:${accountId}`));
}
export async function webhookSignature(raw: Uint8Array, key = WEBHOOK_KEY) {
  return "sha256=" + hex(await hmac(key, raw));
}

// ---------------------------------------------------------------- Ring tokens
type Account = { id: string; access_token: string; refresh_token: string; expires_at: Date };

async function oauth(form: Record<string, string>) {
  const r = await fetch(RING_OAUTH, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...form, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }) });
  const t = await r.text();
  if (!r.ok) { console.error("ring oauth", r.status, t.slice(0, 300)); throw new HttpError(502, "Ring sign-in failed (" + r.status + ")"); }
  const j = JSON.parse(t);
  if (!j.access_token) throw new HttpError(502, "Ring sign-in returned no token");
  return j as { access_token: string; refresh_token?: string; expires_in?: number };
}

// Fresh access token for one linked account; refresh tokens rotate, so the new one is saved under a row lock.
async function tokenFor(rowId: string): Promise<string> {
  return await sql.begin(async (tx) => {
    const [a] = await tx<Account[]>`select id, access_token, refresh_token, expires_at from private.ring_accounts where id = ${rowId} for update`;
    if (!a) throw new HttpError(404, "Ring account not linked");
    if (new Date(a.expires_at).getTime() - Date.now() > 120_000) return a.access_token;
    const t = await oauth({ grant_type: "refresh_token", refresh_token: a.refresh_token });
    await tx`update private.ring_accounts set access_token = ${t.access_token}, refresh_token = ${t.refresh_token || a.refresh_token},
               expires_at = now() + make_interval(secs => ${t.expires_in || 3600}) where id = ${a.id}`;
    return t.access_token;
  });
}

async function ring(token: string, path: string, init: RequestInit = {}) {
  return await fetch(path.startsWith("http") ? path : RING_API + path,
    { ...init, redirect: "manual", headers: { Accept: "application/json", ...(init.headers || {}), Authorization: "Bearer " + token } });
}
async function ringJson(token: string, path: string, init: RequestInit = {}) {
  const r = await ring(token, path, init);
  const t = await r.text();
  if (!r.ok) { console.error("ring api", path.split("?")[0], r.status, t.slice(0, 300)); throw new HttpError(r.status === 401 ? 502 : r.status, ringError(r.status, t)); }
  return t ? JSON.parse(t) : {};
}
function ringError(status: number, body: string) {
  try { const j = JSON.parse(body); const e = (j.errors || [])[0] || {}; return `Ring ${status}: ${e.detail || e.title || j.message || "error"}`; }
  catch (_) { return `Ring ${status}`; }
}

// Every way /v1/users/me might carry the account id; the link nonce is checked against each.
export function accountIdsFrom(me: Record<string, any>): string[] {
  const d = me?.data || {}, a = d.attributes || {};
  return [...new Set([d.id, a.account_id, a.id, me?.account_id, me?.id].filter((x) => typeof x === "string" && x))];
}

// ---------------------------------------------------------------- Ring -> us: token exchange
async function readCode(req: Request): Promise<string> {
  const url = new URL(req.url);
  let fields: Record<string, unknown> = Object.fromEntries(url.searchParams);
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  const raw = req.method === "POST" ? await req.text() : "";
  if (raw) {
    if (ct.includes("json") || raw.trim().startsWith("{")) { try { fields = { ...fields, ...JSON.parse(raw) }; } catch (_) { /* not JSON */ } }
    else fields = { ...fields, ...Object.fromEntries(new URLSearchParams(raw)) };
  }
  // Ring's request format isn't published; log only the field names so it can be checked in the function logs.
  console.log("ring token exchange", req.method, ct || "(no content-type)", "fields:", Object.keys(fields).join(","));
  const code = fields.code ?? fields.authorization_code ?? fields.auth_code ?? (fields.data as any)?.code;
  return typeof code === "string" ? code : "";
}
async function tokenExchange(req: Request) {
  const code = await readCode(req);
  if (!code) return json({ error: "missing code" }, 400);
  const t = await oauth({ grant_type: "authorization_code", code });
  const me = await ringJson(t.access_token, "/v1/users/me");
  const ids = accountIdsFrom(me);
  await sql`insert into private.ring_accounts (account_ids, access_token, refresh_token, expires_at)
            values (${ids}, ${t.access_token}, ${t.refresh_token || ""}, now() + make_interval(secs => ${t.expires_in || 3600}))`;
  await sql`delete from private.ring_accounts where status = 'unclaimed' and created_at < now() - interval '1 day'`;
  return json({ status: "ok" }, 200);
}

// ---------------------------------------------------------------- Ring -> us: webhook
async function webhook(req: Request) {
  const raw = new Uint8Array(await req.arrayBuffer());
  const got = (req.headers.get("x-signature") || "").trim();
  const want = await webhookSignature(raw);
  if (!WEBHOOK_KEY || !safeEqual(want, got.startsWith("sha256=") ? got : "sha256=" + got)) return json({ error: "bad signature" }, 401);
  let p: any; try { p = JSON.parse(new TextDecoder().decode(raw)); } catch (_) { return json({ error: "bad body" }, 400); }
  const meta = p?.meta || {}, d = p?.data || {}, a = d.attributes || {};
  const type = String(d.type || "unknown");
  const deviceId = a.source_type === "devices" || !a.source_type ? (a.source || null) : null;
  const ts = Number(a.timestamp);
  const at = Number.isFinite(ts) && ts > 0 ? new Date(ts > 1e12 ? ts : ts * 1000) : new Date();
  if (type === "app_integration_removed" && meta.account_id) {
    await sql`update private.ring_accounts set status = 'removed' where ${String(meta.account_id)} = any(account_ids)`;
  }
  return json({ status: "ok" }, 200);
}

// ---------------------------------------------------------------- app actions
function maskEmail(e: string) {
  const [u, d] = (e || "").split("@"); if (!d) return "McDonald Home";
  return (u.length <= 2 ? u[0] + "***" : u[0] + "***" + u[u.length - 1]) + "@" + d;
}

async function linkAccount(me: any, email: string, nonce: string, time: string) {
  if (!HMAC_KEY) throw new HttpError(500, "RING_HMAC_KEY is not set");
  if (!nonce || !/^\d+$/.test(time || "")) throw new HttpError(400, "This link is incomplete. Start again from the Ring app.");
  const t = Number(time), secs = t > 1e12 ? t / 1000 : t;
  if (Math.abs(Date.now() / 1000 - secs) > LINK_WINDOW_S) throw new HttpError(400, "This link has expired. Start again from the Ring app.");
  const rows = await sql`select id, account_ids from private.ring_accounts where status = 'unclaimed' and created_at > now() - interval '30 minutes' order by created_at desc`;
  let match: { id: string } | null = null;
  for (const r of rows) for (const acct of r.account_ids as string[]) if (safeEqual(await linkNonce(time, acct), nonce)) { match = r as any; break; }
  if (!match) throw new HttpError(409, "Ring hasn't finished handing over the connection yet.");
  const token = await tokenFor(match.id);
  await ringJson(token, "/v1/accounts/me/app-integrations", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account_identifier: maskEmail(email), nonce }) });
  await ringJson(token, "/v1/accounts/me/app-integrations", { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "completed" }) });
  await sql`update private.ring_accounts set status = 'linked', linked_by = ${me.email}, linked_at = now() where id = ${match.id}`;
  return { linked: true };
}

async function claimLatest(me: any, email: string) {
  const [row] = await sql`select id from private.ring_accounts where status = 'unclaimed' and created_at > now() - interval '1 day' order by created_at desc limit 1`;
  if (!row) throw new HttpError(404, "Nothing from Ring to finish yet. Connect the Ring account in the Ring developer console first.");
  const token = await tokenFor(row.id);
  try {
    await ringJson(token, "/v1/accounts/me/app-integrations", { method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", account_identifier: maskEmail(email) }) });
  } catch (e) { console.log("app-integrations confirm skipped:", (e as Error).message); }
  await sql`update private.ring_accounts set status = 'linked', linked_by = ${me.email}, linked_at = now() where id = ${row.id}`;
  return { linked: true };
}

// "Chickens Live view" (Home Assistant entity) and "Chickens" (Ring) are the same camera.
const camKey = (t: string) => String(t || "").trim().toLowerCase().replace(/\s+(live view|live|snapshot|camera)$/, "").trim();

// Names of the home cameras in the app (from Home Assistant). Only these Ring cameras are ever listed or streamed.
async function homeCameraNames(): Promise<Set<string>> {
  const rows = await sql`select lower(trim(device_name)) as a, lower(trim(name)) as b from public.ha_devices
                          where kind = 'camera' and enabled and platform = 'ring'`;
  return new Set(rows.flatMap((r: any) => [r.a, r.b]).filter(Boolean).map(camKey));
}

async function devices() {
  const home = await homeCameraNames();
  const accts = await sql`select id from private.ring_accounts where status = 'linked' order by linked_at`;
  const out: any[] = []; const errors: string[] = [];
  for (const a of accts) {
    try {
      const doc = await ringJson(await tokenFor(a.id), "/v1/devices?include=status");
      const inc = new Map<string, any>((doc.included || []).map((x: any) => [x.type + "|" + x.id, x]));
      for (const d of doc.data || []) {
        const at = d.attributes || {}, rel = d.relationships?.status?.data;
        const st = rel ? inc.get(rel.type + "|" + rel.id)?.attributes : at.status;
        const name = at.name || at.description || "Camera";
        if (!home.has(camKey(name))) continue;      // not a home camera (e.g. Salem Center)
        out.push({ id: d.id, name, kind: at.kind || at.device_type || "", image: at.image_url || "", online: st?.online ?? null,
                   components: (at.components || []).map((c: any) => c.id || c.component_id).filter(Boolean) });
        await sql`insert into private.ring_devices (device_id, account_row, name) values (${d.id}, ${a.id}, ${name})
                  on conflict (device_id) do update set account_row = excluded.account_row, name = excluded.name, updated_at = now()`;
      }
    } catch (e) { errors.push((e as Error).message); }
  }
  out.sort((x, y) => x.name.localeCompare(y.name));
  return { devices: out, errors };
}

async function tokenForDevice(deviceId: string) {
  if (!deviceId || typeof deviceId !== "string") throw new HttpError(400, "Pick a camera");
  let [row] = await sql`select d.account_row from private.ring_devices d join private.ring_accounts a on a.id = d.account_row
                        where d.device_id = ${deviceId} and a.status = 'linked'`;
  if (!row) { await devices(); [row] = await sql`select account_row from private.ring_devices where device_id = ${deviceId}`; }
  if (!row) throw new HttpError(404, "Camera not found");
  const [d] = await sql`select name from private.ring_devices where device_id = ${deviceId}`;
  if (!d || !(await homeCameraNames()).has(camKey(d.name))) throw new HttpError(403, "That camera isn't one of your home cameras");
  return await tokenFor(row.account_row);
}

async function whepStart(deviceId: string, sdp: string, componentId?: string) {
  if (typeof sdp !== "string" || !sdp.trimStart().startsWith("v=") || sdp.length > 20000) throw new HttpError(400, "Bad video offer");
  const token = await tokenForDevice(deviceId);
  const q = componentId ? "?component_id=" + encodeURIComponent(componentId) : "";
  const r = await ring(token, `/v1/devices/${encodeURIComponent(deviceId)}/media/streaming/whep/sessions${q}`,
    { method: "POST", headers: { "Content-Type": "application/sdp", Accept: "application/sdp" }, body: sdp });
  const t = await r.text();
  if (r.status !== 200 && r.status !== 201) { console.error("whep", r.status, t.slice(0, 300)); throw new HttpError(502, ringError(r.status, t)); }
  let loc = r.headers.get("Location") || ""; if (loc.startsWith("/")) loc = RING_API + loc;
  return { answer: t, session: loc };
}
async function whepStop(deviceId: string, session: string) {
  if (!session) return { stopped: false };
  const u = new URL(session);
  if (u.origin !== new URL(RING_API).origin || !u.pathname.includes("/whep/sessions/")) throw new HttpError(400, "Not a Ring session");
  const r = await ring(await tokenForDevice(deviceId), u.toString(), { method: "DELETE" });
  return { stopped: r.ok || r.status === 404 };
}

// ---------------------------------------------------------------- router
Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  try {
    if (path.endsWith("/ring/token")) return await tokenExchange(req);
    if (path.endsWith("/ring/webhook")) return await webhook(req);
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof HttpError ? e.message : "Server error" }, e instanceof HttpError ? e.status : 500);
  }

  const h = cors(req.headers.get("Origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers: h });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405, h);
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Sign in required" }, 401, h);
    const { data: u, error: ue } = await auth.auth.getUser(token);
    if (ue || !u?.user) return json({ error: "Sign in required" }, 401, h);
    const email = String(u.user.email || "").toLowerCase();
    const [me] = await sql`select email, is_admin, see_cameras from public.members where email = ${email}`;
    if (!me) return json({ error: "Not on the family list" }, 403, h);
    if (!me.is_admin && !me.see_cameras) return json({ error: "Ask an admin to turn on Can see cameras for you" }, 403, h);
    const isAdmin = !!me.is_admin;

    const b = await req.json().catch(() => ({}));
    switch (b.action) {
      case "status": {
        const [c] = await sql`select count(*) filter (where status = 'linked')::int as linked,
                                     count(*) filter (where status = 'unclaimed' and created_at > now() - interval '1 day')::int as waiting
                                from private.ring_accounts`;
        return json({ configured: !!(CLIENT_ID && CLIENT_SECRET && HMAC_KEY), linked: c.linked, waiting: c.waiting }, 200, h);
      }
      case "link":
        if (!isAdmin) return json({ error: "Only an admin can connect Ring" }, 403, h);
        return json(await linkAccount(me, u.user.email || "", String(b.nonce || ""), String(b.time || "")), 200, h);
      case "claim":
        // Finish a connection whose return trip to the app didn't complete (approved in Ring, app not signed in, etc.).
        // Tokens only reach us when someone approves this private app in Ring, so a manager may claim the newest one.
        if (!isAdmin) return json({ error: "Only an admin can connect Ring" }, 403, h);
        return json(await claimLatest(me, u.user.email || ""), 200, h);
      case "devices": return json(await devices(), 200, h);
      case "whep": return json(await whepStart(String(b.device_id || ""), b.sdp, b.component_id ? String(b.component_id) : undefined), 200, h);
      case "whep_stop": return json(await whepStop(String(b.device_id || ""), String(b.session || "")), 200, h);
    }
    return json({ error: "Unknown action" }, 400, h);
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof HttpError ? e.message : "Server error" }, e instanceof HttpError ? e.status : 500, h);
  }
});
