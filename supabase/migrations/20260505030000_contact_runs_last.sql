-- ============================================================
-- Migration: Contact extraction runs LAST in the enrichment chain
--
-- Previously the orchestrator enqueued rooster + contact + stag in
-- parallel (the 'all_running' phase) and waited for all three before
-- marking the chain complete. This change splits contact out into
-- its own final phase so it only runs after the cheaper classifier
-- stages (Monday check → Affiliate → Rooster + Stag) have finished.
--
-- New chain order:
--   1. monday_check    (Phase 0, in-DB)
--   2. affiliate       (Phase 1, enrichment_status='affiliate_running')
--   3. rooster + stag  (Phase 2, enrichment_status='all_running')
--   4. (s_tag_check)   (manual / data-driven, not chain-gated)
--   5. contacts        (Phase 3, enrichment_status='contact_running')
--   6. complete        (enrichment_status='complete')
--
-- Same eligibility rules as before for each stage; just reordered.
-- The 'all_running' label is preserved (rather than renamed) so old
-- jobs already in that state advance correctly on the next chain tick.
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
  v_other_blocked   integer;
  v_stag_blocked    integer;
  v_contact_blocked integer;
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

  -- ----- Phase 2: rooster + stag (no longer contact) -----
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

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["stag"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_affiliate = true
      and g.is_stag_overridden_at is null;

    update public.scrape_queue
    set enrichment_status = 'all_running'
    where id = p_job_id;
    return 'all_running';
  end if;

  -- ----- Phase 3: wait for rooster + stag, THEN enqueue contact -----
  if v_job.enrichment_status = 'all_running' then
    select count(*) into v_other_blocked
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

    select count(*) into v_stag_blocked
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.is_affiliate = true
      and g.is_stag_overridden_at is null
      and g.s_tags_checked_at is null
      and exists (
        select 1 from public.enrichment_fetch_queue q
        where q.lead_id = g.id
          and q.process_stages @> '["stag"]'::jsonb
          and q.status in ('pending', 'running', 'paused')
      );

    if v_other_blocked > 0 or v_stag_blocked > 0 then
      return 'all_running';
    end if;

    -- Rooster + stag done; now enqueue contact for every still-eligible
    -- lead and advance to the contact phase.
    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["contact"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_contact_overridden_at is null;

    update public.scrape_queue
    set enrichment_status = 'contact_running'
    where id = p_job_id;
    return 'contact_running';
  end if;

  -- ----- Phase 4: wait for contact, then complete -----
  if v_job.enrichment_status = 'contact_running' then
    select count(*) into v_contact_blocked
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.is_contact_overridden_at is null
      and g.contact_checked_at is null
      and exists (
        select 1 from public.enrichment_fetch_queue q
        where q.lead_id = g.id
          and q.process_stages @> '["contact"]'::jsonb
          and q.status in ('pending', 'running', 'paused')
      );

    if v_contact_blocked > 0 then
      return 'contact_running';
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
