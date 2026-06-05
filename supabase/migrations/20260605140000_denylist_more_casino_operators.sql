-- ============================================================
-- Migration: extend operator_domains_denylist with more casino operators
-- surfaced by the TikTok + Facebook runs.
--
-- These are casino OPERATORS / affiliate redirectors that weren't in the
-- denylist, so isAffiliateCasinoLink() missed them and the scorers
-- under-flagged real affiliates pointing ads / bio links at them:
--   - el777.univer.se — casino redirector behind a TikTok creator's bio link
--     (@el_cassino777 scored 21 instead of flagging).
--   - the social-casino app brands that recurred as Facebook Ad Library ad
--     destinations (DoubleDown / Apps4Slots / Free247Slots / etc.).
--
-- DELIBERATELY EXCLUDES real licensed casino RESORTS (turningstone, hardrock,
-- twinpine, claridge, …): those advertise their OWN site, so denylisting them
-- would make the resort itself self-flag as an "affiliate" (false positive).
-- Only redirectors + social-casino app brands belong here.
--
-- Additive; ON CONFLICT DO NOTHING so re-running is safe.
-- ============================================================
insert into public.operator_domains_denylist (host_suffix, added_by, note) values
  ('el777.univer.se',     'tiktok',  'casino redirector (TikTok bio link)'),
  ('doubledowncasino.com', 'fb-adlib', 'social-casino brand'),
  ('apps4slots.com',      'fb-adlib', 'social-casino brand'),
  ('free247slots.com',    'fb-adlib', 'social-casino brand'),
  ('slotsfree.club',      'fb-adlib', 'social-casino brand'),
  ('slotsfree4u.com',     'fb-adlib', 'social-casino brand'),
  ('games4slots.com',     'fb-adlib', 'social-casino brand'),
  ('slots-blast.com',     'fb-adlib', 'social-casino brand'),
  ('funslotsfree.com',    'fb-adlib', 'social-casino brand')
on conflict (host_suffix) do nothing;
