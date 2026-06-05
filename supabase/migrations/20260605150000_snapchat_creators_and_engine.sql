-- ============================================================
-- Migration: Snapchat creator scraping (Phase 1 + 3)
--
-- Adds:
--   1. 'snapchat' as an allowed value in scrape_queue.search_engine.
--   2. snapchat_creators — one row per public Snapchat profile discovered
--      via the explore surface (snapchat.com/explore/{keyword}) and
--      enriched in the SAME pass from each profile's __NEXT_DATA__ payload
--      (snapchat.com/@{username}).
--   3. snapchat_links — one row per affiliate/tracking URL on a creator's
--      profile (the websiteUrl / bio link), resolved + S-tag-parsed +
--      checked against Monday. Mirrors tiktok_links / x_links.
--
-- Why Snapchat is the PURE-HTTP path (like Kick/YouTube, NOT the browser
-- engines): a recon probe (2026-06-05, plain VM IP, no GoLogin/proxy)
-- confirmed snapchat.com/explore/{kw} AND snapchat.com/@{handle} return
-- HTTP 200 with all data in a server-rendered __NEXT_DATA__ JSON blob —
-- no login wall, no JS execution needed. So there is NO GoLogin profile,
-- NO Selenium, NO is_*_logged_in flag, and (because profile fetch is cheap
-- HTTP) NO separate Phase-2 enrichment job: snapchat_search.py discovers
-- AND enriches in one pass, like the single-pass Facebook engine. Phase 3
-- (runSnapchatCreatorAnalysis, inline) scores + resolves links + checks
-- Monday.
--
-- New-vs-known check mirrors X/TikTok: Snapchat bio links are usually
-- hubs/redirectors with no in-URL stag, so Phase 3 keys the Monday check on
-- the resolved operator brand AND on the creator's @handle (username).
--
-- Additive only — new tables + new enum value; every Phase 3 column is
-- nullable with no default, so the Phase 1 insert path is unaffected.
-- ============================================================

-- 1. Allow 'snapchat' alongside the existing engines.
alter table public.scrape_queue
  drop constraint if exists scrape_queue_search_engine_check;

alter table public.scrape_queue
  add constraint scrape_queue_search_engine_check
  check (search_engine in ('google', 'bing', 'youtube', 'twitch', 'kick', 'x', 'facebook', 'tiktok', 'snapchat'));


-- 2. snapchat_creators
create table if not exists public.snapchat_creators (
  id uuid primary key default gen_random_uuid(),
  scrape_queue_id uuid references public.scrape_queue(id) on delete cascade,

  -- Account identity. username is the handle (stored without the leading @);
  -- profile_url is always snapchat.com/@{username}. user_id is Snapchat's
  -- stable id (text) when the profile payload exposes it.
  user_id text,
  username text not null,
  profile_url text not null,

  -- Discovery context — which keyword surfaced this creator.
  discovered_from_keyword text not null,

  -- Profile metadata, captured in the same pass from the profile's
  -- __NEXT_DATA__ payload (display name, bio, the website/bio link funnel,
  -- subscriber count, snap-star/verified flag).
  display_name text,
  bio text,
  bio_link text,                 -- the profile's websiteUrl (the funnel)
  subscriber_count bigint,
  is_snap_star boolean,

  -- Phase 3 — affiliate scoring + outreach contacts + new-vs-known verdict
  -- (mirrors tiktok_creators / x_creators).
  is_likely_affiliate boolean,
  niche_score numeric(5,2),
  contact_email text,
  telegram_url text,
  discord_url text,
  is_known_on_monday boolean,
  is_new_lead_candidate boolean,

  -- Audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_snapchat_creators_scrape_queue_id
  on public.snapchat_creators (scrape_queue_id);

create index if not exists idx_snapchat_creators_username
  on public.snapchat_creators (lower(username));

create index if not exists idx_snapchat_creators_new_lead_candidate
  on public.snapchat_creators (scrape_queue_id)
  where is_new_lead_candidate is true;


-- 3. snapchat_links — affiliate/tracking links from a creator's profile.
-- Source 'bio_link' (the websiteUrl). Phase 3 resolves shorteners + parses
-- S-tags + checks Monday. Mirrors tiktok_links / x_links.
create table if not exists public.snapchat_links (
  id uuid primary key default gen_random_uuid(),
  snapchat_creator_id uuid not null
    references public.snapchat_creators(id) on delete cascade,

  url text not null,
  source text not null
    check (source in ('bio_link')),

  resolved_url text,
  resolved_at  timestamptz,

  s_tag       text,
  s_tag_param text,
  brand       text,

  is_known_on_monday   boolean,
  monday_match_kind    text,   -- 'item' | 'updates' | null
  monday_match_item_id text,

  created_at timestamptz not null default now()
);

create index if not exists idx_snapchat_links_creator_id
  on public.snapchat_links (snapchat_creator_id);

create index if not exists idx_snapchat_links_url
  on public.snapchat_links (url);

create index if not exists idx_snapchat_links_s_tag
  on public.snapchat_links (lower(s_tag));


-- 4. Touch updated_at on snapchat_creators updates so Phase 3 scoring
-- surfaces as recent activity.
create or replace function public.touch_snapchat_creators_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_snapchat_creators_updated_at on public.snapchat_creators;
create trigger trg_snapchat_creators_updated_at
  before update on public.snapchat_creators
  for each row execute function public.touch_snapchat_creators_updated_at();
