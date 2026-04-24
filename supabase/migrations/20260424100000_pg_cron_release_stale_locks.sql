-- ============================================================
-- Migration: pg_cron — automated release of stale scrape locks
--
-- Runs public.release_stale_locks(30) every 5 minutes. If a worker
-- crashed mid-scrape (network drop, VM reboot, Chromium hang) the
-- scrape_queue row stays 'running' with its country lock held.
-- Without this job, the lock only clears when someone notices and
-- calls release_stale_locks() by hand. With it, idle countries
-- auto-recover within 5 minutes after a 30 minute staleness window.
--
-- Requires the pg_cron extension. On Supabase the function lives
-- in the `cron` schema and the underlying types live in `extensions`.
--
-- If this migration errors out with "permission denied" or
-- "schema cron does not exist", enable pg_cron via the Supabase
-- dashboard:
--   Database → Extensions → search for "pg_cron" → Enable
-- …then re-run the migration.
--
-- Idempotent: the DO block unschedules any prior version of the
-- job before re-scheduling.
-- ============================================================

create extension if not exists pg_cron with schema extensions;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'release-stale-scrape-locks') then
    perform cron.unschedule('release-stale-scrape-locks');
  end if;
end
$$;

select cron.schedule(
  'release-stale-scrape-locks',
  '*/5 * * * *',
  $$select public.release_stale_locks(30)$$
);
