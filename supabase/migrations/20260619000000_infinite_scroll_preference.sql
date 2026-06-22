-- ============================================================
-- Per-user "auto-load on scroll" preference.
--
-- Operators reported that picking "Rows: 20" on /leads or /scrape
-- and then scrolling kept appending more rows past the 20, defeating
-- the intent of the row picker. Gate the behaviour on a per-user
-- toggle, default OFF so the row picker is the hard limit again.
-- Users who liked infinite scroll can flip it on under /account.
--
-- The flag lives on user_profiles alongside is_admin / is_shadow so
-- one read per layout pass is enough — no extra table.
-- ============================================================

alter table public.user_profiles
  add column if not exists infinite_scroll_enabled boolean not null default false;
