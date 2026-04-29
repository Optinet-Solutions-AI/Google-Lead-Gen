-- ============================================================
-- Migration: Unstall the enrichment-chain orchestrator
--
-- Bug: advance_enrichment_chain counted a stage as "done for a lead"
-- only if the lead had `<stage>_checked_at` set (or a manual override).
-- A lead whose enrichment_fetch_queue row hit max_attempts and went
-- to status='failed' would never get the timestamp, so the chain stalled
-- in `affiliate_running` (or `all_running`) forever — the badge kept
-- saying "enriching" even though no worker would ever pick the row up.
--
-- Fix: a stage is "blocked" only when the lead has no override / no
-- timestamp AND there's at least one enrichment_fetch_queue row for
-- that stage in pending / running / paused. Failed / cancelled /
-- completed-but-untimestamped rows are considered terminal and
-- the chain can advance past them.
--
-- Also adds force_complete_enrichment(uuid) as a manual escape hatch
-- exposed via the /scrape kebab → "Force complete enrichment" button.
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
  v_now             timestamptz := now();
begin
  select * into v_job from public.scrape_queue where id = p_job_id;
  if v_job.id is null then return null; end if;
  if not v_job.with_enrichment then return v_job.enrichment_status; end if;
  if v_job.status <> 'completed' then return v_job.enrichment_status; end if;
  if v_job.enrichment_status = 'complete' then return 'complete'; end if;

  select count(*) into v_total
  from public.google_lead_gen_table
  where scrape_job_id = p_job_id;

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
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_affiliate_overridden_at is null;

    update public.scrape_queue
    set enrichment_status      = 'affiliate_running',
        enrichment_started_at  = coalesce(enrichment_started_at, v_now)
    where id = p_job_id;
    return 'affiliate_running';
  end if;

  -- ----- Phase 2 -----
  -- Count leads still actively blocked on affiliate (no override, no
  -- timestamp, and a non-terminal queue row exists). If zero, advance.
  if v_job.enrichment_status = 'affiliate_running' then
    select count(*) into v_aff_blocked
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
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

    -- Enqueue rooster + contact (all rows) + stag (affiliate=true only).
    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["rooster"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_rooster_overridden_at is null;

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["contact"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_contact_overridden_at is null;

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["stag"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_affiliate = true
      and g.is_stag_overridden_at is null;

    update public.scrape_queue
    set enrichment_status = 'all_running'
    where id = p_job_id;
    return 'all_running';
  end if;

  -- ----- Phase 3 -----
  -- Same "blocked" semantics: rooster + contact apply to every lead;
  -- stag applies only to leads flagged as affiliate.
  if v_job.enrichment_status = 'all_running' then
    select count(*) into v_other_blocked
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and (
        (
          g.is_rooster_overridden_at is null
          and g.rooster_checked_at is null
          and exists (
            select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id
              and q.process_stages @> '["rooster"]'::jsonb
              and q.status in ('pending', 'running', 'paused')
          )
        )
        or
        (
          g.is_contact_overridden_at is null
          and g.contact_checked_at is null
          and exists (
            select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id
              and q.process_stages @> '["contact"]'::jsonb
              and q.status in ('pending', 'running', 'paused')
          )
        )
      );

    select count(*) into v_stag_blocked
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
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

-- ------------------------------------------------------------
-- force_complete_enrichment — manual escape hatch.
-- Sets enrichment_status='complete' immediately regardless of the
-- chain's current phase. Cancels any pending/paused queue rows for
-- the job's leads so they don't suddenly come back to life later.
-- ------------------------------------------------------------
create or replace function public.force_complete_enrichment(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_prior text;
  v_cancelled integer;
begin
  select enrichment_status into v_prior
  from public.scrape_queue where id = p_job_id;

  -- Cancel any still-pending/paused enrichment work for this job's leads.
  with cancelled as (
    update public.enrichment_fetch_queue q
    set status = 'cancelled', updated_at = now()
    where q.status in ('pending', 'paused')
      and q.lead_id in (
        select id from public.google_lead_gen_table
        where scrape_job_id = p_job_id
      )
    returning 1
  )
  select count(*) into v_cancelled from cancelled;

  update public.scrape_queue
  set enrichment_status      = 'complete',
      enrichment_completed_at = now(),
      updated_at              = now()
  where id = p_job_id;

  return coalesce(v_prior, 'null') || ' (cancelled ' || v_cancelled || ' queued rows)';
end;
$$;

grant execute on function public.force_complete_enrichment(uuid) to service_role;
revoke execute on function public.force_complete_enrichment(uuid) from anon, authenticated;
