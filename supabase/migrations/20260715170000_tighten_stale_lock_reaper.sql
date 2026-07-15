-- ============================================================
-- Tighten the stale-lock reaper back to 30 min, now that the worker
-- heartbeats its lock.
--
-- 20260715150000 widened release_stale_locks to 75 min as a stopgap so
-- the reaper couldn't kill a live 65-min scrape (the worker never moved
-- locked_at). With the vm/worker.py LockHeartbeat now advancing
-- locked_at every 5 min (commit aceedc3 + touch_active_profile_lock in
-- 20260715160000), a live worker keeps its lock fresh, so the reaper can
-- go back to a tight 30-min window and detect genuinely dead workers
-- fast again — a dead worker stops heartbeating and its lock ages out in
-- ~30 min instead of 75.
--
-- Heartbeat interval (5 min) << reaper window (30 min): a live worker
-- can miss several consecutive heartbeats and still never be reaped.
--
-- Only the cron argument changes; the function body (from 20260715150000)
-- is already correct.
-- ============================================================

do $$
begin
  if exists (select 1 from cron.job where jobname = 'release-stale-scrape-locks') then
    perform cron.unschedule('release-stale-scrape-locks');
  end if;
end $$;

select cron.schedule(
  'release-stale-scrape-locks',
  '*/5 * * * *',
  $$select public.release_stale_locks(30)$$
);
