-- ============================================================
-- Kick Phase-3 Monday-match parity (youtube / x / tiktok / snapchat /
-- telegram / twitch already have this).
--
-- The "On Monday" column added across every platform table (2026-07-09)
-- reads a per-row / per-link is_known_on_monday flag that the engine's
-- Phase-3 scoring populates by parsing each affiliate link's S-tag /
-- brand and checking it against Monday (search_s_tag_on_monday). Kick's
-- Phase-3 scorer (runKickStreamerAnalysis) predates that pattern — it
-- only wrote is_likely_affiliate / niche_score — so kick_streamers /
-- kick_links never had the Monday columns and the "On Monday" cell would
-- render "—" everywhere for Kick.
--
-- This adds the missing columns so the inline scorer can emit the same
-- new-vs-known verdict as the twitch scorer it mirrors (twitch's scorer
-- literally wraps scoreKickStreamer). Additive + idempotent — every new
-- column is nullable with no default, so the Phase-1/2 insert paths are
-- untouched.
-- ============================================================

-- 1. kick_links — S-tag / brand parse + per-link Monday match, mirroring
-- twitch_links. resolved_url / resolved_at already exist (Phase 1).
alter table public.kick_links
  add column if not exists brand                text,
  add column if not exists s_tag                text,
  add column if not exists s_tag_param          text,
  add column if not exists is_known_on_monday   boolean,
  add column if not exists monday_match_kind    text,   -- 'item' | 'updates' | null
  add column if not exists monday_match_item_id text;

create index if not exists idx_kick_links_s_tag
  on public.kick_links (lower(s_tag));

-- 2. kick_streamers — row-level new-vs-known verdict, mirroring
-- twitch_streamers. is_likely_affiliate / niche_score already exist.
alter table public.kick_streamers
  add column if not exists is_known_on_monday    boolean,
  add column if not exists is_new_lead_candidate boolean;

create index if not exists idx_kick_streamers_new_lead_candidate
  on public.kick_streamers (scrape_queue_id)
  where is_new_lead_candidate is true;
