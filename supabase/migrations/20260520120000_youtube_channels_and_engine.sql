-- ============================================================
-- Migration: YouTube affiliate-channel scraping (Phase 1)
--
-- Adds:
--   1. 'youtube' as an allowed value in scrape_queue.search_engine
--      so a job can be queued with engine='youtube'.
--   2. youtube_channels table — one row per channel surfaced by
--      a YouTube Data API search, linked back to the originating
--      scrape_queue job. Same shape as leads.scrape_queue_id but
--      stored separately because the YouTube schema (channel_id,
--      subscriber_count, etc.) doesn't fit the URL/domain-oriented
--      leads model — see CLAUDE.md / [[youtube-scraping-ownership]].
--
-- Phase 1 stores only the search-step output: channel identity +
-- metadata. The contact-info fields (email/phone/socials) and the
-- affiliate-scoring fields are included as nullable so Phase 2/3
-- can backfill without another migration.
-- ============================================================

-- 1. Allow 'youtube' alongside 'google' and 'bing'
alter table public.scrape_queue
  drop constraint if exists scrape_queue_search_engine_check;

alter table public.scrape_queue
  add constraint scrape_queue_search_engine_check
  check (search_engine in ('google', 'bing', 'youtube'));


-- 2. youtube_channels table
create table if not exists public.youtube_channels (
  id uuid primary key default gen_random_uuid(),
  scrape_queue_id uuid references public.scrape_queue(id) on delete cascade,

  -- Channel identity (from YouTube Data API search.list + channels.list)
  channel_id text not null,
  channel_url text not null,
  channel_name text,
  channel_handle text,
  channel_description text,

  -- Discovery context — which keyword/video surfaced this channel
  discovered_from_keyword text not null,
  discovered_video_id text,
  discovered_video_title text,

  -- Channel-level metadata (filled by a channels.list follow-up call
  -- when subscriber/view/video counts are needed; nullable so
  -- Phase 1 can ship with just search.list data if quota is tight)
  subscriber_count bigint,
  video_count bigint,
  view_count bigint,
  country text,
  published_at timestamptz,
  thumbnail_url text,

  -- Phase 2 — contact extraction from channel About tab.
  -- All NULL in Phase 1, populated by a later enrichment step.
  email text,
  phone text,
  website_url text,
  twitter_url text,
  instagram_url text,
  tiktok_url text,
  about_tab_scraped_at timestamptz,
  about_tab_captcha_blocked boolean default false,

  -- Phase 3 — affiliate signal scoring.
  -- recent_video_descriptions captured cheaply in Phase 1 (it's a
  -- byproduct of search.list); scoring happens in Phase 3.
  is_likely_affiliate boolean,
  niche_score numeric(5,2),
  recent_video_descriptions text[],

  -- Audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Lookups by job (the worker writes batches per scrape_queue_id)
create index if not exists idx_youtube_channels_scrape_queue_id
  on public.youtube_channels (scrape_queue_id);

-- Dedup / "have we seen this channel before?" queries across jobs
create index if not exists idx_youtube_channels_channel_id
  on public.youtube_channels (channel_id);

-- Touch updated_at on every row change so Phase 2 contact-extraction
-- backfills surface as "recent activity" without hand-stamping.
create or replace function public.touch_youtube_channels_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_youtube_channels_updated_at on public.youtube_channels;
create trigger trg_youtube_channels_updated_at
  before update on public.youtube_channels
  for each row execute function public.touch_youtube_channels_updated_at();
