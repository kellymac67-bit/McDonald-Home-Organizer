-- Home Organizer — update 7: open and close the garage door from the app
-- Run once in Supabase: SQL Editor → New query → paste all of this → Run. Safe to run again.
-- Uses the same permission as door locks ("Can lock/unlock doors and open the garage").

alter table public.ha_commands drop constraint if exists ha_commands_action_check;
alter table public.ha_commands add constraint ha_commands_action_check
  check (action in ('turn_on','turn_off','toggle','snapshot','lock','unlock','open','close'));

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
  elsif new.action in ('open','close') then
    if d.kind <> 'cover' then raise exception 'That is not a door that opens'; end if;
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
       when action in ('lock','unlock','open','close') then public.can_unlock()
       else public.can_control() end);
