-- TikTok Phase-1 discovery (tiktok_search.py) wrote creators with a plain
-- INSERT and there was no unique constraint on (scrape_queue_id, username).
-- A job that committed its rows and was then re-dispatched (completion failed
-- or its lock was released while attempts < max_attempts → requeued) would
-- double-insert the same creators, inflating discovered/affiliate counts and
-- re-enriching duplicates on a second GoLogin session.
--
-- Fix: dedupe any rows that already slipped through, then add a unique
-- constraint so the upsert in tiktok_search.py (on_conflict =
-- scrape_queue_id,username, ignore-duplicates) is a no-op on re-dispatch.
--
-- ORDERING: apply this BEFORE deploying the tiktok_search.py upsert change —
-- the upsert references this constraint and errors without it.

-- 1) Collapse existing duplicates: keep one row per (scrape_queue_id, username),
--    preferring an enriched row (about_scraped_at set), else the lowest id.
delete from public.tiktok_creators a
using public.tiktok_creators b
where a.scrape_queue_id = b.scrape_queue_id
  and a.username = b.username
  and a.id <> b.id
  and (
    (a.about_scraped_at is null and b.about_scraped_at is not null)
    or (
      (a.about_scraped_at is null) = (b.about_scraped_at is null)
      and a.id > b.id
    )
  );

-- 2) Enforce one creator per job going forward.
create unique index if not exists uq_tiktok_creators_job_username
  on public.tiktok_creators (scrape_queue_id, username);
