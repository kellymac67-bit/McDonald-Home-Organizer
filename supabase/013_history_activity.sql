-- McDonald Home Organizer: history charts and the activity log. Run after 012.
-- Paste into Supabase SQL Editor > New query > Run. If asked, choose "Run and enable RLS".

-- 1. Readings: every 10 minutes the bridge saves each temperature / humidity / weather reading.
--    Kept 90 days (about 60 MB for ~60 sensors).
create table if not exists public.ha_readings (
  entity_id text not null,
  at        timestamptz not null,
  value     real not null,
  primary key (entity_id, at)
);
alter table public.ha_readings enable row level security;
drop policy if exists readings_read   on public.ha_readings;
drop policy if exists readings_bridge on public.ha_readings;
create policy readings_read   on public.ha_readings for select using (public.is_member() or public.is_bridge());
create policy readings_bridge on public.ha_readings for all using (public.is_bridge()) with check (public.is_bridge());
grant select, insert, delete on public.ha_readings to authenticated;
revoke all on public.ha_readings from anon;

-- Chart data, averaged into buckets so a month is still a few hundred points
create or replace function public.ha_series(p_entity text, p_since timestamptz, p_bucket_minutes int default 10)
returns table (t timestamptz, avg real, lo real, hi real)
language sql stable security invoker set search_path = public as $$
  select date_bin(make_interval(mins => greatest(p_bucket_minutes, 10)), at, timestamptz '2000-01-01') as t,
         avg(value)::real, min(value), max(value)
    from ha_readings
   where entity_id = p_entity and at >= p_since
   group by 1 order by 1
   limit 2000
$$;
grant execute on function public.ha_series(text, timestamptz, int) to authenticated;

-- 2. Activity: who did what, and when. Doors, garage, lights, thermostat, scenes, alarms.
create table if not exists public.ha_activity (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  entity_id text,
  name      text not null default '',
  kind      text not null default '',        -- lock, cover, light, switch, climate, scene, binary_sensor
  event     text not null,                   -- "Unlocked", "Turned on", "Set to 70°"
  by_who    text not null default ''         -- a person's email, "Schedule: Outside On", "Keypad / by hand"
);
create index if not exists ha_activity_recent on public.ha_activity (at desc);
create index if not exists ha_activity_entity on public.ha_activity (entity_id, at desc);
alter table public.ha_activity enable row level security;
drop policy if exists activity_read   on public.ha_activity;
drop policy if exists activity_bridge on public.ha_activity;
create policy activity_read   on public.ha_activity for select using (public.is_member() or public.is_bridge());
create policy activity_bridge on public.ha_activity for all using (public.is_bridge()) with check (public.is_bridge());
grant select, insert, delete on public.ha_activity to authenticated;
revoke all on public.ha_activity from anon;
