-- McDonald Home Organizer: too-cold / too-hot phone alerts for thermostats. Run after 010.
-- Paste into Supabase SQL Editor > New query > Run.
-- Admins change the temperatures in the app (tap the thermostat > Alerts). The bridge turns them into a
-- Home Assistant automation, so the alerts work even when the internet is down.
alter table public.ha_devices add column if not exists alert_low  numeric;
alter table public.ha_devices add column if not exists alert_high numeric;
update public.ha_devices set alert_low = 60, alert_high = 78
 where kind = 'climate' and alert_low is null and alert_high is null;
-- new thermostats start at 60° / 78° too
create or replace function public.ha_climate_alert_defaults() returns trigger language plpgsql as $$
begin
  if new.kind = 'climate' and new.alert_low is null and new.alert_high is null then
    new.alert_low := 60; new.alert_high := 78;
  end if;
  return new;
end $$;
drop trigger if exists ha_climate_alert_defaults on public.ha_devices;
create trigger ha_climate_alert_defaults before insert on public.ha_devices
  for each row execute function public.ha_climate_alert_defaults();
alter table public.ha_devices drop constraint if exists ha_devices_alert_chk;
alter table public.ha_devices add constraint ha_devices_alert_chk check (
  (alert_low  is null or alert_low  between 30 and 90) and
  (alert_high is null or alert_high between 50 and 110) and
  (alert_low is null or alert_high is null or alert_high > alert_low));
