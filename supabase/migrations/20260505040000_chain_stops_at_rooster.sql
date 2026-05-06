-- ============================================================
-- Migration: Auto-chain stops at Rooster — S-tags + Contacts manual only
--
-- Operator request: the auto-enrichment pipeline should only run the
-- three cheap classifier stages (Monday check → Affiliate → Rooster)
-- end-to-end. The two heavier stages (S-tag extraction, Contact
-- extraction) are now operator-triggered from /scrape/[id]:
--
--   ✓ Monday duplicate check  — auto, in-DB
--   ✓ Affiliate detection     — auto
--   ✓ Rooster partner check   — auto, last in chain
--   • S-tag extraction        — MANUAL (▶ on /scrape/[id])
--   • Contact extraction      — MANUAL (▶ on /scrape/[id])
--
-- Chain transition map (terminal status = 'complete'):
--   pending / null  → affiliate_running
--   affiliate_running → rooster_running
--   rooster_running → complete
--
-- Backwards compatibility: legacy jobs already in 'all_running' or
-- 'contact_running' (from the previous chain) are treated as if they
-- were 'rooster_running' — the chain only waits on rooster, then
-- marks complete. Any in-flight stag/contact queue rows for those
-- legacy jobs keep processing normally; we just don't wait on them.
-- ============================================================

create or replace function public.advance_enrichment_chain(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job             public.scrape_queue;
  v_total           integer;
  v_aff_blocked     integer;
  v_rooster_blocked integer;
  v_now             timestamptz := now();
begin
  select * into v_job from public.scrape_queue where id = p_job_id;
  if v_job.id is null then return null; end if;
  if not v_job.with_enrichment then return v_job.enrichment_status; end if;
  if v_job.status <> 'completed' then return v_job.enrichment_status; end if;
  if v_job.enrichment_status = 'complete' then return 'complete'; end if;

  select count(*) into v_total
  from public.google_lead_gen_table
  where scrape_job_id = p_job_id
    and is_not_relevant = false;

  if v_total = 0 then
    update public.scrape_queue
    set enrichment_status = 'complete', enrichment_completed_at = v_now
    where id = p_job_id;
    return 'complete';
  end if;

  -- ----- Phase 0+1 -----
  if v_job.enrichment_status is null or v_job.enrichment_status = 'pending' then
    perform public.mark_monday_duplicates_for_job(p_job_id);

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true,
           (g.result_type = 'PPC'),
           '["affiliate"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_affiliate_overridden_at is null;

    update public.scrape_queue
    set enrichment_status      = 'affiliate_running',
        enrichment_started_at  = coalesce(enrichment_started_at, v_now)
    where id = p_job_id;
    return 'affiliate_running';
  end if;

  -- ----- Phase 2: wait for affiliate, enqueue rooster (no longer stag/contact) -----
  if v_job.enrichment_status = 'affiliate_running' then
    select count(*) into v_aff_blocked
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.is_affiliate_overridden_at is null
      and g.affiliate_checked_at is null
      and exists (
        select 1 from public.enrichment_fetch_queue q
        where q.lead_id = g.id
          and q.process_stages @> '["affiliate"]'::jsonb
          and q.status in ('pending', 'running', 'paused')
      );

    if v_aff_blocked > 0 then
      return 'affiliate_running';
    end if;

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["rooster"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_rooster_overridden_at is null;

    update public.scrape_queue
    set enrichment_status = 'rooster_running'
    where id = p_job_id;
    return 'rooster_running';
  end if;

  -- ----- Phase 3: wait for rooster, then complete -----
  -- Also catches legacy 'all_running' / 'contact_running' statuses
  -- from before the chain shrank: we only wait on rooster now.
  if v_job.enrichment_status in ('rooster_running', 'all_running', 'contact_running') then
    select count(*) into v_rooster_blocked
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.is_rooster_overridden_at is null
      and g.rooster_checked_at is null
      and exists (
        select 1 from public.enrichment_fetch_queue q
        where q.lead_id = g.id
          and q.process_stages @> '["rooster"]'::jsonb
          and q.status in ('pending', 'running', 'paused')
      );

    if v_rooster_blocked > 0 then
      return v_job.enrichment_status;
    end if;

    update public.scrape_queue
    set enrichment_status = 'complete', enrichment_completed_at = v_now
    where id = p_job_id;
    return 'complete';
  end if;

  return v_job.enrichment_status;
end;
$$;

grant execute on function public.advance_enrichment_chain(uuid) to service_role;
revoke execute on function public.advance_enrichment_chain(uuid) from anon, authenticated;
