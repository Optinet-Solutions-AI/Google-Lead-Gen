-- ============================================================
-- Migration: Add top_n_by_follower to scrape_queue
--
-- Optional per-scrape cap for channel-based engines (Twitch first,
-- Kick/YouTube/TikTok/X/Snapchat to follow platform-by-platform once
-- each is validated). Semantics: when non-null AND the engine
-- supports it, the scraper fetches all raw candidates, ranks by
-- follower_count DESC, keeps ONLY the top N (discards the tail
-- entirely), then does the expensive enrichment (VODs/clips/panels)
-- + DB insert on the survivors. NULL = existing behaviour (keep
-- everything the search returned).
--
-- Nullable + no default = zero-risk change: every existing row and
-- future non-channel scrape (Google/Bing/etc.) stays NULL and the
-- worker treats it as "no cap".
--
-- User-facing on the /scrape enqueue form as "Top N by followers"
-- (Twitch-only for now; visibility gated in the client).
-- ============================================================

alter table public.scrape_queue
  add column if not exists top_n_by_follower integer;

comment on column public.scrape_queue.top_n_by_follower is
  'Optional per-scrape cap for channel-based engines. When set, the '
  'scraper ranks all raw candidates by follower_count DESC and keeps '
  'only the top N (discards the tail). NULL = keep everything. '
  'Currently honoured by Twitch only; extend platform-by-platform.';
