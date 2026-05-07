-- ============================================================
-- Migration: Add Switzerland (CH) GoLogin profile
--
-- Operator added a new GoLogin profile "024 | TP Test | Switzerland".
-- Seed the row so the country shows up in the /scrape and /profiles
-- dropdowns. The actual gologin_profile_id is filled in by running
-- `npm run gologin:sync-profiles` after this migration applies.
--
-- Switzerland is officially multilingual: German (de) is most common,
-- followed by French (fr), Italian (it), and Romansh (rm). All four
-- plus English are listed so operators can pick the right hl=… for
-- the locale they're targeting.
-- ============================================================

insert into public.gologin_profiles
  (country_code, country_name, gologin_display_name, languages)
values
  ('CH', 'Switzerland', '024 | TP Test | Switzerland', array['de', 'fr', 'it', 'rm', 'en'])
on conflict (country_code) do update
  set country_name         = excluded.country_name,
      gologin_display_name = excluded.gologin_display_name,
      languages            = excluded.languages,
      updated_at           = now();
