-- ============================================================
-- Migration: X (x.com) login state on gologin_profiles
--
-- X gates logged-out scraping behind a hard login wall (intensified
-- 2026 + Cloudflare Turnstile on the login challenge), so both X phases
-- need the GoLogin profile to be signed into a (burner) X account. This
-- mirrors the Google-login flags added by 20260424290000_gologin_login_state.sql
-- (requires_google_login / is_google_logged_in) so the X workers and the
-- enqueue-form warning can reason about X auth the same way.
--
-- How a profile gets logged in: an operator opens the profile via noVNC,
-- signs into the burner X account once (the worker's interactive-checkpoint
-- path parks the job on the login wall so this can happen in-band), and the
-- cookies persist in the GoLogin profile. Then flag is_x_logged_in = true.
--
-- Additive only — all columns nullable / defaulted; no behaviour change for
-- existing Google/Bing/YouTube/Kick profiles.
-- ============================================================

alter table public.gologin_profiles
  add column if not exists requires_x_login   boolean default false,
  add column if not exists is_x_logged_in     boolean default false,
  add column if not exists x_login_verified_at timestamptz,
  add column if not exists x_login_notes      text;
