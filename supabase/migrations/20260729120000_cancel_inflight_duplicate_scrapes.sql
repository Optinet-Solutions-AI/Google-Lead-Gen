-- ============================================================
-- Auto-cancel in-flight scrapes that duplicate already-completed work.
--
-- Companion to cancel_orphaned_interactive_checkpoints (20260728120000).
-- Operators kept seeing captcha jobs re-park for keywords that had
-- ALREADY completed on the same country+engine — pure waste, and the
-- source of "already resolved but keeps reappearing". A one-off sweep
-- cleared 98 of these on 2026-07-29; this makes it self-cleaning.
--
-- Rule: cancel a phase-1 row in pending / captcha / needs_human whose
-- exact (lower(keyword), country_code, engine) already has a COMPLETED
-- phase-1 sibling.
--
-- Safeguards:
--   * 'running' is never touched — don't interrupt an active worker.
--   * A 15-minute grace on created_at: a freshly-submitted row (e.g. an
--     intentional "run anyway" override of a completed keyword, or a
--     just-fired scheduled run) is left alone for 15 min so the override
--     isn't instantly killed. Stuck-captcha dupes are always older than
--     that, so they're still caught.
--   * Waiting checkpoints on the cancelled jobs are closed too.
-- ============================================================

create or replace function public.cancel_inflight_duplicate_scrapes()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with dupes as (
    select q.id
    from public.scrape_queue q
    where q.parent_scrape_job_id is null
      and q.status in ('pending', 'captcha', 'needs_human')
      and q.created_at < now() - interval '15 minutes'
      and exists (
        select 1
        from public.scrape_queue c
        where c.parent_scrape_job_id is null
          and c.status = 'completed'
          and c.id <> q.id
          and lower(c.keyword) = lower(q.keyword)
          and c.country_code = q.country_code
          and coalesce(c.search_engine, 'google') = coalesce(q.search_engine, 'google')
      )
  )
  update public.scrape_queue q
  set status        = 'cancelled',
      error_message = 'auto-cancelled: duplicate of an already-completed scrape',
      completed_at  = now(),
      updated_at    = now()
  from dupes d
  where q.id = d.id;

  get diagnostics v_count = row_count;

  -- Close any waiting checkpoints attached to the rows we just cancelled.
  update public.interactive_checkpoints ic
  set status          = 'cancelled',
      resolved_at     = now(),
      resolved_by     = 'auto-dedupe',
      resolution_note = 'duplicate of an already-completed scrape'
  from public.scrape_queue q
  where ic.job_id = q.id
    and ic.status = 'waiting'
    and q.status = 'cancelled'
    and q.error_message = 'auto-cancelled: duplicate of an already-completed scrape';

  return v_count;
end;
$$;

grant execute on function public.cancel_inflight_duplicate_scrapes() to service_role;
revoke execute on function public.cancel_inflight_duplicate_scrapes() from anon, authenticated;
