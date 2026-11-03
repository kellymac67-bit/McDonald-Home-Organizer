-- McDonald Home Organizer: thermostat (Google Nest via Home Assistant). Run after 001-009.
-- Paste into Supabase SQL Editor > New query > Run. Run this BEFORE updating the bridge to 0.5.0.

-- 1. Thermostats are a new kind of device
alter table public.ha_devices drop constraint if exists ha_devices_kind_check;
alter table public.ha_devices add constraint ha_devices_kind_check
  check (kind in ('camera','switch','light','sensor','binary_sensor','lock','cover','climate'));

-- 2. New command: change the thermostat (temperature, mode, eco). payload holds what to change.
alter table public.ha_commands drop constraint if exists ha_commands_action_check;
alter table public.ha_commands add constraint ha_commands_action_check
  check (action in ('turn_on','turn_off','toggle','snapshot','lock','unlock','open','close',
                    'scene_on','scene_off','scene_run','bulk_on','bulk_off','climate_set'));

create or replace function public.ha_command_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record; n int; bad int; k text; t numeric;
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
  elsif new.action = 'climate_set' then
    if d.kind <> 'climate' then raise exception 'That is not a thermostat'; end if;
    if jsonb_typeof(new.payload) <> 'object' or new.payload = '{}'::jsonb then raise exception 'Nothing to change'; end if;
    -- only these settings, and temperatures in a sane range (°F or °C)
    for k in select jsonb_object_keys(new.payload) loop
      if k not in ('temperature','target_temp_low','target_temp_high','hvac_mode','preset_mode') then
        raise exception 'Unknown thermostat setting %', k;
      end if;
      if k like '%temp%' then
        t := (new.payload->>k)::numeric;
        if t is null or t < 5 or t > 95 then raise exception 'That temperature is out of range'; end if;
      end if;
    end loop;
    if new.payload ? 'hvac_mode' and new.payload->>'hvac_mode' not in ('off','heat','cool','heat_cool','auto','fan_only','dry') then
      raise exception 'Unknown thermostat mode';
    end if;
    if new.payload ? 'preset_mode' and length(new.payload->>'preset_mode') > 30 then raise exception 'Unknown preset'; end if;
  elsif d.kind not in ('switch','light') then
    raise exception 'That device can''t be switched from the app';
  end if;
  return new;
end $$;
-- (the cmd_insert policy already requires "Can control" for every action other than snapshot / doors)
