-- ============================================================
-- Per-user "bypass daily scrape cap" flag.
--
-- Previously the 20/day quota was bypassed by ANY user with
-- is_admin = true. Operators reported that the working admins
-- (Charisse, Hannah, liveprod etc.) should also be subject to the
-- cap; only the dedicated "Admin" service account should bypass.
--
-- Split it out as its own flag so cap bypass is independent of
-- access control (is_admin still gates /admin pages + privileged
-- RPCs). Default false; the seed below grants bypass only to the
-- account whose username is exactly "Admin".
-- ============================================================

alter table public.user_profiles
  add column if not exists bypass_scrape_cap boolean not null default false;

-- Seed: grant bypass only to the dedicated Admin account. Everyone
-- else (including other is_admin users) starts subject to the cap.
update public.user_profiles
set bypass_scrape_cap = true
where username = 'Admin'
  and bypass_scrape_cap = false;
