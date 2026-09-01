-- ============================================================
-- Enrichment chain: actually STOP at rooster (contact + s-tag are manual).
--
-- BUG: advance_enrichment_chain enqueued contact + s-tag fetches after rooster
-- AND waited for them to complete before marking the job 'complete'. But contact
-- and s-tag extraction are operator-triggered (LGP-226) — nothing auto-completes
-- them — so every enrichment job stalled at 'all_running' forever. Result: 50
-- jobs stuck (oldest ~68 days), NO job reached 'complete' since 2026-07-23, and
-- ~20k contact/stag fetches piled up failed. Operators saw "enrichment queued"
-- that never finished even with every stage's dots green.
--
-- Fix: the auto chain now does affiliate → rooster → complete. It no longer
-- enqueues or waits for contact / s-tag; those run only when the operator
-- triggers them. Everything else (per-lead Monday skip, force_enrich, advance-on-
-- failed-fetch) is identical to 20260803150000.
-- ============================================================
create or replace function public.advance_enrichment_chain(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job         public.scrape_queue;
  v_total       integer;
  v_aff_done    integer;
  v_other_done  integer;
  v_now         timestamptz := now();
begin
  select * into v_job from public.scrape_queue where id = p_job_id;
  if v_job.id is null then return null; end if;
  if not v_job.with_enrichment then return v_job.enrichment_status; end if;
  if v_job.status <> 'completed' then return v_job.enrichment_status; end if;
  if v_job.enrichment_status = 'complete' then return 'complete'; end if;

  perform public.inherit_monday_data_for_lead(g.id)
  from public.google_lead_gen_table g
  where g.scrape_job_id = p_job_id
    and g.is_on_monday = true
    and g.monday_inherited_at is null;

  -- Count only FETCHABLE enrichable leads (valid http url + country). A lead
  -- with no url/country is never enqueued, so it could never be marked "done"
  -- and would stall the stage forever — exclude it (it can't be enriched anyway).
  select count(*) into v_total
  from public.google_lead_gen_table
  where scrape_job_id = p_job_id
    and is_not_relevant = false
    and url is not null and url like 'http%'
    and country_code is not null
    and (force_enrich = true or is_on_monday is not true or monday_inherited_at is not null);

  if v_total = 0 then
    update public.scrape_queue
    set enrichment_status = 'complete', enrichment_completed_at = v_now
    where id = p_job_id;
    return 'complete';
  end if;

  -- Stage 1: affiliate
  if v_job.enrichment_status is null or v_job.enrichment_status = 'pending' then
    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, (g.result_type = 'PPC'), '["affiliate"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and g.is_affiliate_overridden_at is null
      and g.affiliate_checked_at is null;

    update public.scrape_queue
    set enrichment_status = 'affiliate_running',
        enrichment_started_at = coalesce(enrichment_started_at, v_now)
    where id = p_job_id;
    return 'affiliate_running';
  end if;

  -- Stage 2: rooster (enqueued once affiliate resolved). Contact + s-tag are
  -- operator-triggered, so they are NOT enqueued or waited on here any more.
  if v_job.enrichment_status = 'affiliate_running' then
    select count(*) into v_aff_done
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and (
        g.is_affiliate_overridden_at is not null
        or g.affiliate_checked_at is not null
        -- Done once nothing is actively fetching this lead's affiliate stage —
        -- covers success, failure, AND a fetch that was cleaned up or never
        -- enqueued. Only an in-flight fetch blocks.
        or not exists (
          select 1 from public.enrichment_fetch_queue q
          where q.lead_id = g.id and q.process_stages @> '["affiliate"]'::jsonb
            and q.status in ('pending', 'running', 'paused')
        )
      );

    if v_aff_done < v_total then
      return 'affiliate_running';
    end if;

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["rooster"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and g.is_rooster_overridden_at is null
      and g.rooster_checked_at is null;

    update public.scrape_queue set enrichment_status = 'all_running' where id = p_job_id;
    return 'all_running';
  end if;

  -- Stage 3: wait for rooster ONLY, then complete.
  if v_job.enrichment_status = 'all_running' then
    select count(*) into v_other_done
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and (
        g.is_rooster_overridden_at is not null
        or g.rooster_checked_at is not null
        or not exists (
          select 1 from public.enrichment_fetch_queue q
          where q.lead_id = g.id and q.process_stages @> '["rooster"]'::jsonb
            and q.status in ('pending', 'running', 'paused')
        )
      );

    if v_other_done < v_total then
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
