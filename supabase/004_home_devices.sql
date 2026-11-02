-- Home Organizer — update 4: cameras, switches and sensors from Home Assistant
-- Run once in Supabase: SQL Editor → New query → paste all of this → Run.
-- Safe to run again.
--
-- How it works: the "McDonald Home Bridge" add-on on the Raspberry Pi signs in as a
-- special bridge account, sends device states and camera snapshots up to these tables,
-- and picks up commands (switch on/off, take a snapshot). Nothing at home is opened to
-- the internet. Only devices that have an Area in Home Assistant are ever sent.

-- ============================================================
-- 1. Who can see cameras / use switches
-- ============================================================
alter table public.members add column if not exists see_cameras boolean not null default false;
alter table public.members add column if not exists can_control boolean not null default false;

-- The bridge account (a Supabase user that is NOT a family member and can't see boxes)
create table if not exists public.bridge_accounts (
  email text primary key check (email = lower(email))
);
insert into public.bridge_accounts(email) values ('ha-bridge@mcdonald-home.app')
on conflict do nothing;

create or replace function public.is_bridge() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from bridge_accounts where email = public.my_email())
$$;

create or replace function public.can_see_cameras() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where email = public.my_email() and (is_admin or see_cameras))
$$;

create or replace function public.can_control() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where email = public.my_email() and (is_admin or can_control))
$$;

-- ============================================================
-- 2. Tables
-- ============================================================

