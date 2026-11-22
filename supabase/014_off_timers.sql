-- McDonald Home: off timers ("turn off the Tree House in 45 minutes").
-- The bridge runs the timers and lists the active ones here so the app can show and cancel them.
alter table public.ha_bridge_status add column if not exists timers jsonb not null default '[]';
