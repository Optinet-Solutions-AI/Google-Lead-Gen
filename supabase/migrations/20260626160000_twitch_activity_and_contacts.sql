-- ============================================================
-- Migration: Twitch recency + contact capture
--
-- From Andrei's 2026-06-26 Twitch lead-gen feedback:
--   1. ~80% of 'casino'/'slots' results last streamed 2–8 years ago.
--   2. Channels with email/Telegram contact info weren't being picked up.
--
-- twitch_search.py now derives a last_activity_at (newest VOD/highlight,
-- newest clip, or live-now) and drops channels whose KNOWN last activity is
-- older than TWITCH_MAX_INACTIVE_DAYS, and mines email/Telegram/Discord out of
-- the bio + About-panels + descriptions. This adds the columns those values
-- land in. Mirrors the contact columns the Kick / X / TikTok engines already
-- carry (contact_email / telegram_url / discord_url) for a uniform schema.
--
-- Additive + idempotent — safe to paste into the Supabase SQL editor.
-- ============================================================

alter table public.twitch_streamers
  add column if not exists last_activity_at timestamptz,
  add column if not exists contact_email text,
  add column if not exists telegram_url text,
  add column if not exists discord_url text;

comment on column public.twitch_streamers.last_activity_at is
  'Freshest activity signal at scrape time: newest VOD/highlight publish, '
  'newest clip, or live-now. NULL = no signal (kept anyway). Channels older '
  'than TWITCH_MAX_INACTIVE_DAYS are dropped before insert.';

-- Surfacing/sorting the freshest streamers first in the results view.
create index if not exists idx_twitch_streamers_last_activity_at
  on public.twitch_streamers (last_activity_at desc nulls last);
