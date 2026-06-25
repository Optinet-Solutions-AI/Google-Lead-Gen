-- ============================================================
-- Twitch engine tables — full schema + parity with the other
-- s_tag/Monday engines (youtube / x / tiktok / snapchat / telegram).
--
-- Twitch was the FIRST streaming engine scaffolded (migration
-- 20260522120000, 2026-05-22) but stalled before its VM scraper was
-- ever written. That original migration was never applied to the
-- production DB (twitch was never used, so the missing tables went
-- unnoticed) — so this migration CREATES the tables if they don't
-- exist yet, and ALTERs in the parity columns if a Phase-1-only
-- version already exists. Idempotent either way.
--
-- It deliberately does NOT touch the scrape_queue.search_engine check
-- constraint: prod already allows 'twitch' (the snapchat/telegram
-- migrations include it in the list). Re-running the original 2026-05-22
-- migration would WRONGLY narrow that list and break the newer engines —
-- do not do that.
--
-- lib/monday/engine-config.ts declares twitch with linkBrandCol:'brand'
-- + linkHasStag:true, and the inline Phase-3 scorer
-- (runTwitchStreamerAnalysis) follows the snapchat/telegram pattern:
-- resolve shorteners -> parse S-tag/brand -> check Monday -> new-vs-known
-- verdict. That flow needs the brand / s_tag / monday columns below.
--
-- Twitch captures NO contacts by design (emailCol:null in engine-config
-- -- the API exposes no parseable email/socials), so contact columns are
-- deliberately omitted.
-- ============================================================

-- 1. twitch_streamers — one row per broadcaster from a Helix
-- /search/channels keyword search, enriched (same pass) with /users +
-- /videos + /clips + gql About-panels. follower_count / total_view_count
-- are nullable + always NULL (unobtainable with an app access token).
create table if not exists public.twitch_streamers (
  id uuid primary key default gen_random_uuid(),
  scrape_queue_id uuid references public.scrape_queue(id) on delete cascade,

  broadcaster_id text not null,
  broadcaster_login text not null,
  display_name text,
  broadcaster_url text not null,
  profile_image_url text,
  broadcaster_language text,
  account_created_at timestamptz,

  discovered_from_keyword text not null,
  is_live boolean,
  game_name text,
  stream_title text,
  tags text[],

  follower_count bigint,
  total_view_count bigint,

  recent_vod_descriptions text[],
  recent_clip_descriptions text[],

  bio text,
  panels_scraped_at timestamptz,
  panels_fetch_failed boolean default false,

  -- Phase 3 — affiliate scoring + new-vs-known verdict.
  is_likely_affiliate boolean,
  niche_score numeric(5,2),
  is_known_on_monday boolean,
  is_new_lead_candidate boolean,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_twitch_streamers_scrape_queue_id
  on public.twitch_streamers (scrape_queue_id);
create index if not exists idx_twitch_streamers_broadcaster_id
  on public.twitch_streamers (broadcaster_id);
create index if not exists idx_twitch_streamers_new_lead_candidate
  on public.twitch_streamers (scrape_queue_id)
  where is_new_lead_candidate is true;

-- 2. twitch_links — one row per URL captured from a streamer's panels /
-- VOD descriptions / clip titles / bio / stream title. Phase 3 resolves
-- shorteners + parses S-tag/brand + checks Monday.
create table if not exists public.twitch_links (
  id uuid primary key default gen_random_uuid(),
  twitch_streamer_id uuid not null
    references public.twitch_streamers(id) on delete cascade,

  url text not null,
  source text not null
    check (source in ('panel','vod_description','clip_description','bio','stream_title')),

  panel_title text,
  panel_description text,
  source_video_id text,

  resolved_url text,
  resolved_at timestamptz,

  brand                text,
  s_tag                text,
  s_tag_param          text,
  is_known_on_monday   boolean,
  monday_match_kind    text,   -- 'item' | 'updates' | null
  monday_match_item_id text,

  created_at timestamptz not null default now()
);

create index if not exists idx_twitch_links_streamer_id
  on public.twitch_links (twitch_streamer_id);
create index if not exists idx_twitch_links_url
  on public.twitch_links (url);
create index if not exists idx_twitch_links_s_tag
  on public.twitch_links (lower(s_tag));

-- 3. touch updated_at on twitch_streamers updates.
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

-- 4. Upgrade path: if a Phase-1-only twitch_streamers / twitch_links
-- already exists (e.g. on a DB where the 2026-05-22 migration ran), add
-- the parity columns it's missing. No-ops on a freshly-created table above.
alter table public.twitch_links
  add column if not exists brand                text,
  add column if not exists s_tag                text,
  add column if not exists s_tag_param          text,
  add column if not exists is_known_on_monday   boolean,
  add column if not exists monday_match_kind    text,
  add column if not exists monday_match_item_id text;

alter table public.twitch_streamers
  add column if not exists is_known_on_monday    boolean,
  add column if not exists is_new_lead_candidate boolean;