-- One row per Home Assistant entity the bridge reports (camera, switch, light, sensor, …)
create table if not exists public.ha_devices (
  entity_id        text primary key,
  kind             text not null check (kind in ('camera','switch','light','sensor','binary_sensor','lock','cover')),
  name             text not null default '',          -- name from Home Assistant
  display_name     text not null default '',          -- optional name set in the app
  device_name      text not null default '',
  ha_area          text not null default '',          -- Area in Home Assistant
  device_class     text not null default '',
  unit             text not null default '',
  on_battery       boolean not null default false,
  location_id      uuid references public.locations(id) on delete set null,  -- building/room in the app
  enabled          boolean not null default true,     -- shown in the app (admin can hide)
  snapshot_minutes int not null default 15 check (snapshot_minutes between 0 and 1440),  -- cameras; 0 = only on motion / on request
  state            text not null default '',
  attributes       jsonb not null default '{}',
  last_changed     timestamptz,
  last_motion      timestamptz,
  snapshot_path    text,
  snapshot_at      timestamptz,
  sort             int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists ha_devices_loc_idx on public.ha_devices(location_id);

-- Motion / requested snapshots (kept a few days; the bridge cleans up)
create table if not exists public.ha_snapshots (
  id         bigint generated always as identity primary key,
  entity_id  text not null references public.ha_devices(entity_id) on delete cascade,
  path       text not null,
  reason     text not null default 'motion' check (reason in ('motion','request','interval')),
  taken_at   timestamptz not null default now()
);
create index if not exists ha_snapshots_ent_idx on public.ha_snapshots(entity_id, taken_at desc);

-- Commands from the app to the house
create table if not exists public.ha_commands (
  id            bigint generated always as identity primary key,
  entity_id     text not null references public.ha_devices(entity_id) on delete cascade,
  action        text not null check (action in ('turn_on','turn_off','toggle','snapshot')),
  requested_by  text not null default public.my_email(),
  requested_at  timestamptz not null default now(),
  status        text not null default 'pending' check (status in ('pending','done','failed')),
  result        text not null default '',
  done_at       timestamptz
);
create index if not exists ha_commands_pending_idx on public.ha_commands(status, id);

-- Bridge heartbeat (one row)
create table if not exists public.ha_bridge_status (
  id          int primary key default 1 check (id = 1),
  last_seen   timestamptz,
  version     text not null default '',
  ha_version  text not null default '',
  message     text not null default ''
);

-- ============================================================
-- 3. Automatic matching: HA Area "Barn" → the Barn building in the app
-- ============================================================
create or replace function public.ha_device_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if new.location_id is null and coalesce(new.ha_area, '') <> '' then
    select id into new.location_id from locations
     where kind in ('building','room') and lower(name) = lower(new.ha_area)
     order by (kind = 'building') desc limit 1;
  end if;
  return new;
end $$;

drop trigger if exists ha_devices_defaults on public.ha_devices;
create trigger ha_devices_defaults before insert or update on public.ha_devices
  for each row execute function public.ha_device_defaults();

-- Commands: only for devices that are shown, and only the right kind of action
create or replace function public.ha_command_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  select kind, enabled into d from ha_devices where entity_id = new.entity_id;
  if d is null or not d.enabled then raise exception 'That device is not available'; end if;
  if new.action = 'snapshot' then
    if d.kind <> 'camera' then raise exception 'Only cameras take snapshots'; end if;
  elsif d.kind not in ('switch','light') then
    raise exception 'That device can''t be switched from the app';
  end if;
  new.requested_by := public.my_email();
  new.requested_at := now();
  new.status := 'pending';
  return new;
end $$;

drop trigger if exists ha_commands_check on public.ha_commands;
create trigger ha_commands_check before insert on public.ha_commands
  for each row execute function public.ha_command_check();

-- ============================================================
-- 4. Access rules
-- ============================================================
alter table public.bridge_accounts  enable row level security;
alter table public.ha_devices       enable row level security;
alter table public.ha_snapshots     enable row level security;
alter table public.ha_commands      enable row level security;
alter table public.ha_bridge_status enable row level security;

do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('bridge_accounts','ha_devices','ha_snapshots','ha_commands','ha_bridge_status')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- bridge_accounts: admins only
create policy bridge_acct_admin on public.bridge_accounts for all
  using (public.is_admin()) with check (public.is_admin());

-- devices: family sees shown devices (cameras only if allowed); admins see all; bridge reads/writes
create policy dev_read on public.ha_devices for select using (
  public.is_bridge() or public.is_admin()
  or (public.is_member() and enabled and (kind <> 'camera' or public.can_see_cameras())));
create policy dev_bridge_ins on public.ha_devices for insert with check (public.is_bridge());
create policy dev_update on public.ha_devices for update
  using (public.is_bridge() or public.is_admin()) with check (public.is_bridge() or public.is_admin());
create policy dev_delete on public.ha_devices for delete using (public.is_bridge() or public.is_admin());

-- snapshots: camera viewers read; bridge writes
create policy snap_read on public.ha_snapshots for select using (public.is_bridge() or public.can_see_cameras());
create policy snap_bridge on public.ha_snapshots for all
  using (public.is_bridge()) with check (public.is_bridge());

-- commands: switching needs "can control"; snapshots need "see cameras"; bridge reads and completes them
create policy cmd_insert on public.ha_commands for insert with check (
  case when action = 'snapshot' then public.can_see_cameras() else public.can_control() end);
create policy cmd_read on public.ha_commands for select using (
  public.is_bridge() or public.is_admin() or requested_by = public.my_email());
create policy cmd_bridge_update on public.ha_commands for update
  using (public.is_bridge()) with check (public.is_bridge());

-- bridge status: family can see whether the house is connected
create policy status_read on public.ha_bridge_status for select using (public.is_member() or public.is_bridge());
create policy status_bridge on public.ha_bridge_status for all
  using (public.is_bridge()) with check (public.is_bridge());

grant select, insert, update, delete on public.ha_devices, public.ha_snapshots, public.ha_bridge_status,
  public.bridge_accounts to authenticated;
grant select, insert, update on public.ha_commands to authenticated;
revoke all on public.bridge_accounts, public.ha_devices, public.ha_snapshots, public.ha_commands,
  public.ha_bridge_status from anon;
grant execute on function public.is_bridge(), public.can_see_cameras(), public.can_control() to authenticated;

-- ============================================================
-- 5. Camera snapshot storage (private bucket: camera viewers read, bridge writes)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('cams', 'cams', false)
on conflict (id) do nothing;

drop policy if exists "cams read"   on storage.objects;
drop policy if exists "cams add"    on storage.objects;
drop policy if exists "cams change" on storage.objects;
drop policy if exists "cams delete" on storage.objects;

create policy "cams read" on storage.objects for select to authenticated
  using (bucket_id = 'cams' and (public.can_see_cameras() or public.is_bridge()));
create policy "cams add" on storage.objects for insert to authenticated
  with check (bucket_id = 'cams' and public.is_bridge());
create policy "cams change" on storage.objects for update to authenticated
  using (bucket_id = 'cams' and public.is_bridge()) with check (bucket_id = 'cams' and public.is_bridge());
create policy "cams delete" on storage.objects for delete to authenticated
  using (bucket_id = 'cams' and public.is_bridge());

-- Existing admins can already see cameras and use switches; nothing else changes for the family.
