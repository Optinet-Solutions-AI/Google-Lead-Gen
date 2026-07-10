-- ============================================================
-- YouTube channel-level Monday-match column (parity with every other
-- platform's parent table).
--
-- commit 7934ae5 ("dedicated On Monday column across every platform
-- table") extended the results-page row query + table to read a
-- channel-level youtube_channels.is_known_on_monday — on the stated
-- assumption that "row-level is_known_on_monday was already in every
-- platform's DB". That was true for x_creators / tiktok_creators /
-- fb_advertisers / snapchat_creators / telegram_channels /
-- twitch_streamers, but NOT for youtube_channels: youtube_phase23 only
-- ever added is_new_lead_candidate to the parent, and tracked the Monday
-- match per-link on youtube_channel_links.
--
-- Result: fetchYoutubeChannelRows' SELECT threw 42703 (column does not
-- exist), which crashed the whole /scrape/[id] render — EVERY YouTube job
-- result page 500'd ("This page couldn't load"). Reported by Darren
-- 2026-07-10 (batches 1823/1825: the scrapes succeeded — 28 and 7
-- channels — but the page never loaded, so it read as "no results").
--
-- This adds the missing column so the parent-table read resolves, and the
-- Phase-3 scorer (runYoutubeChannelAnalysis) now populates it — mirroring
-- kick_streamers (20260709140000) and twitch_streamers. Additive +
-- idempotent: nullable, no default, so Phase-1/2 insert paths are
-- untouched and already-scored channels simply read null ("—") until
-- re-scored.
-- ============================================================

alter table public.youtube_channels
  add column if not exists is_known_on_monday boolean;

comment on column public.youtube_channels.is_known_on_monday is
  'Phase-3 channel-level Monday verdict: true = channel @handle already '
  'on a Monday board, false = likely affiliate whose handle is NOT on '
  'Monday, null = unscored / not a likely affiliate / handle too short to '
  'check. Populated by runYoutubeChannelAnalysis.';
