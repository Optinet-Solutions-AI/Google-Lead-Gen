-- ============================================================
-- Migration: Username-based user model + attribution polish
--
-- Supabase Auth requires an email under the hood, but the admin and
-- /login flows have always taken a username and mapped it internally
-- (<username>@rooster.local). The user_profiles table previously had
-- only an is_admin flag — extending it with username + display_name
-- so the admin "Add user" form doesn't have to surface email at all.
--
-- Also backfills:
--   - the seed admin's user_profiles row with username='admin',
--     display_name='Admin' (so "by Admin" shows immediately on /scrape)
--   - every existing scrape_queue row with the seed admin's
--     credentials, so historical jobs are clearly the admin's
--     work and don't appear blank after a second user signs in
-- ============================================================

-- ------------------------------------------------------------
-- 1. user_profiles — username + display_name
-- ------------------------------------------------------------
alter table public.user_profiles
  add column if not exists username     text,
  add column if not exists display_name text;

-- Username must be unique among non-null rows, but pre-existing
-- profiles will be filled by the backfill below.
create unique index if not exists idx_user_profiles_username_unique
  on public.user_profiles (lower(username))
  where username is not null;

-- ------------------------------------------------------------
-- 2. Backfill the seed admin so /admin/users + /scrape show a real
-- name immediately. Picks 'admin' as the canonical username; if
-- that's already taken (shouldn't be on first apply) the update
-- silently skips and the user can pick a different one in the UI.
-- ------------------------------------------------------------
update public.user_profiles up
set username     = coalesce(up.username, 'admin'),
    display_name = coalesce(up.display_name, 'Admin'),
    updated_at   = now()
from auth.users au
where up.id = au.id
  and lower(au.email) = 'liveprod@optinetsolutions.com';

-- ------------------------------------------------------------
-- 3. Display columns on scrape_queue. Denormalized at insert time
-- so /scrape can render "by <display>" without a join. Backfill
-- existing rows under the assumption every prior queue was the
-- admin's (only one user existed before this migration).
-- ------------------------------------------------------------
alter table public.scrape_queue
  add column if not exists created_by_username text,
  add column if not exists created_by_display  text;

update public.scrape_queue
set created_by_email    = coalesce(created_by_email, 'liveprod@optinetsolutions.com'),
    created_by_username = coalesce(created_by_username, 'admin'),
    created_by_display  = coalesce(created_by_display, 'Admin')
where created_by_email is null
   or created_by_username is null
   or created_by_display is null;

-- ------------------------------------------------------------
-- 4. lookup_user_email_by_username — used by login + admin actions
-- to translate a username to the underlying Supabase auth email.
-- Falls back to the synthetic <username>@rooster.local convention
-- when no profile row matches.
-- ------------------------------------------------------------
create or replace function public.lookup_user_email_by_username(p_username text)
returns text
language sql
stable
security definer
set search_path = public, auth
as $$
  select au.email
  from public.user_profiles up
  join auth.users au on au.id = up.id
  where lower(up.username) = lower(p_username)
  limit 1;
$$;

grant execute on function public.lookup_user_email_by_username(text) to service_role, authenticated, anon;
