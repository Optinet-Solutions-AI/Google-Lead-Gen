-- ============================================================
-- Bulk re-runs are exempt from the duplicate auto-cancel.
--
-- Operators legitimately re-scrape the same keywords every day (fresh
-- SERP each day), and admins re-run whole batches in bulk. But
-- cancel_inflight_duplicate_scrapes() cancels any pending row whose
-- (keyword, country, engine) already has a COMPLETED sibling — which is
-- true BY DEFINITION for a daily re-run — so every bulk re-run was being
-- auto-killed 15 minutes after it queued.
--
-- Fix: skip rows flagged is_rerun. A re-run is an intentional recovery /
-- refresh of already-completed work; it must never be treated as an
-- accidental duplicate. Genuine accidental dupes (stuck-captcha rows that
-- keep re-parking for an already-done keyword) are NOT re-runs, so they're
-- still caught and cancelled exactly as before.
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
      -- Bulk re-runs / intentional daily re-scrapes are exempt: they are
      -- expected to duplicate a completed sibling and must not be killed.
      and coalesce(q.is_rerun, false) = false
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
