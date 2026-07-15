-- ============================================================
-- Safety net: reclaim ORPHANED needs_human locks.
--
-- Bug (Supriya, 2026-07-15): NZ and IE per-country scrape slots
-- were being permanently consumed by jobs stuck in 'needs_human'
-- with their active_profile_lock never released.
--
-- Root cause: the checkpoint-timeout -> lock-release handoff is
-- entirely worker-driven. scraper.py flips the checkpoint to
-- 'timed_out', then worker.py is supposed to call
-- mark_scrape_job_captcha_terminal() to route the job terminal AND
-- delete the lock. If the worker dies in that window (OOM/restart,
-- routine on the 8GB VMs), the checkpoint ends up 'timed_out' but
-- the job is left 'needs_human' holding its lock forever.
--
-- release_stale_locks() was meant to be the backstop, but its HITL
-- exception skipped EVERY 'needs_human' job unconditionally — so an
-- orphaned park (no live checkpoint, no worker coming back) was
-- never reclaimed. Each dead-worker park permanently subtracted one
-- slot from that country's max_concurrent_per_country (default 3),
-- so throughput decayed until the country stalled.
--
-- Fix: the HITL exception now protects a 'needs_human' job ONLY
-- while it still has a checkpoint in 'waiting' status (a human can
-- still act on it). Once every checkpoint is terminal
-- (resolved / timed_out / cancelled / superseded), the lock is
-- orphaned and gets reclaimed exactly like
-- mark_scrape_job_captcha_terminal would: job -> terminal 'captcha',
-- lock deleted. The operator can then Re-queue when ready.
--
-- Healthy parks are unaffected: while a checkpoint is 'waiting' the
-- job is still skipped, regardless of lock age (the worker's own TTL
-- — captcha_solver_ttl_minutes — owns that window and marks the job
-- terminal itself on expiry).
-- ============================================================

drop function if exists public.release_stale_locks(integer);

create or replace function public.release_stale_locks(p_max_age_minutes integer default 30)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count       integer := 0;
  v_lock        record;
  v_status      text;
  v_has_waiting boolean;
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
        -- Live checkpoint? A human can still act — leave it parked
        -- (the worker's TTL owns this window).
        select exists (
          select 1 from public.interactive_checkpoints
          where job_id = v_lock.job_id and status = 'waiting'
        ) into v_has_waiting;

        if coalesce(v_has_waiting, false) then
          continue;
        end if;

        -- Orphaned park: no waiting checkpoint, no worker returning.
        -- Route terminal + drop the lock (mirror of
        -- mark_scrape_job_captcha_terminal) so the country slot frees.
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

      -- Normal stuck 'running' scrape worker.
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

    -- Release THIS lock only (per 20260526020000: never clobber
    -- healthy sibling locks for the same country).
    delete from public.active_profile_locks where job_id = v_lock.job_id;
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

grant execute on function public.release_stale_locks(integer) to service_role;
revoke execute on function public.release_stale_locks(integer) from anon, authenticated;
