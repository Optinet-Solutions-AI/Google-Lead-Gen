-- ============================================================
-- Migration: YouTube channel Phase 2 (contacts) + Phase 3 (scoring /
-- affiliate-ID check)
--
-- Phase 1 (20260520120000) already reserved most Phase 2/3 fields on
-- youtube_channels as nullable: email, phone, website_url, the social
-- *_url columns, about_tab_scraped_at, about_tab_captcha_blocked,
-- is_likely_affiliate, niche_score, recent_video_descriptions. This
-- migration adds the few things that build still needs:
--
--   1. telegram_url / discord_url on youtube_channels. The outreach
--      playbook's contact priority is email > Telegram > Discord >
--      socials; Phase 1 reserved the socials but not these two.
--   2. is_new_lead_candidate — Phase 3's verdict for a channel: a likely
--      affiliate carrying at least one affiliate S-tag NOT already known
--      on Monday. The operator reviews these (no auto lead-creation in v1).
--   3. youtube_channel_links — one row per affiliate/tracking link mined
--      from a channel's recent_video_descriptions, resolved to its final
--      destination and parsed for an S-tag. Mirrors kick_links. Each row
--      also records whether its S-tag is already on Monday (the
--      new-vs-known check, via search_s_tag_on_monday).
--
-- A YouTube Phase 2 enrichment job is identified the same way Kick's is:
--   search_engine = 'youtube' AND parent_scrape_job_id IS NOT NULL
-- scrape_queue.parent_scrape_job_id already exists (added by the Kick
-- Phase 2 migration 20260601120000) and is reused as-is — no schema or
-- constraint change to scrape_queue.
--
-- Additive only — every column is nullable with no default, so existing
-- rows and the Phase 1 insert path are unaffected.
-- ============================================================

-- 1. Contact + verdict columns on youtube_channels.
alter table public.youtube_channels
  add column if not exists telegram_url          text,
  add column if not exists discord_url           text,
  add column if not exists is_new_lead_candidate boolean;

-- 2. youtube_channel_links — affiliate/tracking links mined from video
-- descriptions, resolved + S-tag-parsed + checked against Monday.
create table if not exists public.youtube_channel_links (
  id uuid primary key default gen_random_uuid(),
  youtube_channel_id uuid not null
    references public.youtube_channels(id) on delete cascade,

  url text not null,
  -- Source surface. Only 'video_description' today; left open (with a
  -- check) so a later phase can add 'about_links' / 'pinned_comment' etc.
  source text not null
    check (source in ('video_description')),

  -- Phase 3 — shortener / redirect resolution (linktr.ee, bit.ly, the
  -- affiliate /go/ redirector, etc.). Joins to the same resolver helpers
  -- the kick_links + lead s-tag pipelines use.
  resolved_url text,
  resolved_at  timestamptz,

  -- Phase 3 — S-tag parsed from the resolved URL's query params.
  -- s_tag_param is which key it came from (btag/stag/cxd/mid/affid) — the
  -- param identifies the affiliate program, same as s_tags_table.
  s_tag       text,
  s_tag_param text,
  brand       text,

  -- Phase 3 — new-vs-known verdict from search_s_tag_on_monday(s_tag).
  is_known_on_monday   boolean,
  monday_match_kind    text,   -- 'item' | 'updates' | null
  monday_match_item_id text,

  created_at timestamptz not null default now()
);

-- Lookups by channel (Phase 3 loads a job's channels then their links).
create index if not exists idx_youtube_channel_links_channel_id
  on public.youtube_channel_links (youtube_channel_id);

-- "Have we seen this S-tag?" — case-insensitive, mirrors idx_s_tags_value.
create index if not exists idx_youtube_channel_links_s_tag
  on public.youtube_channel_links (lower(s_tag));

-- A partial index over channels worth surfacing for outreach: the leads
-- workflow wants "show me new affiliate channels I can act on". Cheap —
-- only flagged rows are indexed.
create index if not exists idx_youtube_channels_new_lead_candidate
  on public.youtube_channels (scrape_queue_id)
  where is_new_lead_candidate is true;
