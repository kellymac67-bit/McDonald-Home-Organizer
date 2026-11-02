-- Home Organizer — update 5: link Home Assistant areas to buildings/rooms, device brand
-- Run once in Supabase: SQL Editor → New query → paste all of this → Run. Safe to run again.

-- Which integration a device comes from (ring, tplink, tapo_control, monnit…) — used for "Open Ring"
alter table public.ha_devices add column if not exists platform text not null default '';

-- An HA area (e.g. "Living Room") linked to a building or room in the app.
-- Every device in that area — including ones added later — goes there.
create table if not exists public.ha_area_links (
  ha_area      text primary key,
  location_id  uuid not null references public.locations(id) on delete cascade
);

create or replace function public.ha_device_defaults() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if new.location_id is null and coalesce(new.ha_area, '') <> '' then
    select location_id into new.location_id from ha_area_links where lower(ha_area) = lower(new.ha_area);
  end if;
  if new.location_id is null and coalesce(new.ha_area, '') <> '' then
    select id into new.location_id from locations
     where kind in ('building','room')
       and regexp_replace(lower(name), '[^a-z0-9]', '', 'g') = regexp_replace(lower(new.ha_area), '[^a-z0-9]', '', 'g')
     order by (kind = 'building') desc limit 1;
  end if;
  return new;
end $$;

alter table public.ha_area_links enable row level security;
drop policy if exists area_links_read  on public.ha_area_links;
drop policy if exists area_links_admin on public.ha_area_links;
create policy area_links_read  on public.ha_area_links for select using (public.is_member() or public.is_bridge());
create policy area_links_admin on public.ha_area_links for all using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.ha_area_links to authenticated;
revoke all on public.ha_area_links from anon;

-- Chicken Coop building, and the rooms from the Monnit list (Basement, Garage, Man Cave under House)
do $$
declare house uuid; coop uuid; c text; r record;
begin
  select id into coop from public.locations where kind = 'building' and lower(name) = 'chicken coop' limit 1;
  if coop is null then
    c := 'COOP';
    while exists (select 1 from public.locations where code = c) or exists (select 1 from public.boxes where code = c) loop c := c || 'X'; end loop;
    insert into public.locations (name, code, kind) values ('Chicken Coop', c, 'building') returning id into coop;
  end if;
  insert into public.ha_area_links (ha_area, location_id) values ('Chickens', coop) on conflict (ha_area) do nothing;

  select id into house from public.locations where kind = 'building' and lower(name) = 'house' limit 1;
  if house is not null then
    for r in select * from (values ('Basement', 'HSE-BAS'), ('Garage', 'HSE-GAR'), ('Man Cave', 'HSE-MAN')) v(name, code) loop
      if not exists (select 1 from public.locations where parent_id = house and regexp_replace(lower(name), '[^a-z0-9]', '', 'g') = regexp_replace(lower(r.name), '[^a-z0-9]', '', 'g')) then
        c := r.code;
        while exists (select 1 from public.locations where code = c) or exists (select 1 from public.boxes where code = c) loop c := c || 'X'; end loop;
        insert into public.locations (name, code, kind, parent_id) values (r.name, c, 'room', house);
      end if;
    end loop;
  end if;

  -- link devices that are already in the app to their new places
  update public.ha_devices set location_id = null where location_id is null;  -- re-runs the matching trigger
end $$;
