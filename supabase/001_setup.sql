-- Home Organizer — database setup (then also run 002_buildings_levels.sql and 003_subcategories.sql)
-- Run once in Supabase: SQL Editor → New query → paste all of this → Run.
-- Safe to run again (it skips anything that already exists).

-- ============================================================
-- 1. Tables
-- ============================================================

-- Family members allowed to use the app (matched by sign-in email)
create table if not exists public.members (
  email        text primary key check (email = lower(email)),
  name         text not null default '',
  is_admin     boolean not null default false,   -- can add/remove family members, edit categories
  see_private  boolean not null default false,   -- can see categories marked private
  created_at   timestamptz not null default now()
);

create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  prefix      text not null unique check (prefix ~ '^[A-Z0-9]{2,6}$'),
  color       text not null default '#5b6b73',
  is_private  boolean not null default false,
  sort        int not null default 0,
  parent_id   uuid references public.categories(id) on delete restrict,
  created_at  timestamptz not null default now()
);

create table if not exists public.locations (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9-]{2,20}$'),
  name        text not null,
  parent_id   uuid references public.locations(id) on delete set null,
  kind        text not null default 'shelf' check (kind in ('building', 'room', 'shelf')),
  levels      int not null default 1 check (levels between 1 and 20),
  notes       text not null default '',
  labeled     boolean not null default false,
  created_by  text default (auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.boxes (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique check (code ~ '^[A-Z0-9-]{2,20}$'),
  title        text not null default '',
  category_id  uuid not null references public.categories(id),
  location_id  uuid references public.locations(id) on delete set null,
  level        int check (level is null or level >= 1),
  notes        text not null default '',
  labeled      boolean not null default false,
  created_by   text default (auth.jwt() ->> 'email'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  updated_by   text default (auth.jwt() ->> 'email')
);

create table if not exists public.items (
  id          uuid primary key default gen_random_uuid(),
  box_id      uuid not null references public.boxes(id) on delete cascade,
  name        text not null,
  qty         int not null default 1 check (qty >= 0),
  notes       text not null default '',
  created_at  timestamptz not null default now()
);

create table if not exists public.photos (
  id           uuid primary key default gen_random_uuid(),
  box_id       uuid references public.boxes(id) on delete cascade,
  location_id  uuid references public.locations(id) on delete cascade,
  path         text not null,
  thumb_path   text not null,
  created_by   text default (auth.jwt() ->> 'email'),
  created_at   timestamptz not null default now(),
  check ((box_id is null) <> (location_id is null))
);

-- History of box moves (filled in automatically)
create table if not exists public.moves (
  id             bigint generated always as identity primary key,
  box_id         uuid not null references public.boxes(id) on delete cascade,
  from_location  uuid references public.locations(id) on delete set null,
  to_location    uuid references public.locations(id) on delete set null,
  to_level       int,
  moved_by       text default (auth.jwt() ->> 'email'),
  moved_at       timestamptz not null default now()
);

-- (for databases created before buildings/levels existed)
alter table public.locations add column if not exists kind   text not null default 'shelf';
alter table public.locations add column if not exists levels int  not null default 1;
alter table public.boxes     add column if not exists level  int;
alter table public.moves     add column if not exists to_level int;
alter table public.categories add column if not exists parent_id uuid references public.categories(id) on delete restrict;

create index if not exists items_box_idx   on public.items(box_id);
create index if not exists photos_box_idx  on public.photos(box_id);
create index if not exists photos_loc_idx  on public.photos(location_id);
create index if not exists boxes_loc_idx   on public.boxes(location_id);
create index if not exists moves_box_idx   on public.moves(box_id, moved_at desc);

-- ============================================================
-- 2. Helper functions
-- ============================================================

create or replace function public.my_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email', '')) $$;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where email = public.my_email())
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where email = public.my_email() and is_admin)
$$;

create or replace function public.can_see_category(cat uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from categories c left join categories p on p.id = c.parent_id, members m
    where c.id = cat and m.email = public.my_email()
      and (not (c.is_private or coalesce(p.is_private, false)) or m.see_private or m.is_admin)
  )
$$;

create or replace function public.can_see_box(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from boxes where id = b and public.can_see_category(category_id))
$$;

-- Next free box number for a prefix, e.g. XMAS → XMAS-08
create or replace function public.next_code(p text) returns text
language sql stable security definer set search_path = public as $$
  select p || '-' || lpad((coalesce(max((regexp_match(code, '-(\d+)$'))[1]::int), 0) + 1)::text, 2, '0')
  from (select code from boxes union all select code from locations) all_codes
  where code ~ ('^' || p || '-\d+$')
$$;

-- Keep updated_at fresh and log moves
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

drop trigger if exists boxes_touch on public.boxes;
create trigger boxes_touch before update on public.boxes
  for each row execute function public.touch_box();

create or replace function public.log_first_location() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.location_id is not null then
    insert into moves(box_id, from_location, to_location, to_level, moved_by)
    values (new.id, null, new.location_id, new.level, public.my_email());
  end if;
  return new;
end $$;

drop trigger if exists boxes_first_loc on public.boxes;
create trigger boxes_first_loc after insert on public.boxes
  for each row execute function public.log_first_location();

create or replace function public.touch_loc() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists locations_touch on public.locations;
create trigger locations_touch before update on public.locations
  for each row execute function public.touch_loc();

-- Touch the box when its items change, so "recently updated" works
create or replace function public.touch_parent_box() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update boxes set updated_at = now() where id = coalesce(new.box_id, old.box_id);
  return null;
end $$;

drop trigger if exists items_touch_box on public.items;
create trigger items_touch_box after insert or update or delete on public.items
  for each row execute function public.touch_parent_box();

-- ============================================================
-- 3. Access rules (only family members; private categories hidden)
-- ============================================================

alter table public.members    enable row level security;
alter table public.categories enable row level security;
alter table public.locations  enable row level security;
alter table public.boxes      enable row level security;
alter table public.items      enable row level security;
alter table public.photos     enable row level security;
alter table public.moves      enable row level security;

do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies
           where schemaname = 'public'
             and tablename in ('members','categories','locations','boxes','items','photos','moves')
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- members: everyone in the family can see the list; only admins change it
create policy members_read  on public.members for select using (public.is_member());
create policy members_write on public.members for all
  using (public.is_admin()) with check (public.is_admin());

-- categories
create policy cat_read  on public.categories for select
  using (public.is_member() and public.can_see_category(id));
create policy cat_write on public.categories for all
  using (public.is_admin()) with check (public.is_admin());

-- locations: any member; buildings only by admins
create policy loc_read   on public.locations for select using (public.is_member());
create policy loc_insert on public.locations for insert
  with check (public.is_member() and (kind <> 'building' or public.is_admin()));
create policy loc_update on public.locations for update
  using (public.is_member() and (kind <> 'building' or public.is_admin()))
  with check (public.is_member() and (kind <> 'building' or public.is_admin()));
create policy loc_delete on public.locations for delete
  using (public.is_member() and (kind <> 'building' or public.is_admin()));

-- boxes: any member, but private categories only for those allowed
create policy box_all on public.boxes for all
  using (public.can_see_category(category_id))
  with check (public.can_see_category(category_id));

-- items / moves follow their box
create policy item_all on public.items for all
  using (public.can_see_box(box_id)) with check (public.can_see_box(box_id));
create policy move_read on public.moves for select using (public.can_see_box(box_id));

-- photos follow their box or location
create policy photo_all on public.photos for all
  using (case when box_id is not null then public.can_see_box(box_id) else public.is_member() end)
  with check (case when box_id is not null then public.can_see_box(box_id) else public.is_member() end);

-- Explicit access for signed-in users (works whether or not "auto-expose tables" was on).
-- The rules above still decide which rows each person can see.
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.members, public.categories, public.locations,
  public.boxes, public.items, public.photos to authenticated;
grant select on public.moves to authenticated;
revoke all on public.members, public.categories, public.locations, public.boxes,
  public.items, public.photos, public.moves from anon;

-- The very first person to sign in (when the family list is empty) becomes the admin.
create or replace function public.claim_first_admin() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from members) or public.my_email() = '' then return false; end if;
  insert into members(email, name, is_admin, see_private) values (public.my_email(), '', true, true);
  return true;
end $$;
grant execute on function public.claim_first_admin() to authenticated;

grant execute on function public.next_code(text) to authenticated;
grant execute on function public.is_member() to authenticated;

-- ============================================================
-- 4. Photo storage (private bucket, family members only)
-- ============================================================

insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "family read photos"   on storage.objects;
drop policy if exists "family add photos"    on storage.objects;
drop policy if exists "family delete photos" on storage.objects;

create policy "family read photos" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.is_member());
create policy "family add photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.is_member());
create policy "family delete photos" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.is_member());

-- ============================================================
-- 5. Starting data (the first person to sign in becomes the admin — see claim_first_admin)
-- ============================================================

-- (Decorations and its sub-categories are added by 003_subcategories.sql)
insert into public.categories (name, prefix, color, is_private, sort) values
  ('Shop parts & tools',    'SHOP', '#2e6da4', false, 3),
  ('Video equipment',       'VID',  '#7d3c98', false, 4),
  ('Secure storage',        'STOR', '#4d5656', true,  5),
  ('Household',             'HOME', '#1e8449', false, 6)
on conflict (prefix) do nothing;
