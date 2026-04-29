-- ============================================================
-- Migration: Per-country language list + per-job language code
--
-- Some countries default to English on Google.com despite being
-- non-English-speaking (e.g. Oman, UAE). Letting the UI pick a
-- search-language code per scrape unlocks local-language SERPs
-- without changing the country profile.
--
-- 1. gologin_profiles.languages — text[] of ISO 639-1 codes valid
--    for that country. The UI dropdown shows these (English is
--    always included as a fallback).
-- 2. scrape_queue.language — chosen code for one scrape, default
--    'en'. Workers append &hl=<code> to the Google URL.
-- ============================================================

alter table public.gologin_profiles
  add column if not exists languages text[] not null default array['en'];

alter table public.scrape_queue
  add column if not exists language text not null default 'en';

-- Seed per-country languages. EN included everywhere as a fallback.
update public.gologin_profiles set languages = array['da', 'en'] where country_code = 'DK';
update public.gologin_profiles set languages = array['it', 'en'] where country_code = 'IT';
update public.gologin_profiles set languages = array['en']       where country_code = 'AU';
update public.gologin_profiles set languages = array['ar', 'en'] where country_code = 'OM';
update public.gologin_profiles set languages = array['ar', 'en'] where country_code = 'KW';
update public.gologin_profiles set languages = array['ar', 'en'] where country_code = 'BH';
update public.gologin_profiles set languages = array['ar', 'en'] where country_code = 'QA';
update public.gologin_profiles set languages = array['ar', 'en'] where country_code = 'SA';
update public.gologin_profiles set languages = array['ar', 'en'] where country_code = 'AE';
update public.gologin_profiles set languages = array['no', 'en'] where country_code = 'NO';
update public.gologin_profiles set languages = array['de', 'en'] where country_code = 'AT';
update public.gologin_profiles set languages = array['en']       where country_code = 'NZ';
update public.gologin_profiles set languages = array['de', 'en'] where country_code = 'DE';
update public.gologin_profiles set languages = array['en', 'fr'] where country_code = 'CA';
update public.gologin_profiles set languages = array['en']       where country_code = 'GB';
