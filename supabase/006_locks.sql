-- Home Organizer — update 6: lock and unlock doors from the app
-- Run once in Supabase: SQL Editor → New query → paste all of this → Run. Safe to run again.

-- Separate permission for doors (admins always have it)
alter table public.members add column if not exists can_unlock boolean not null default false;

create or replace function public.can_unlock() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where email = public.my_email() and (is_admin or can_unlock))
$$;
grant execute on function public.can_unlock() to authenticated;

-- New command types
alter table public.ha_commands drop constraint if exists ha_commands_action_check;
alter table public.ha_commands add constraint ha_commands_action_check
  check (action in ('turn_on','turn_off','toggle','snapshot','lock','unlock'));

create or replace function public.ha_command_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record;
begin
  select kind, enabled into d from ha_devices where entity_id = new.entity_id;
  if d is null or not d.enabled then raise exception 'That device is not available'; end if;
  if new.action = 'snapshot' then
    if d.kind <> 'camera' then raise exception 'Only cameras take snapshots'; end if;
  elsif new.action in ('lock','unlock') then
    if d.kind <> 'lock' then raise exception 'That is not a lock'; end if;
  elsif d.kind not in ('switch','light') then
    raise exception 'That device can''t be switched from the app';
  end if;
  new.requested_by := public.my_email();
  new.requested_at := now();
  new.status := 'pending';
  return new;
end $$;

drop policy if exists cmd_insert on public.ha_commands;
create policy cmd_insert on public.ha_commands for insert with check (
  case when action = 'snapshot' then public.can_see_cameras()
       when action in ('lock','unlock') then public.can_unlock()
       else public.can_control() end);
