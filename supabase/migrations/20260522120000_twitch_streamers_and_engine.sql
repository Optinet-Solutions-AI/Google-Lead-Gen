-- ============================================================
-- Migration: Twitch streamer scraping (Phase 1)
--
-- Adds:
--   1. 'twitch' as an allowed value in scrape_queue.search_engine.
--   2. twitch_streamers — one row per channel returned by a Helix
--      /search/channels keyword search, enriched with /users +
--      /videos + /clips. Nullable columns reserved for Phase 2
--      (GraphQL panels) and Phase 3 (affiliate scoring) so those
--      phases ship without another migration.
--   3. twitch_links — one row per URL extracted from a streamer's
--      VOD descriptions, clip descriptions, panels, bio, or stream
--      title. Joins to the existing URL/shortener-resolver pipeline.
--
-- Phase 1 populates: twitch_streamers (full row except bio/panels)
-- and twitch_links (only source in ('vod_description','clip_description',
-- 'stream_title')). Panel rows arrive in Phase 2 via GraphQL.
-- ============================================================

-- 1. Allow 'twitch' alongside google / bing / youtube
alter table public.scrape_queue
  drop constraint if exists scrape_queue_search_engine_check;

alter table public.scrape_queue
  add constraint scrape_queue_search_engine_check
  check (search_engine in ('google', 'bing', 'youtube', 'twitch'));


-- 2. twitch_streamers
create table if not exists public.twitch_streamers (
  id uuid primary key default gen_random_uuid(),
  scrape_queue_id uuid references public.scrape_queue(id) on delete cascade,

  -- Channel identity (from Helix /search/channels + /users)
  broadcaster_id text not null,
  broadcaster_login text not null,
  display_name text,
  broadcaster_url text not null,
  profile_image_url text,
  broadcaster_language text,
  account_created_at timestamptz,

  -- Discovery context — which keyword surfaced this streamer
  discovered_from_keyword text not null,
  is_live boolean,
  game_name text,
  stream_title text,
  tags text[],

  -- Channel-level metadata (from /users + /channels/followers).
  -- Nullable so Phase 1 can ship if the follower lookup is rate-limited.
  follower_count bigint,
  total_view_count bigint,

  -- Phase 1: cheap text capture for downstream link/affiliate scoring.
  recent_vod_descriptions text[],
  recent_clip_descriptions text[],

  -- Phase 2 — About panels from gql.twitch.tv. NULL in Phase 1.
  bio text,
  panels_scraped_at timestamptz,
  panels_fetch_failed boolean default false,

  -- Phase 3 — affiliate signal scoring.
  is_likely_affiliate boolean,
  niche_score numeric(5,2),

  -- Audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_twitch_streamers_scrape_queue_id
  on public.twitch_streamers (scrape_queue_id);

create index if not exists idx_twitch_streamers_broadcaster_id
  on public.twitch_streamers (broadcaster_id);


-- 3. twitch_links — one row per URL discovered on a streamer's
-- channel surface. Phase 1 populates vod_description / clip_description
-- / stream_title sources; Phase 2 adds panel + bio sources.
create table if not exists public.twitch_links (
  id uuid primary key default gen_random_uuid(),
  twitch_streamer_id uuid not null
    references public.twitch_streamers(id) on delete cascade,

  url text not null,
  source text not null
    check (source in ('panel','vod_description','clip_description','bio','stream_title')),

  -- Panel-specific (NULL unless source='panel')
  panel_title text,
  panel_description text,

  -- VOD/clip-specific (NULL unless source in vod_description/clip_description)
  source_video_id text,

  -- Phase 3 — shortener expansion (linktr.ee, bit.ly, etc.)
  resolved_url text,
  resolved_at timestamptz,

  created_at timestamptz not null default now()
);

create index if not exists idx_twitch_links_streamer_id
  on public.twitch_links (twitch_streamer_id);

create index if not exists idx_twitch_links_url
  on public.twitch_links (url);


-- 4. Touch updated_at on twitch_streamers updates so Phase 2/3
-- backfills surface as recent activity.
create or replace function public.touch_twitch_streamers_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_twitch_streamers_updated_at on public.twitch_streamers;
create trigger trg_twitch_streamers_updated_at
  before update on public.twitch_streamers
  for each row execute function public.touch_twitch_streamers_updated_at();
