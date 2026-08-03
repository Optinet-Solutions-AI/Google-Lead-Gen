-- ============================================================
-- Fix: the duplicate-scrape dedupe sweep must NOT cancel scrapes that
-- are deliberately SCHEDULED for the future (QA 2026-08-03: operators
-- schedule a scrape for tomorrow, but cancel_inflight_duplicate_scrapes
-- kills it as a "duplicate of an already-completed scrape" because the
-- same keyword ran before).
--
-- A future-scheduled run is intentional (operator wants fresh data at
-- that time) — the dedupe sweep should only ever cancel scrapes that are
-- due NOW (scheduled_at null or already past). Add that guard to the
-- CTE; everything else is unchanged.
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
      -- Never cancel a run that's deliberately scheduled for the future.
      and (q.scheduled_at is null or q.scheduled_at <= now())
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
