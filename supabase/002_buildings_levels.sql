-- Home Organizer — update 2: buildings → rooms → shelves, and shelf levels
-- Run once in Supabase: SQL Editor → New query → paste all of this → Run.
-- Safe to run again. Existing boxes stay where they are.

-- 1. New columns -------------------------------------------------------------
alter table public.locations add column if not exists kind   text not null default 'shelf';
alter table public.locations add column if not exists levels int  not null default 1;
alter table public.boxes     add column if not exists level  int;
alter table public.moves     add column if not exists to_level int;

do $$ begin
  alter table public.locations add constraint locations_kind_chk check (kind in ('building', 'room', 'shelf'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.locations add constraint locations_levels_chk check (levels between 1 and 20);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.boxes add constraint boxes_level_chk check (level is null or level >= 1);
exception when duplicate_object then null; end $$;

-- 2. Move history also records the level ------------------------------------
create or replace function public.touch_box() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := public.my_email();
  if tg_op = 'UPDATE' and (new.location_id is distinct from old.location_id or new.level is distinct from old.level) then
    insert into public.moves(box_id, from_location, to_location, to_level, moved_by)
    values (new.id, old.location_id, new.location_id, new.level, public.my_email());
  end if;
  return new;
end $$;

create or replace function public.log_first_location() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.location_id is not null then
    insert into moves(box_id, from_location, to_location, to_level, moved_by)
    values (new.id, null, new.location_id, new.level, public.my_email());
  end if;
  return new;
end $$;

-- 3. Only admins add, change or remove buildings ----------------------------
drop policy if exists loc_all    on public.locations;
drop policy if exists loc_read   on public.locations;
drop policy if exists loc_insert on public.locations;
drop policy if exists loc_update on public.locations;
drop policy if exists loc_delete on public.locations;
create policy loc_read   on public.locations for select using (public.is_member());
create policy loc_insert on public.locations for insert
  with check (public.is_member() and (kind <> 'building' or public.is_admin()));
create policy loc_update on public.locations for update
  using (public.is_member() and (kind <> 'building' or public.is_admin()))
  with check (public.is_member() and (kind <> 'building' or public.is_admin()));
create policy loc_delete on public.locations for delete
  using (public.is_member() and (kind <> 'building' or public.is_admin()));

-- 4. The building list, and sorting out places made before this update -----
do $$
declare b record; found uuid; c text; house uuid; shop uuid;
begin
  if exists (select 1 from public.locations where kind = 'building') then return; end if;  -- already done

  for b in select * from (values
      ('House', 'HSE'), ('Shop', 'SHOP'), ('Barn', 'BARN'), ('Container', 'CONT'),
      ('Chem Shed', 'CHEM'), ('Pig Shed', 'PIG'), ('Gun Shed', 'GUN'), ('Tree House', 'TREE')) v(name, code)
  loop
    select id into found from public.locations where parent_id is null and lower(name) = lower(b.name) limit 1;
    if found is not null then
      update public.locations set kind = 'building' where id = found;
    else
      c := b.code;
      while exists (select 1 from public.locations where code = c) or exists (select 1 from public.boxes where code = c) loop
        c := c || 'X';
      end loop;
      insert into public.locations (name, code, kind) values (b.name, c, 'building');
    end if;
  end loop;

  select id into house from public.locations where kind = 'building' and lower(name) = 'house' limit 1;
  select id into shop  from public.locations where kind = 'building' and lower(name) = 'shop'  limit 1;

  -- Rooms that were made as top-level places move inside their building
  update public.locations set kind = 'room', parent_id = house
   where parent_id is null and kind <> 'building' and lower(name) in ('garage', 'basement', 'office', 'craft room');
  update public.locations set kind = 'room', parent_id = shop
   where parent_id is null and kind <> 'building' and lower(name) in ('loft', 'shop floor', 'main floor');

  -- Anything else at the top becomes a building; everything inside stays a shelf
  update public.locations set kind = 'building' where parent_id is null and kind <> 'building';
end $$;
