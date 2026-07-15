-- ============================================================
-- Lock heartbeat RPC.
--
-- Companion to the vm/worker.py LockHeartbeat thread: advances a job's
-- active_profile_locks.locked_at so release_stale_locks() (the pg_cron
-- reaper) can distinguish a LIVE worker still mid-scrape from a DEAD
-- one. With this in place the reaper window can be tightened back down
-- (see 20260715170000) without false-killing legitimate long scrapes.
--
-- Called by the worker on the service_role key every
-- LOCK_HEARTBEAT_INTERVAL_S while a job is in flight.
-- ============================================================

create or replace function public.touch_active_profile_lock(p_job_id uuid)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.active_profile_locks
  set locked_at = now()
  where job_id = p_job_id;
$$;

revoke execute on function public.touch_active_profile_lock(uuid) from public, anon, authenticated;
grant execute on function public.touch_active_profile_lock(uuid) to service_role;
