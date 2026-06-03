-- ============================================================
-- Migration: X (x.com / twitter) creator scraping (Phase 1 + 2 + 3)
--
-- Adds:
--   1. 'x' as an allowed value in scrape_queue.search_engine.
--   2. x_creators — one row per X account discovered via a keyword
--      scrape of x.com/search?f=user, enriched per-profile with a
--      browser scrape of x.com/{username}.
--   3. x_links — one row per affiliate/tracking URL found on a
--      creator's surfaces (bio entities, pinned tweet, website),
--      resolved + S-tag-parsed + checked against Monday. Mirrors
--      kick_links / youtube_channel_links.
--
-- Why X differs from Kick/YouTube's Phase-1 split:
--   - Kick (api.kick.com) and YouTube (Data API) have real APIs, so
--     their Phase 1 is pure HTTP. X has NO affordable search API for
--     new developers (Basic/Pro are closed to new accounts; pay-per-use
--     excludes keyword search). So X Phase 1 is the BROWSER path: an
--     authenticated GoLogin/Selenium session navigating
--     x.com/search?q={keyword}&f=user, exactly like the Google/Bing
--     scrapers — NOT a pure-HTTP call. The session must be logged into
--     X (the login wall gates logged-out scraping); see the companion
--     migration 20260603120100_x_login_state.sql for the
--     gologin_profiles.is_x_logged_in flag.
--
-- Phase 1 (x_search.py) fills: username, display_name, profile_url,
--   bio, discovered_from_keyword (UserCell DOM on the People-search tab).
-- Phase 2 (x_profile_scrape.py) backfills: followers/following/tweet
--   counts, location, verified, account_created_at, profile/banner image,
--   website_url, the *_handle socials, pinned_tweet_id/text, and the
--   'bio' / 'pinned_tweet' / 'website' rows in x_links.
-- Phase 3 (runXCreatorAnalysis, inline) sets: is_likely_affiliate,
--   niche_score, contact_email, telegram_url, discord_url,
--   is_known_on_monday, is_new_lead_candidate, and resolves x_links.
--
-- A YouTube/Kick-style "new vs known" check applies: X tracking links are
-- often redirectors with no in-URL stag, so Phase 3 keys the Monday check
-- on the resolved operator brand AND on the creator's @handle (username) —
-- same pattern as runYoutubeChannelAnalysis.
--
-- Additive only — new table + new enum value; every Phase 2/3 column is
-- nullable with no default, so the Phase 1 insert path is unaffected.
-- ============================================================

-- 1. Allow 'x' alongside google / bing / youtube / twitch / kick.
alter table public.scrape_queue
  drop constraint if exists scrape_queue_search_engine_check;

alter table public.scrape_queue
  add constraint scrape_queue_search_engine_check
  check (search_engine in ('google', 'bing', 'youtube', 'twitch', 'kick', 'x'));


-- 2. x_creators
create table if not exists public.x_creators (
  id uuid primary key default gen_random_uuid(),
  scrape_queue_id uuid references public.scrape_queue(id) on delete cascade,

  -- Account identity. user_id is X's stable numeric rest_id (stored as
  -- text — it overflows int4 and we never do arithmetic on it). username
  -- is the @handle (stored without the leading @); profile_url is always
  -- x.com/{username} (the repo renders x.com, never twitter.com — see
  -- commit 4649a7f).
  user_id text,
  username text not null,
  profile_url text not null,

  -- Discovery context — which keyword surfaced this creator (from the
  -- People-search tab x.com/search?q={keyword}&f=user).
  discovered_from_keyword text not null,

  -- Profile metadata. Phase 1 captures display_name + bio from the search
  -- UserCell; Phase 2 backfills the rest from the rendered profile page.
  display_name text,
  bio text,
  location text,
  followers_count bigint,
  following_count bigint,
  tweet_count bigint,
  verified boolean,
  verified_type text,            -- 'blue' | 'business' | 'government' | null
  account_created_at timestamptz,
  profile_image_url text,
  banner_url text,
  pinned_tweet_id text,
  pinned_tweet_text text,

  -- Phase 2 — fields only available on the rendered profile page.
  -- website_url is the UserUrl card; the *_handle columns are OTHER
  -- platforms linked from the bio/website (the creator's own platform is
  -- X, so there is no x_handle column). NULL in Phase 1.
  website_url text,
  instagram_handle text,
  youtube_handle text,
  tiktok_handle text,
  facebook_handle text,
  about_scraped_at timestamptz,
  about_fetch_failed boolean default false,

  -- Phase 3 — affiliate scoring + outreach contacts + new-vs-known verdict
  -- (mirrors kick_streamers + youtube_channels).
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

create index if not exists idx_x_creators_scrape_queue_id
  on public.x_creators (scrape_queue_id);

create index if not exists idx_x_creators_username
  on public.x_creators (lower(username));

create index if not exists idx_x_creators_user_id
  on public.x_creators (user_id);

-- A partial index over creators worth surfacing for outreach (mirrors the
-- youtube_channels new-lead-candidate index). Cheap — only flagged rows.
create index if not exists idx_x_creators_new_lead_candidate
  on public.x_creators (scrape_queue_id)
  where is_new_lead_candidate is true;


-- 3. x_links — affiliate/tracking links mined from a creator's surfaces.
-- Phase 2 sources: 'bio' (bio entities.url), 'pinned_tweet' (URLs in the
-- pinned tweet), 'website' (the UserUrl card). Phase 3 resolves shorteners
-- + parses S-tags + checks each against Monday. Mirrors kick_links and
-- youtube_channel_links.
create table if not exists public.x_links (
  id uuid primary key default gen_random_uuid(),
  x_creator_id uuid not null
    references public.x_creators(id) on delete cascade,

  url text not null,
  source text not null
    check (source in ('bio', 'pinned_tweet', 'website')),

  -- Phase 3 — shortener / redirect resolution (bit.ly, t.co, the
  -- affiliate /go/ redirector, etc.). Joins to the same resolver helpers
  -- the kick_links + youtube + lead s-tag pipelines use.
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

create index if not exists idx_x_links_creator_id
  on public.x_links (x_creator_id);

create index if not exists idx_x_links_url
  on public.x_links (url);

-- "Have we seen this S-tag?" — case-insensitive, mirrors idx_s_tags_value.
create index if not exists idx_x_links_s_tag
  on public.x_links (lower(s_tag));


-- 4. Touch updated_at on x_creators updates so Phase 2/3 backfills surface
-- as recent activity.
create or replace function public.touch_x_creators_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_x_creators_updated_at on public.x_creators;
create trigger trg_x_creators_updated_at
  before update on public.x_creators
  for each row execute function public.touch_x_creators_updated_at();
