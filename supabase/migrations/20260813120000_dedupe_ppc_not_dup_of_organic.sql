-- ============================================================
-- The PPC half of a split batch is NOT a duplicate of its Organic half.
--
-- A Google/Bing batch fans out into an Organic (Apify) job and a PPC (VM)
-- job with the SAME keyword/country/engine but different work. The Organic
-- half ships in seconds; then the auto-dedupe saw a "completed sibling with
-- the same keyword/country/engine" and cancelled the still-pending PPC half
-- as a duplicate. Result: PPC never ran — 53 of 72 PPC jobs since Aug 5 were
-- auto-cancelled (operators: "organic completed, ppc nothing / autocancelled").
--
-- Fix: a pending row is only a duplicate of a completed sibling with the SAME
-- result_type_filter (Organic dupes Organic, PPC dupes PPC), and never of a
-- sibling in the SAME batch_group (the two halves of one batch). Genuine
-- same-type dupes (stuck-captcha re-parks of an already-done Organic/PPC job)
-- are still caught. Re-runs stay exempt (is_rerun, from 20260812130000).
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
          -- Only a SAME result-type sibling is a real duplicate. The Organic
          -- (apify) and PPC (vm) halves of one batch share keyword/country/
          -- engine but are different work, so a completed Organic must never
          -- cancel a pending PPC (or vice versa). Legacy rows (null) map to
          -- 'both' and still dedupe against each other as before.
          and coalesce(c.result_type_filter, 'both') = coalesce(q.result_type_filter, 'both')
          -- Belt-and-suspenders: never treat the other half of the SAME split
          -- batch as a duplicate.
          and (c.batch_group_id is null or q.batch_group_id is null
               or c.batch_group_id <> q.batch_group_id)
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
