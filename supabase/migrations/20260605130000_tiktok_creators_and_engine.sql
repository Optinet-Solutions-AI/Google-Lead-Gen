-- ============================================================
-- Migration: TikTok creator scraping (Phase 1 + 2 + 3)
--
-- Adds:
--   1. 'tiktok' as an allowed value in scrape_queue.search_engine.
--   2. tiktok_creators — one row per TikTok account discovered via a
--      keyword scrape of the hashtag (tiktok.com/tag/{kw}) + user-search
--      (tiktok.com/search/user?q={kw}) surfaces, enriched per-profile with
--      a browser scrape of tiktok.com/@{handle}.
--   3. tiktok_links — one row per affiliate/tracking URL found on a
--      creator's surfaces (the profile bio link + URLs in recent video
--      captions), resolved + S-tag-parsed + checked against Monday.
--      Mirrors x_links / kick_links.
--
-- Why TikTok differs from X:
--   - X is login-walled (needs a burner account + is_x_logged_in flag).
--     A recon probe (2026-06-05) confirmed TikTok serves the profile,
--     hashtag and user-search surfaces LOGGED-OUT through the AU resi
--     proxy — no login wall, no captcha — with all data in the page's
--     __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON. So TikTok runs the no-login
--     browser path (like Kick/Facebook): NO login-state column, NO
--     companion login migration, NO login pre-check in the enrich action.
--   - Casino affiliates don't advertise on TikTok (gambling ads banned),
--     so discovery is the ORGANIC surface, and the key affiliate signal is
--     the profile's single bio link (linktr.ee / heylink / a shortener /
--     a casino redirector) — captured as a tiktok_links row source='bio_link'.
--
-- Phase 1 (tiktok_search.py) fills: username, profile_url,
--   discovered_from_keyword, and display_name/bio when the surface exposes
--   them. Phase 2 (tiktok_profile_scrape.py) backfills: bio, bio_link,
--   follower_count, verified, recent video captions, and the 'bio_link' /
--   'video_caption' rows in tiktok_links. Phase 3 (runTiktokCreatorAnalysis,
--   inline) sets is_likely_affiliate / niche_score / contacts /
--   is_known_on_monday / is_new_lead_candidate and resolves tiktok_links.
--
-- New-vs-known check mirrors X/YouTube: TikTok bio links are usually
-- redirectors/hubs with no in-URL stag, so Phase 3 keys the Monday check on
-- the resolved operator brand AND on the creator's @handle (username).
--
-- Additive only — new tables + new enum value; every Phase 2/3 column is
-- nullable with no default, so the Phase 1 insert path is unaffected.
-- ============================================================

-- 1. Allow 'tiktok' alongside the existing engines.
alter table public.scrape_queue
  drop constraint if exists scrape_queue_search_engine_check;

alter table public.scrape_queue
  add constraint scrape_queue_search_engine_check
  check (search_engine in ('google', 'bing', 'youtube', 'twitch', 'kick', 'x', 'facebook', 'tiktok'));


-- 2. tiktok_creators
create table if not exists public.tiktok_creators (
  id uuid primary key default gen_random_uuid(),
  scrape_queue_id uuid references public.scrape_queue(id) on delete cascade,

  -- Account identity. username is the @handle (stored without the leading @);
  -- profile_url is always tiktok.com/@{username}. user_id is TikTok's stable
  -- numeric id (stored as text — it overflows int4) when the profile scrape
  -- captures it.
  user_id text,
  username text not null,
  profile_url text not null,

  -- Discovery context — which keyword surfaced this creator, and from which
  -- surface ('hashtag' | 'search').
  discovered_from_keyword text not null,
  discovered_from_surface text,

  -- Profile metadata. Phase 1 may capture display_name; Phase 2 backfills the
  -- rest from the rendered profile page's rehydration JSON.
  display_name text,
  bio text,
  bio_link text,                 -- the single profile link (the funnel)
  follower_count bigint,
  following_count bigint,
  video_count bigint,
  heart_count bigint,            -- total likes across the account
  verified boolean,
  -- Recent video captions captured in Phase 2 — extra keyword/link surface
  -- for the scorer.
  recent_video_captions text[],
  about_scraped_at timestamptz,
  about_fetch_failed boolean default false,

  -- Phase 3 — affiliate scoring + outreach contacts + new-vs-known verdict
  -- (mirrors x_creators / kick_streamers).
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

create index if not exists idx_tiktok_creators_scrape_queue_id
  on public.tiktok_creators (scrape_queue_id);

create index if not exists idx_tiktok_creators_username
  on public.tiktok_creators (lower(username));

-- A partial index over creators worth surfacing for outreach (mirrors the
-- x_creators new-lead-candidate index). Cheap — only flagged rows.
create index if not exists idx_tiktok_creators_new_lead_candidate
  on public.tiktok_creators (scrape_queue_id)
  where is_new_lead_candidate is true;


-- 3. tiktok_links — affiliate/tracking links mined from a creator's surfaces.
-- Phase 2 sources: 'bio_link' (the profile link), 'video_caption' (URLs in
-- recent video captions). Phase 3 resolves shorteners + parses S-tags +
-- checks each against Monday. Mirrors x_links / kick_links.
create table if not exists public.tiktok_links (
  id uuid primary key default gen_random_uuid(),
  tiktok_creator_id uuid not null
    references public.tiktok_creators(id) on delete cascade,

  url text not null,
  source text not null
    check (source in ('bio_link', 'video_caption')),

  -- Phase 3 — shortener / redirect resolution (bit.ly, tny.sh, the affiliate
  -- /go/ redirector, etc.). Joins to the same resolver helpers the
  -- x_links + kick_links + lead s-tag pipelines use.
  resolved_url text,
  resolved_at  timestamptz,

  -- Phase 3 — S-tag parsed from the resolved URL's query params.
  -- s_tag_param is which key it came from (btag/stag/cxd/mid/affid).
  s_tag       text,
  s_tag_param text,
  brand       text,

  -- Phase 3 — new-vs-known verdict from search_s_tag_on_monday(s_tag||brand).
  is_known_on_monday   boolean,
  monday_match_kind    text,   -- 'item' | 'updates' | null
  monday_match_item_id text,

  created_at timestamptz not null default now()
);

create index if not exists idx_tiktok_links_creator_id
  on public.tiktok_links (tiktok_creator_id);

create index if not exists idx_tiktok_links_url
  on public.tiktok_links (url);

-- "Have we seen this S-tag?" — case-insensitive, mirrors idx_x_links_s_tag.
create index if not exists idx_tiktok_links_s_tag
  on public.tiktok_links (lower(s_tag));


-- 4. Touch updated_at on tiktok_creators updates so Phase 2/3 backfills
-- surface as recent activity.
create or replace function public.touch_tiktok_creators_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_tiktok_creators_updated_at on public.tiktok_creators;
create trigger trg_tiktok_creators_updated_at
  before update on public.tiktok_creators
  for each row execute function public.touch_tiktok_creators_updated_at();
