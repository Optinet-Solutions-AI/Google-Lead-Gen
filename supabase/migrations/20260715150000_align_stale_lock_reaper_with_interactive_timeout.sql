-- ============================================================
-- Align the stale-lock reaper with the worker's real max runtime.
--
-- Bug (Supriya, 2026-07-15, follow-up): after the orphaned-lock fix
-- (20260715120000) her Google gambling scrapes STILL failed — many
-- with "Worker timed out (lock held > 30 min)" and NO captcha
-- checkpoint at all.
--
-- Root cause: timeout misalignment. With the captcha solver enabled,
-- a worker is allowed to run a single scrape for up to
-- INTERACTIVE_TIMEOUT_S = 3900s (65 min). But the pg_cron reaper
-- called release_stale_locks(30) — and the worker NEVER refreshes
-- active_profile_locks.locked_at during a scrape (it's stamped once
-- at claim). So any scrape that legitimately runs past 30 min (10
-- pages x both views on a slow resi proxy, common for gambling
-- queries) had its lock yanked mid-flight and the still-running job
-- marked failed. The reaper — meant only to recover DEAD workers —
-- was killing LIVE ones.
--
-- Fix:
--   1. Reschedule the cron to release_stale_locks(75). 75 > the
--      worker's own 65-min interactive timeout (+10 min margin for
--      the 5-min cron granularity), so the worker's own timeout
--      always governs a live scrape and the reaper is a true
--      backstop for genuinely dead workers only.
--   2. Harden the needs_human HITL exception: skip a parked job only
--      while it has a checkpoint that is BOTH status='waiting' AND
--      not past expires_at (a human can still act). A 'waiting'
--      checkpoint left behind by a dead worker (nothing flips it —
--      only the worker calls timeout_interactive_checkpoint) is now
--      treated as orphaned once expired, so raising the reaper window
--      can't let a dead-worker park hold a country slot indefinitely.
--
-- Trade-off: a worker that dies mid-'running'-scrape now holds its
-- country slot for up to 75 min (was 30) before the backstop frees
-- it. Acceptable vs. the current behaviour of failing live work.
-- Proper long-term fix = a lock heartbeat in worker.py (refresh
-- locked_at every N min) so the reaper window can drop back to ~30;
-- tracked separately.
-- ============================================================

drop function if exists public.release_stale_locks(integer);

create or replace function public.release_stale_locks(p_max_age_minutes integer default 75)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count    integer := 0;
  v_lock     record;
  v_status   text;
  v_has_live boolean;
begin
  for v_lock in (
    select country_code, job_id, job_kind
    from public.active_profile_locks
    where locked_at < now() - (p_max_age_minutes || ' minutes')::interval
  ) loop

    if v_lock.job_kind = 'scrape' then
      select status into v_status
      from public.scrape_queue
      where id = v_lock.job_id;

      if v_status = 'needs_human' then
        -- Protect a park ONLY while a human still has a live window:
        -- a checkpoint that is 'waiting' AND not yet past expires_at.
        -- Once every checkpoint is terminal OR the last 'waiting' one
        -- has expired (e.g. left dangling by a dead worker), the lock
        -- is orphaned and gets reclaimed.
        select exists (
          select 1 from public.interactive_checkpoints
          where job_id = v_lock.job_id
            and status = 'waiting'
            and expires_at > now()
        ) into v_has_live;

        if coalesce(v_has_live, false) then
          continue;
        end if;

        update public.scrape_queue
        set status        = 'captcha',
            completed_at  = now(),
            claimed_by    = null,
            error_message = 'Captcha checkpoint expired without operator action — orphaned lock reclaimed after '
                            || p_max_age_minutes || ' min. Open the row menu and click "Try again" to re-queue.',
            updated_at    = now()
        where id = v_lock.job_id and status = 'needs_human';

        delete from public.active_profile_locks where job_id = v_lock.job_id;
        v_count := v_count + 1;
        continue;
      end if;

      -- Normal stuck 'running' scrape worker (dead > p_max_age_minutes).
      update public.scrape_queue
      set status        = case when attempts < max_attempts then 'pending' else 'failed' end,
          claimed_by    = null,
          started_at    = null,
          error_message = 'Worker timed out (lock held > ' || p_max_age_minutes || ' min)',
          updated_at    = now()
      where id = v_lock.job_id and status = 'running';

    elsif v_lock.job_kind = 'enrichment' then
      update public.enrichment_fetch_queue
      set status        = case when attempts < max_attempts then 'pending' else 'failed' end,
          claimed_by    = null,
          started_at    = null,
          error_message = 'Worker timed out (lock held > ' || p_max_age_minutes || ' min)',
          updated_at    = now()
      where id = v_lock.job_id and status = 'running';
    end if;

    delete from public.active_profile_locks where job_id = v_lock.job_id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

grant execute on function public.release_stale_locks(integer) to service_role;
revoke execute on function public.release_stale_locks(integer) from anon, authenticated;

-- ------------------------------------------------------------
-- Reschedule the pg_cron reaper to the aligned 75-min window.
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'release-stale-scrape-locks') then
    perform cron.unschedule('release-stale-scrape-locks');
  end if;
end $$;

select cron.schedule(
  'release-stale-scrape-locks',
  '*/5 * * * *',
  $$select public.release_stale_locks(75)$$
);
