-- ============================================================
-- Migration: Kick streamer outreach-contact fields (Phase 3)
--
-- The Phase 1/2 pipeline already qualifies a streamer (is_likely_affiliate,
-- niche_score) and captures their socials + casino promo links. This adds
-- the columns the OUTREACH step needs — "how do we contact this streamer?" —
-- in the priority order from the outreach playbook: email > Telegram >
-- Discord > social handles (socials already exist as *_handle columns).
--
-- These are backfilled INLINE by the Phase 3 "Score & resolve" action
-- (runKickStreamerAnalysis), which mines them out of data already in the
-- DB — channel_description / stream_title (from the api.kick.com fetch in
-- Phase 1) and the promo_card / pinned_chat kick_links (from the Phase 2
-- browser scrape). No new scrape is required, so re-running scoring on an
-- existing job fills these in retroactively.
--
-- Additive only — every column is nullable with no default, so existing
-- rows and the Phase 1/2 insert paths are unaffected.
-- ============================================================

alter table public.kick_streamers
  add column if not exists contact_email text,
  add column if not exists telegram_url  text,
  add column if not exists discord_url   text;

-- A partial index over the three contact columns: the leads workflow wants
-- "show me streamers I can actually reach", which is a NOT-NULL scan on any
-- of these. Cheap — only rows that have at least one contact are indexed.
create index if not exists idx_kick_streamers_has_contact
  on public.kick_streamers (scrape_queue_id)
  where contact_email is not null
     or telegram_url is not null
     or discord_url is not null;
