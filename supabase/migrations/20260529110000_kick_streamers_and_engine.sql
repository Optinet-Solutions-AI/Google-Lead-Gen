-- ============================================================
-- Migration: Kick streamer scraping (Phase 1)
--
-- Adds:
--   1. 'kick' as an allowed value in scrape_queue.search_engine.
--   2. kick_streamers — one row per channel discovered via a
--      keyword scrape of kick.com/search, enriched per-channel
--      with api.kick.com /public/v1/channels. Phase 1 fills
--      everything the API exposes. Phase 2 fills socials, the
--      follower count, and the chat pinned message via a real
--      browser scrape of kick.com/{slug}.
--   3. kick_links — one row per URL discovered on a streamer's
--      surfaces (channel_description, stream_title, promo card
--      banner, chat pinned message). Joins to the existing
--      shortener-resolver pipeline via resolved_url.
--
-- Why the discovery/enrichment split differs from Twitch:
--   - kick.com (HTML) sits behind Cloudflare and rejects raw
--     HTTP from non-browser clients with a 403. Discovery and
--     panel-equivalent scraping therefore require real Chrome
--     through GoLogin, same as the Google/Bing scrapers.
--   - api.kick.com is open with an App Access Token
--     (Client Credentials grant; 60-day token lifetime).
--     Returns identity, description, stream metadata, category,
--     tags, subscribers — but NOT social handles, NOT promo
--     banners, NOT follower count, NOT chat pinned messages.
--
-- Phase 1 populates: every NOT NULL field plus channel_description,
-- category_*, stream_* fields, custom_tags, subscriber counts.
-- Phase 2 backfills: follower_count, *_handle social columns,
-- about_scraped_at, and the 'promo_card' / 'pinned_chat' rows
-- in kick_links.
-- ============================================================

-- 1. Allow 'kick' alongside google / bing / youtube / twitch
alter table public.scrape_queue
  drop constraint if exists scrape_queue_search_engine_check;

alter table public.scrape_queue
  add constraint scrape_queue_search_engine_check
  check (search_engine in ('google', 'bing', 'youtube', 'twitch', 'kick'));


-- 2. kick_streamers
create table if not exists public.kick_streamers (
  id uuid primary key default gen_random_uuid(),
  scrape_queue_id uuid references public.scrape_queue(id) on delete cascade,

  -- Channel identity (from api.kick.com /public/v1/channels).
  -- broadcaster_user_id is the canonical numeric ID across Kick;
  -- slug is the URL handle (kick.com/{slug}).
  broadcaster_user_id bigint not null,
  slug text not null,
  channel_url text not null,
  banner_picture text,

  -- Discovery context — which keyword surfaced this streamer.
  -- Browser-scraped from kick.com/search?q={keyword}.
  discovered_from_keyword text not null,

  -- Channel-level metadata (from api.kick.com).
  -- channel_description is the full About paragraph — Kick has no
  -- separate bio field. Long-form, may contain embedded URLs.
  channel_description text,
  category_id integer,
  category_name text,
  active_subscribers_count integer,
  canceled_subscribers_count integer,

  -- Current stream metadata (snapshot at scrape time, from api.kick.com).
  -- Nullable because not every channel is live when discovered.
  is_live boolean,
  is_mature boolean,
  stream_language text,
  stream_title text,
  stream_started_at timestamptz,
  stream_viewer_count integer,
  stream_thumbnail text,
  custom_tags text[],

  -- Phase 2 — fields only available via browser scrape of
  -- kick.com/{slug}. NULL in Phase 1.
  follower_count bigint,
  instagram_handle text,
  twitter_handle text,
  facebook_handle text,
  youtube_handle text,
  tiktok_handle text,
  about_scraped_at timestamptz,
  about_fetch_failed boolean default false,

  -- Phase 3 — affiliate signal scoring (mirrors twitch_streamers).
  is_likely_affiliate boolean,
  niche_score numeric(5,2),

  -- Audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_kick_streamers_scrape_queue_id
  on public.kick_streamers (scrape_queue_id);

create index if not exists idx_kick_streamers_broadcaster_user_id
  on public.kick_streamers (broadcaster_user_id);

create index if not exists idx_kick_streamers_slug
  on public.kick_streamers (slug);


-- 3. kick_links — one row per URL discovered on a streamer's
-- surfaces. Phase 1 sources are 'channel_description' and
-- 'stream_title' (both come from the API text). Phase 2 adds
-- 'promo_card' (the casino bonus banners on the about page)
-- and 'pinned_chat' (the moderator-pinned chat message that
-- typically holds the affiliate link in plain text).
create table if not exists public.kick_links (
  id uuid primary key default gen_random_uuid(),
  kick_streamer_id uuid not null
    references public.kick_streamers(id) on delete cascade,

  url text not null,
  source text not null
    check (source in ('channel_description', 'stream_title', 'promo_card', 'pinned_chat')),

  -- Promo-card-specific (NULL unless source='promo_card').
  -- The casino bonus banners on a streamer's about page —
  -- promo_brand='Tsars', promo_bonus_terms='150% UP TO €300, WAGER: 30x'.
  promo_brand text,
  promo_bonus_terms text,

  -- Phase 3 — shortener expansion (linktr.ee, bit.ly, etc.)
  resolved_url text,
  resolved_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists idx_kick_links_streamer_id
  on public.kick_links (kick_streamer_id);

create index if not exists idx_kick_links_url
  on public.kick_links (url);


-- 4. Touch updated_at on kick_streamers updates so Phase 2/3
-- backfills surface as recent activity.
create or replace function public.touch_kick_streamers_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_kick_streamers_updated_at on public.kick_streamers;
create trigger trg_kick_streamers_updated_at
  before update on public.kick_streamers
  for each row execute function public.touch_kick_streamers_updated_at();
