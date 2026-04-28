-- ============================================================
-- Migration: Dedicated rooster_brands table
--
-- The legacy "Rooster partner check" used a hard-coded list of
-- ~10–20 brand domains (n8n env var $vars.ROOSTER_PARTNER_DOMAINS).
-- We were temporarily reading from affiliates_table, but that's
-- wrong — affiliates_table holds every third-party affiliate site
-- ever tracked on Monday (~7000), most of which AREN'T our brands.
--
-- This migration creates a dedicated rooster_brands table and seeds
-- it with the user's curated list (2026-04-28).
-- ============================================================

create table if not exists public.rooster_brands (
  id              bigint      generated always as identity primary key,
  domain          text        not null unique,
  brand_name      text,
  notes           text,
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.rooster_brands enable row level security;

create index if not exists idx_rooster_brands_active
  on public.rooster_brands (is_active)
  where is_active = true;

-- ------------------------------------------------------------
-- Seed: user-provided brand list (2026-04-28)
-- ------------------------------------------------------------
insert into public.rooster_brands (domain, brand_name) values
  ('lucky7even.com',         'Lucky7Even'),
  ('lucky7even.org',         'Lucky7Even'),
  ('lucky7even21.com',       'Lucky7Even'),
  ('spinjo.com',             'SpinJo'),
  ('spinjo.live',            'SpinJo'),
  ('rocketspin.com',         'RocketSpin'),
  ('rocketspin.live',        'RocketSpin'),
  ('luckyvibe.com',          'LuckyVibe'),
  ('luckyvibe.live',         'LuckyVibe'),
  ('rollero.com',            'Rollero'),
  ('rollero.live',           'Rollero'),
  ('rooster.bet',            'Rooster.bet'),
  ('roosterbet.live',        'Rooster.bet'),
  ('fortuneplay.com',        'FortunePlay'),
  ('fortuneplay.co',         'FortunePlay'),
  ('spinsup.com',            'SpinsUp'),
  ('spinsup.live',            'SpinsUp'),
  ('playmojo.com',           'PlayMojo'),
  ('playmojo.live',          'PlayMojo'),
  ('novadreams.com',         'NovaDreams'),
  ('novadreams.live',        'NovaDreams'),
  ('roosterpartner.media',   'Rooster Partners'),
  ('roosterspartners.media', 'Rooster Partners'),
  ('roosterpartners.media',  'Rooster Partners'),
  ('mediaroosters.com',      'Rooster Partners'),
  ('rooster-partner.com',    'Rooster Partners'),
  ('roosters-partner.com',   'Rooster Partners'),
  ('roosterspartners.com',   'Rooster Partners'),
  ('rooster-partners.com',   'Rooster Partners')
on conflict (domain) do nothing;

-- ------------------------------------------------------------
-- Replace list_rooster_brand_domains() to query the new table
-- ------------------------------------------------------------
create or replace function public.list_rooster_brand_domains()
returns table(domain text, brand_name text, monday_item_id text)
language sql
stable
security definer
set search_path = public
as $$
  select domain, brand_name, null::text as monday_item_id
    from public.rooster_brands
   where is_active = true
     and domain is not null
     and domain <> ''
   order by brand_name nulls last, domain;
$$;

grant execute on function public.list_rooster_brand_domains() to service_role;
revoke execute on function public.list_rooster_brand_domains() from anon, authenticated;
