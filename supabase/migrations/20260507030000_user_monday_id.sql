-- ============================================================
-- Migration: user_profiles.monday_user_id — per-user Monday owner ID
--
-- Today the "Push to Monday" action stamps a hardcoded owner
-- (DEFAULT_OWNER_ID = 46169036, which is Charisse Bartoli's Monday
-- ID inherited from the legacy n8n workflow) on every new lead it
-- creates. That's wrong for multi-user setups — whoever clicks Push
-- should land as the Owner so the sales team can see who flagged
-- the lead.
--
-- This migration adds a nullable monday_user_id column. Admins
-- populate it on /admin/users; pushLeadToMonday() reads the column
-- for the pushing user and falls back to the hardcoded default
-- when it's null (so users who haven't been mapped yet still
-- produce a working item, just under the legacy owner).
-- ============================================================

alter table public.user_profiles
  add column if not exists monday_user_id bigint;

-- Sanity index so the lookup in pushLeadToMonday() is a key-only
-- scan even when user_profiles grows.
create index if not exists idx_user_profiles_monday_user_id
  on public.user_profiles (monday_user_id)
  where monday_user_id is not null;
