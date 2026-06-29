-- ============================================================
-- Migration: YouTube channel last-upload recency
--
-- Gemma's 2026-06-27 feedback: YouTube results include channels that haven't
-- uploaded in years (the same dead-channel problem Andrei reported for Twitch).
-- youtube_search.py now reads each channel's newest upload (via its uploads
-- playlist) into last_video_at and drops channels whose last upload predates
-- YOUTUBE_MAX_INACTIVE_DAYS before insert. This adds the column it lands in.
--
-- NOTE: published_at already exists but is the channel CREATION date, not the
-- last upload — it can't answer "has this channel uploaded recently".
--
-- Additive + idempotent — safe to paste into the Supabase SQL editor.
-- ============================================================

alter table public.youtube_channels
  add column if not exists last_video_at timestamptz;

comment on column public.youtube_channels.last_video_at is
  'Publish time of the channel''s newest upload at scrape time (from its '
  'uploads playlist). NULL = no measurable last upload (kept anyway). Channels '
  'older than YOUTUBE_MAX_INACTIVE_DAYS are dropped before insert.';

create index if not exists idx_youtube_channels_last_video_at
  on public.youtube_channels (last_video_at desc nulls last);
