-- ============================================================
-- Migration: Add Sweden (SE) GoLogin profile
--
-- Approved for production 2026-07-20. Adds Sweden to the country
-- roster (brings the total to 19 active markets — post 3→2 VM resize).
--
-- Operator adds the GoLogin profile following the existing
-- "NNN | TP Test | Country" convention (Slovenia was 026):
--   "027 | TP Test | Sweden"
--
-- After this migration applies, run `npm run gologin:sync-profiles`
-- to populate gologin_profile_id — that script matches on
-- gologin_display_name, so the name above MUST match the GoLogin
-- dashboard exactly.
--
-- Left logged-out (requires_google_login defaults to false), same as
-- Denmark / Norway / Slovenia. Flip to true later + set a sticky
-- proxy and a Google credential if Swedish gambling SERPs start
-- demanding a signed-in session.
--
-- Languages: Swedish (sv) primary, English fallback. Sv is a new
-- language code — the enqueue-form's LANG_NAMES map now includes it
-- so the dropdown labels the option "Swedish (sv)" rather than
-- "SV (sv)".
--
-- Also: vm/scraper.py's BING_COUNTRY_TO_CC map has been updated to
-- include "Sweden": "SE" so Bing searches route through the correct
-- cc= query param. Deploy scraper.py to both VMs after applying this
-- migration so Bing SE scrapes return SE-localized results.
-- ============================================================

insert into public.gologin_profiles
  (country_code, country_name, gologin_display_name, languages)
values
  ('SE', 'Sweden', '027 | TP Test | Sweden', array['sv', 'en'])
on conflict (country_code) do update
  set country_name         = excluded.country_name,
      gologin_display_name = excluded.gologin_display_name,
      languages            = excluded.languages,
      updated_at           = now();
