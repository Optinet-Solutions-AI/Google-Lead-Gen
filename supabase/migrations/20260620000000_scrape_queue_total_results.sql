-- ============================================================
-- Derived column: scrape_queue.total_results_count
--
-- The /scrape jobs table reads total_results out of the
-- result_summary JSONB blob to render the "Results" cell. Adding a
-- generated INT column lets us filter + sort by it the same way as
-- every other column (advanced-filters URL machinery, JOBS_COLUMNS
-- registry, etc.) — no special JSONB casting in the application
-- layer, no per-call computation.
--
-- The CASE guards against malformed values landing in result_summary
-- so the generated expression never fails during an insert/update.
-- ============================================================

alter table public.scrape_queue
  add column if not exists total_results_count int
    generated always as (
      case
        when result_summary->>'total_results' ~ '^-?[0-9]+$'
          then (result_summary->>'total_results')::int
        else null
      end
    ) stored;

-- Partial index — we mostly filter "jobs that scored 0" or
-- "jobs with N results". A full-column btree is cheap on this table
-- (hundreds of jobs at the time of writing) and worth the speedup
-- on filter+sort queries.
create index if not exists idx_scrape_queue_total_results
  on public.scrape_queue (total_results_count);
