-- Home Organizer — update 3: main categories and sub-categories
-- Run once in Supabase: SQL Editor → New query → paste all of this → Run.
-- Safe to run again. Existing boxes keep their numbers.

-- 1. Sub-categories point at their main category ---------------------------
alter table public.categories add column if not exists parent_id uuid references public.categories(id) on delete restrict;
create index if not exists categories_parent_idx on public.categories(parent_id);

-- 2. "Private" on a main category also hides everything under it ----------
create or replace function public.can_see_category(cat uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from categories c left join categories p on p.id = c.parent_id, members m
    where c.id = cat and m.email = public.my_email()
      and (not (c.is_private or coalesce(p.is_private, false)) or m.see_private or m.is_admin)
  )
$$;

-- 3. Decorations and its sub-categories ------------------------------------
do $$
declare deco uuid; pre text;
begin
  select id into deco from public.categories where parent_id is null and lower(name) = 'decorations' limit 1;
  if deco is null then
    pre := 'DECO';
    while exists (select 1 from public.categories where prefix = pre) loop pre := pre || 'X'; end loop;
    insert into public.categories (name, prefix, color, is_private, sort)
    values ('Decorations', pre, '#0076B6', false, 0) returning id into deco;
  end if;

  -- "Christmas decorations" becomes Decorations › Christmas (boxes keep XMAS-xx)
  update public.categories set name = 'Christmas', parent_id = deco, sort = 1
   where prefix = 'XMAS' and id <> deco and parent_id is null;

  insert into public.categories (name, prefix, color, is_private, sort, parent_id) values
    ('Christmas',    'XMAS', '#c0392b', false, 1, deco),
    ('Spring',       'SPRG', '#43a047', false, 2, deco),
    ('Easter',       'EAST', '#ab47bc', false, 3, deco),
    ('July 4th',     'JUL4', '#1e4fa3', false, 4, deco),
    ('Halloween',    'HALL', '#ef6c00', false, 5, deco),
    ('Fall',         'FALL', '#a0522d', false, 6, deco),
    ('Thanksgiving', 'THNK', '#795548', false, 7, deco)
  on conflict (prefix) do nothing;

  -- "Other seasonal": remove it if empty; otherwise park it under Decorations to sort
  if exists (select 1 from public.categories c where c.prefix = 'SEAS'
             and not exists (select 1 from public.boxes b where b.category_id = c.id)) then
    delete from public.categories where prefix = 'SEAS';
  else
    update public.categories set name = 'Other seasonal (to sort)', parent_id = deco, sort = 99
     where prefix = 'SEAS' and parent_id is null;
  end if;
end $$;
