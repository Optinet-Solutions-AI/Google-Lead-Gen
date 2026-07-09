-- ============================================================
-- Migration: Add Ireland (IE) + Slovenia (SI) GoLogin profiles
--
-- Approved for production 2026-07-09. Two new target markets.
-- Operational note: PPC/paid-search is not run for Ireland — there is
-- no per-country engine config, so operators simply skip the PPC engine
-- when enqueuing IE jobs.
--
-- Operator adds two new GoLogin profiles following the existing
-- "NNN | TP Test | Country" convention (Switzerland was 024):
--   "025 | TP Test | Ireland"
--   "026 | TP Test | Slovenia"
-- Seed the rows so the countries appear in the /scrape and /profiles
-- dropdowns. The actual gologin_profile_id is filled in by running
-- `npm run gologin:sync-profiles` after this migration applies — that
-- script matches on gologin_display_name, so the names above MUST match
-- the GoLogin dashboard exactly.
--
-- Both left logged-out (requires_google_login defaults to false), same
-- as Switzerland. Flip to true later + set a sticky proxy and a Google
-- credential if their gambling SERPs start demanding a signed-in session.
--
-- Languages:
--   Ireland  — English only (like GB/NZ/AU).
--   Slovenia — Slovenian (sl) primary, English fallback.
-- ============================================================

insert into public.gologin_profiles
  (country_code, country_name, gologin_display_name, languages)
values
  ('IE', 'Ireland',  '025 | TP Test | Ireland',  array['en']),
  ('SI', 'Slovenia', '026 | TP Test | Slovenia', array['sl', 'en'])
on conflict (country_code) do update
  set country_name         = excluded.country_name,
      gologin_display_name = excluded.gologin_display_name,
      languages            = excluded.languages,
      updated_at           = now();
