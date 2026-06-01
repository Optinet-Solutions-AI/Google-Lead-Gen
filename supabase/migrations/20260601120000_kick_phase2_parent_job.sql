-- ============================================================
-- Migration: Kick streamer scraping (Phase 2) — job linkage
--
-- Phase 2 is the operator-triggered browser enrichment of
-- kick.com/{slug}. It runs as a SEPARATE scrape_queue job (it needs
-- a real GoLogin/Chromium session + a country profile lock, unlike
-- Phase 1's pure-HTTP api.kick.com path) but it backfills the
-- kick_streamers rows a *prior* Phase 1 job discovered.
--
-- This column is the only schema change Phase 2 needs:
--   - kick_streamers already reserves every Phase 2 field as nullable
--     (follower_count, *_handle, about_scraped_at, about_fetch_failed).
--   - kick_links.source already accepts 'promo_card' / 'pinned_chat'.
--
-- A Phase 2 job is identified by:
--   search_engine = 'kick' AND parent_scrape_job_id IS NOT NULL
-- The worker uses parent_scrape_job_id to select which streamers to
-- enrich (those with scrape_queue_id = parent and about_scraped_at
-- still NULL). claim_scrape_job returns the whole row, so the new
-- column reaches vm/worker.py with no RPC change. complete_scrape_job
-- already handles the empty-results case (Phase 2 writes no leads).
-- ============================================================

alter table public.scrape_queue
  add column if not exists parent_scrape_job_id uuid
    references public.scrape_queue(id) on delete set null;

comment on column public.scrape_queue.parent_scrape_job_id is
  'Set on Kick Phase-2 enrichment jobs: the Phase-1 scrape_queue job whose '
  'kick_streamers rows this job backfills (socials, follower_count, promo '
  'cards, pinned chat). NULL for all normal/Phase-1 jobs.';

-- Partial index: the worker / UI only ever filter on this when it is set.
create index if not exists idx_scrape_queue_parent_job
  on public.scrape_queue (parent_scrape_job_id)
  where parent_scrape_job_id is not null;
