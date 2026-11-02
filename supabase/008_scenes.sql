-- Home Organizer — update 8: scenes, each person's own Home screen, "all on/off" commands
-- Run once in Supabase: SQL Editor → New query → paste all of this → Run. Safe to run again.

-- ============================================================
-- 1. Scenes
-- ============================================================
-- items:    [{"entity_id":"switch.porch_light","target":"on"}]   (target only matters for one-button scenes)
-- extras:   [{"entity_id":"lock.mcfront","action":"lock"}, {"entity_id":"cover.tallman_garage","action":"close"}]
-- schedule: {"on":{"kind":"sunset","offset":-15,"days":[0,1,2,3,4,5,6]},"off":{"kind":"time","time":"23:00","days":[…]}}
--           kind: none | time | sunset | sunrise   ("run" instead of on/off for one-button scenes)
create table if not exists public.ha_scenes (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (length(trim(name)) > 0),
  icon         text not null default 'bulb',
  mode         text not null default 'pair' check (mode in ('pair','single')),
  items        jsonb not null default '[]',
  extras       jsonb not null default '[]',
  extras_with  text not null default 'off' check (extras_with in ('on','off')),
  schedule     jsonb not null default '{}',
  sort         int not null default 0,
  created_by   text default public.my_email(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Door/garage steps in a scene need the door permission
create or replace function public.ha_scene_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if jsonb_array_length(coalesce(new.extras, '[]')) > 0 and not public.can_unlock() and not public.is_bridge() then
    if tg_op = 'INSERT' or new.extras is distinct from old.extras then
      raise exception 'Only people allowed to use doors can add door or garage steps to a scene';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists ha_scenes_check on public.ha_scenes;
create trigger ha_scenes_check before insert or update on public.ha_scenes
  for each row execute function public.ha_scene_check();

-- ============================================================
-- 2. Each person's Home screen (sections, scenes, favorite lights, readings, cameras)
-- ============================================================
create table if not exists public.home_prefs (
  email       text primary key default public.my_email(),
  prefs       jsonb not null default '{}',
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- 3. Commands: run a scene, or switch a group of lights at once
-- ============================================================
alter table public.ha_commands alter column entity_id drop not null;
alter table public.ha_commands add column if not exists scene_id uuid references public.ha_scenes(id) on delete cascade;
alter table public.ha_commands add column if not exists payload jsonb not null default '{}';
alter table public.ha_commands add column if not exists allow_doors boolean not null default false;

alter table public.ha_commands drop constraint if exists ha_commands_action_check;
alter table public.ha_commands add constraint ha_commands_action_check
  check (action in ('turn_on','turn_off','toggle','snapshot','lock','unlock','open','close',
                    'scene_on','scene_off','scene_run','bulk_on','bulk_off'));

create or replace function public.ha_command_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record; n int; bad int;
begin
  new.requested_by := public.my_email();
  new.requested_at := now();
  new.status := 'pending';
  new.allow_doors := public.can_unlock();

  if new.action like 'scene\_%' then
    if new.scene_id is null or not exists (select 1 from ha_scenes where id = new.scene_id) then
      raise exception 'That scene no longer exists';
    end if;
    return new;
  end if;

  if new.action like 'bulk\_%' then
    select count(*) into n from jsonb_array_elements_text(coalesce(new.payload->'entity_ids', '[]'));
    if n = 0 or n > 200 then raise exception 'Nothing to switch'; end if;
    select count(*) into bad from jsonb_array_elements_text(new.payload->'entity_ids') e(id)
     where not exists (select 1 from ha_devices h where h.entity_id = e.id and h.enabled and h.kind in ('switch','light'));
    if bad > 0 then raise exception 'Some of those devices can''t be switched from the app'; end if;
    return new;
  end if;

  select kind, enabled into d from ha_devices where entity_id = new.entity_id;
  if d is null or not d.enabled then raise exception 'That device is not available'; end if;
  if new.action = 'snapshot' then
    if d.kind <> 'camera' then raise exception 'Only cameras take snapshots'; end if;
  elsif new.action in ('lock','unlock') then
    if d.kind <> 'lock' then raise exception 'That is not a lock'; end if;
  elsif new.action in ('open','close') then
    if d.kind <> 'cover' then raise exception 'That is not a door that opens'; end if;
  elsif d.kind not in ('switch','light') then
    raise exception 'That device can''t be switched from the app';
  end if;
  return new;
end $$;

-- ============================================================
-- 4. Access rules
-- ============================================================
alter table public.ha_scenes  enable row level security;
alter table public.home_prefs enable row level security;

drop policy if exists scenes_read   on public.ha_scenes;
drop policy if exists scenes_write  on public.ha_scenes;
drop policy if exists scenes_bridge on public.ha_scenes;
create policy scenes_read   on public.ha_scenes for select using (public.is_member() or public.is_bridge());
create policy scenes_write  on public.ha_scenes for all using (public.can_control()) with check (public.can_control());
create policy scenes_bridge on public.ha_scenes for insert with check (public.is_bridge());   -- first-time setup of your Kasa groups

drop policy if exists prefs_own on public.home_prefs;
create policy prefs_own on public.home_prefs for all
  using (email = public.my_email() and public.is_member())
  with check (email = public.my_email() and public.is_member());

drop policy if exists cmd_insert on public.ha_commands;
create policy cmd_insert on public.ha_commands for insert with check (
  case when action = 'snapshot' then public.can_see_cameras()
       when action in ('lock','unlock','open','close') then public.can_unlock()
       else public.can_control() end);

grant select, insert, update, delete on public.ha_scenes, public.home_prefs to authenticated;
revoke all on public.ha_scenes, public.home_prefs from anon;
