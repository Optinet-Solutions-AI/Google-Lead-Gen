-- ============================================================
-- Migration: add missing FK index on scrape_queue.scheduled_run_id
--
-- Bug (BUGS.md R2-31)
-- -------------------
-- scrape_queue.scheduled_run_id is declared as
--     uuid references public.scheduled_keyword_sets(id)
--         on delete set null
-- but has no index. Postgres doesn't auto-index FK columns, so every
-- delete of a scheduled set triggered a full scrape_queue sequential
-- scan to null out matching rows. scrape_queue is one of the largest
-- tables in the schema and this column is also touched in scheduler-
-- tick join paths, so the missing index hits two hot paths.
--
-- Fix
-- ---
-- Add a partial index — only rows with a non-null FK actually matter
-- for the ON DELETE SET NULL cascade and for joins. Partial indexes
-- stay small (most scrape_queue rows are ad-hoc, no scheduled_run_id)
-- and the planner can still use them whenever a query filters on
-- scheduled_run_id with an equality test.
--
-- CONCURRENTLY so the index build doesn't take an ACCESS EXCLUSIVE
-- lock on the running table. Must run outside a transaction block —
-- the Management API's /database/query endpoint executes each
-- statement individually, so this is safe to apply via
-- apply-migration.ts.
--
-- Apply with:
--   tsx scripts/db/apply-migration.ts --apply \
--     supabase/migrations/20260518000000_scrape_queue_scheduled_run_id_index.sql
-- (omit --apply for a dry-run preview)
-- ============================================================

create index concurrently if not exists scrape_queue_scheduled_run_id_idx
  on public.scrape_queue (scheduled_run_id)
  where scheduled_run_id is not null;
