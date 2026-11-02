-- McDonald Home Organizer: Ring live view (run after 001-008).
-- Paste into Supabase SQL Editor > New query > Run. If asked, choose "Run and enable RLS".
-- Ring sign-in tokens live in the "private" schema, which the app and the public API can't reach.
-- Only the "ring" Edge Function (running on the server) reads them.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.ring_accounts (
  id             uuid primary key default gen_random_uuid(),
  account_ids    text[] not null default '{}',     -- Ring account id(s) read from /v1/users/me
  access_token   text not null,
  refresh_token  text not null,
  expires_at     timestamptz not null,
  status         text not null default 'unclaimed' check (status in ('unclaimed','linked','removed')),
  linked_by      text,                             -- email of the admin who finished connecting
  linked_at      timestamptz,
  created_at     timestamptz not null default now()
);
revoke all on private.ring_accounts from public, anon, authenticated;

-- Which linked account each camera belongs to (filled in when the camera list is loaded).
create table if not exists private.ring_devices (
  device_id   text primary key,
  account_row uuid not null references private.ring_accounts(id) on delete cascade,
  name        text not null default '',
  updated_at  timestamptz not null default now()
);
revoke all on private.ring_devices from public, anon, authenticated;
