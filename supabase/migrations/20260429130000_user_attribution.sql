-- ============================================================
-- Migration: Multi-user support + per-job creator attribution
--
-- Scope:
--   1. user_profiles table — augments Supabase auth.users with an
--      `is_admin` flag we control. Auto-populates via trigger.
--   2. is_admin() helper RPC — the admin pages call this to gate
--      access without needing direct auth.users reads.
--   3. created_by_email columns on scrape_queue + enrichment_fetch_queue
--      so /scrape and /scrape/[id] can show "queued by <user>".
--   4. Promotes liveprod@optinetsolutions.com to admin so the new
--      /admin/users page is reachable on first deploy.
--
-- Out of scope for this migration (next pass):
--   - *_overridden_by_email on google_lead_gen_table (5 columns)
--   - per-row attribution on s_tags_table / contact_table
--   activity_log already records user_id + user_email for every
--   logActivity() call, so audit-trail visibility is already covered.
-- ============================================================

-- ------------------------------------------------------------
-- 1. user_profiles
-- ------------------------------------------------------------
create table if not exists public.user_profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

-- Auto-create a profile row whenever a new auth user is provisioned
-- (admin createUser, signup, magic-link, whatever). Idempotent.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, is_admin)
  values (new.id, false)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Backfill profiles for any users that existed before this migration.
insert into public.user_profiles (id, is_admin)
select au.id, false
from auth.users au
left join public.user_profiles up on up.id = au.id
where up.id is null;

-- Promote the seed user so the admin page is reachable on first deploy.
update public.user_profiles
set is_admin = true,
    updated_at = now()
where id in (
  select id from auth.users where lower(email) = 'liveprod@optinetsolutions.com'
);

-- ------------------------------------------------------------
-- 2. is_admin() helper RPC
-- Used by server actions to gate admin pages without each one
-- needing direct auth.users access.
-- ------------------------------------------------------------
create or replace function public.is_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(is_admin, false) from public.user_profiles where id = p_user_id;
$$;

grant execute on function public.is_admin(uuid) to service_role, authenticated;

-- ------------------------------------------------------------
-- 3. created_by_email on the work queues
-- Denormalized email rather than a uuid FK so the table queries
-- ("queued by <user>") don't need a join — and so we can show the
-- attribution on rows whose user has since been deleted.
-- ------------------------------------------------------------
alter table public.scrape_queue
  add column if not exists created_by_email text;

alter table public.enrichment_fetch_queue
  add column if not exists created_by_email text;

create index if not exists idx_scrape_queue_created_by_email
  on public.scrape_queue (created_by_email)
  where created_by_email is not null;
