-- ============================================================
-- Migration: add the AU "*96" casino-affiliate network to the
-- operator domains denylist.
--
-- These domains surfaced as the ad destinations of the AU Facebook
-- Ad Library gambling advertisers (the sugar96/skystar96/… network +
-- its redirector landing domains). They are casino OPERATORS, but
-- weren't in operator_domains_denylist, so:
--   1. isAffiliateCasinoLink() returned false for them — the FB
--      contact harvester then mistook the operator's support@ address
--      for the advertiser's own contact (wrong outreach party).
--   2. The affiliate scorer didn't count links to them as casino
--      links, weakening the affiliate signal.
--
-- Adding them fixes both: their support@ emails are now skipped, and
-- advertisers pointing ads at them score as the affiliates they are.
-- Bare host suffixes — the matcher prepends `//` and `.` so subdomain
-- variants match without false-hitting unrelated hosts.
-- ============================================================
insert into public.operator_domains_denylist (host_suffix, added_by, note) values
  ('sugar96.com',     'fb-adlib', 'AU *96 casino-affiliate network'),
  ('skystar96.com',   'fb-adlib', 'AU *96 casino-affiliate network'),
  ('candy96.co',      'fb-adlib', 'AU *96 casino-affiliate network'),
  ('iplay77.com',     'fb-adlib', 'AU *96 casino-affiliate network'),
  ('race96.com',      'fb-adlib', 'AU *96 casino-affiliate network'),
  ('v6aus.com',       'fb-adlib', 'AU casino-affiliate redirector'),
  ('igaustralia.us',  'fb-adlib', 'AU casino-affiliate redirector'),
  ('audgo.co',        'fb-adlib', 'AU casino-affiliate redirector'),
  ('coincasino.click','fb-adlib', 'AU casino-affiliate redirector')
on conflict (host_suffix) do nothing;
