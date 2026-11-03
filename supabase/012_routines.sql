-- McDonald Home Organizer: routines (checklists that pop up when the Tesla is unplugged / plugged in). Run after 011.
-- Paste into Supabase SQL Editor > New query > Run. If asked, choose "Run and enable RLS".
-- The bridge saves each routine into Home Assistant as an automation, so the phone alert comes even
-- when the internet is slow. Tapping the alert opens the checklist in the app.

create table if not exists public.ha_routines (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(name) between 1 and 60),
  icon           text not null default 'car',
  trigger_entity text,                                   -- e.g. binary_sensor.tesla_wall_connector_vehicle_connected (blank = the Wall Connector)
  trigger_to     text not null default 'off' check (trigger_to in ('on','off')),   -- off = unplugged, on = plugged in
  start_time     time not null default '05:00',
  end_time       time not null default '10:00',
  days           int[] not null default '{0,1,2,3,4,5,6}',  -- 0 = Sunday
  items          jsonb not null default '[]',             -- things to tick off by hand: ["Wallet", "Keys"]
  checks         text[] not null default '{}',            -- automatic checks shown live (boiler, door, garage, lights, thermostat, chickens, weather, charge)
  button         text check (button in ('leave','home')), -- "Leaving now" / "I'm home" button
  garage_nag     boolean not null default false,          -- alert if the garage is still open 5 minutes later
  enabled        boolean not null default true,
  sort           int not null default 0,
  updated_at     timestamptz not null default now()
);

alter table public.ha_routines enable row level security;
drop policy if exists routines_read  on public.ha_routines;
drop policy if exists routines_write on public.ha_routines;
create policy routines_read  on public.ha_routines for select using (public.is_member() or public.is_bridge());
create policy routines_write on public.ha_routines for all using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.ha_routines to authenticated;
revoke all on public.ha_routines from anon;

-- The two starting routines
insert into public.ha_routines (name, icon, trigger_to, start_time, end_time, items, checks, button, garage_nag, sort)
select 'Heading out', 'car', 'off', '05:00', '10:00',
       '["Hearing aids", "Wallet", "Keys", "Items for work", "Put wood in the boiler"]',
       '{boiler,door,garage,lights,thermostat,chickens,weather,charge}', 'leave', true, 0
 where not exists (select 1 from public.ha_routines);
insert into public.ha_routines (name, icon, trigger_to, start_time, end_time, items, checks, button, garage_nag, sort)
select 'Home for the night', 'moon', 'on', '15:00', '23:59',
       '["Put wood in the boiler"]',
       '{boiler,garage,door,thermostat,chickens,weather}', 'home', false, 1
 where (select count(*) from public.ha_routines) = 1;
