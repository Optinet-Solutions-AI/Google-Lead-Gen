-- ============================================================
-- Short-TTL HITL + manual re-queue workflow.
--
-- Previously, when a scrape hit a captcha and HITL was enabled, the
-- worker blocked in a 15-minute polling loop. With 3 workers and 3
-- simultaneous captchas, the whole fleet sat idle for 15 minutes
-- waiting for a human to click Resume. captcha_scrape_job's existing
-- auto-retry path (up to 10 attempts) didn't help — it would just
-- cycle through the same captcha 10 times burning proxy quota with
-- no human in the loop.
--
-- New model:
--   1. Worker hits captcha → creates interactive checkpoint with a
--      SHORT TTL (default 2 min, configurable via
--      system_settings.hitl_ttl_minutes).
--   2. If the operator clicks Resume in those 2 min → unchanged: job
--      continues, status flips back to 'running'.
--   3. If 2 min elapses → checkpoint flips to 'timed_out', job goes
--      to terminal 'captcha' status WITHOUT bumping captcha_attempts
--      (so the auto-retry counter never runs HITL jobs to death).
--      Worker releases the lock and immediately picks up the next
--      job.
--   4. When the operator is ready, they click "Re-queue with HITL" on
--      the timed-out checkpoint card. That flips the original job
--      back to 'pending' with fresh counters; a worker re-claims it,
--      re-fetches the page, hits the captcha again, fresh 2-min HITL
--      window.
--
-- This way each captcha costs at most 2 minutes of one worker's
-- time, and human reaction time is fully decoupled from worker
-- availability.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Seed configurable TTL. Already-installed system_settings table
--    from 20260519020000_system_settings.sql.
-- ------------------------------------------------------------
insert into public.system_settings (key, value)
values ('hitl_ttl_minutes', '2'::jsonb)
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 2. timeout_interactive_checkpoint — flips a 'waiting' checkpoint
--    to 'timed_out' when the worker's TTL expires. Idempotent: any
--    row not in 'waiting' status is left alone.
-- ------------------------------------------------------------
create or replace function public.timeout_interactive_checkpoint(p_id bigint)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  update public.interactive_checkpoints
  set status     = 'timed_out',
      updated_at = now()
  where id = p_id
    and status = 'waiting';
end;
$$;

revoke execute on function public.timeout_interactive_checkpoint(bigint) from public, anon, authenticated;
grant execute on function public.timeout_interactive_checkpoint(bigint) to service_role;

-- ------------------------------------------------------------
-- 3. mark_scrape_job_captcha_terminal — sets a scrape_queue job to
--    terminal 'captcha' WITHOUT bumping captcha_attempts and WITHOUT
--    flipping back to 'pending'. Used by the worker when an HITL
--    checkpoint times out, so operators can manually re-queue when
--    they're ready instead of the system auto-cycling.
-- ------------------------------------------------------------
create or replace function public.mark_scrape_job_captcha_terminal(
  p_job_id uuid,
  p_error  text default null
) returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  update public.scrape_queue
  set status        = 'captcha',
      completed_at  = now(),
      claimed_by    = null,
      error_message = coalesce(p_error, 'HITL timed out without operator action'),
      updated_at    = now()
  where id = p_job_id
    and status in ('running', 'needs_human');

  delete from public.active_profile_locks where job_id = p_job_id;
end;
$$;

revoke execute on function public.mark_scrape_job_captcha_terminal(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_scrape_job_captcha_terminal(uuid, text) to service_role;

-- ------------------------------------------------------------
-- 4. requeue_scrape_after_hitl — operator-triggered manual re-queue
--    of an HITL-timed-out (or any captcha/failed/cancelled) job.
--    Clears every "this attempt is finished" field so the row looks
--    fresh to the next worker that claims it. Resets captcha_attempts
--    so the auto-retry counter doesn't immediately terminate the job
--    again on the next captcha.
-- ------------------------------------------------------------
create or replace function public.requeue_scrape_after_hitl(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_prior_status text;
begin
  select status into v_prior_status
  from public.scrape_queue
  where id = p_job_id;

  if v_prior_status is null then
    raise exception 'scrape_queue row % not found', p_job_id using errcode = 'P0002';
  end if;

  if v_prior_status not in ('captcha', 'failed', 'cancelled', 'needs_human') then
    raise exception 'cannot re-queue job in status %', v_prior_status using errcode = '22023';
  end if;

  update public.scrape_queue
  set status            = 'pending',
      claimed_by        = null,
      started_at        = null,
      completed_at      = null,
      error_message     = null,
      attempts          = 0,
      captcha_attempts  = 0,
      updated_at        = now()
  where id = p_job_id;

  delete from public.active_profile_locks where job_id = p_job_id;

  return coalesce(v_prior_status, 'unknown');
end;
$$;

revoke execute on function public.requeue_scrape_after_hitl(uuid) from public, anon;
grant execute on function public.requeue_scrape_after_hitl(uuid) to authenticated, service_role;
