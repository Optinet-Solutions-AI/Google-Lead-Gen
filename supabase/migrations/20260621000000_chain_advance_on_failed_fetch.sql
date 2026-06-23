-- ============================================================
-- Patch: advance_enrichment_chain treats terminally-failed efq rows
-- as "done" so a worker crash (e.g. Errno 24, GoLogin API timeout)
-- can't strand a job in *_running forever.
--
-- Bug observed 2026-06-22 (38 jobs stuck): enrichment workers on
-- vm2/vm3 hit "Too many open files" + "Max retries exceeded with
-- url: api.gologin.co", so every affiliate fetch maxed its attempts
-- and went to status='failed'. The previous chain body only counted
-- leads where affiliate_checked_at IS NOT NULL (or override set) as
-- progress — a failed fetch never set the timestamp, so v_aff_done
-- stayed below v_total and the chain looped forever at
-- 'affiliate_running'.
--
-- Fix: extend the per-stage "done" predicate to ALSO match leads
-- whose efq row for that stage reached a terminal state — failed,
-- cancelled, or completed-but-untimestamped. The chain now advances
-- past stages we've genuinely "given up on" instead of stalling.
--
-- Also adds advance_all_stuck_enrichment(): one call sweeps every
-- *_running job and pokes the chain on each. Hook to the scheduler
-- cron so a worker crash heals on the next tick instead of needing
-- a manual unstick script.
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
  v_aff_count   integer;
  v_stag_done   integer;
  v_now         timestamptz := now();
begin
  select * into v_job from public.scrape_queue where id = p_job_id;
  if v_job.id is null then return null; end if;
  if not v_job.with_enrichment then return v_job.enrichment_status; end if;
  if v_job.status <> 'completed' then return v_job.enrichment_status; end if;
  if v_job.enrichment_status = 'complete' then return 'complete'; end if;

  -- Skip predicate (unchanged): is_on_monday rows skip by default;
  -- force_enrich=true overrides.
  select count(*) into v_total
  from public.google_lead_gen_table
  where scrape_job_id = p_job_id
    and is_not_relevant = false
    and (force_enrich = true or is_on_monday is not true);

  if v_total = 0 then
    update public.scrape_queue
    set enrichment_status = 'complete', enrichment_completed_at = v_now
    where id = p_job_id;
    return 'complete';
  end if;

  if v_job.enrichment_status is null or v_job.enrichment_status = 'pending' then
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
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true)
      and g.is_affiliate_overridden_at is null
      and g.affiliate_checked_at is null;

    update public.scrape_queue
    set enrichment_status      = 'affiliate_running',
        enrichment_started_at  = coalesce(enrichment_started_at, v_now)
    where id = p_job_id;
    return 'affiliate_running';
  end if;

  -- Phase 2: affiliate done.
  -- A lead is "done with affiliate" when one of:
  --   (a) admin override timestamp set, OR
  --   (b) worker stamped affiliate_checked_at, OR
  --   (c) every affiliate efq row for the lead is in a terminal state
  --       (failed / cancelled / completed) AND there's at least one row —
  --       i.e. we tried but gave up, no point waiting.
  if v_job.enrichment_status = 'affiliate_running' then
    select count(*) into v_aff_done
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true)
      and (
        g.is_affiliate_overridden_at is not null
        or g.affiliate_checked_at is not null
        or (
          exists (
            select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id
              and q.process_stages @> '["affiliate"]'::jsonb
          )
          and not exists (
            select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id
              and q.process_stages @> '["affiliate"]'::jsonb
              and q.status in ('pending', 'running', 'paused')
          )
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
      and (g.force_enrich = true or g.is_on_monday is not true)
      and g.is_rooster_overridden_at is null
      and g.rooster_checked_at is null;

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["contact"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true)
      and g.is_contact_overridden_at is null
      and g.contact_checked_at is null;

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["stag"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true)
      and g.is_affiliate = true
      and g.is_stag_overridden_at is null
      and g.s_tags_checked_at is null;

    update public.scrape_queue
    set enrichment_status = 'all_running'
    where id = p_job_id;
    return 'all_running';
  end if;

  -- Phase 3 — same terminal-row escape hatch on rooster + contact +
  -- stag stages. Without this the chain would re-stall at 'all_running'
  -- as soon as a single fetch failed.
  if v_job.enrichment_status = 'all_running' then
    select count(*) into v_other_done
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true)
      and (
        g.is_rooster_overridden_at is not null
        or g.rooster_checked_at is not null
        or (
          exists (select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id and q.process_stages @> '["rooster"]'::jsonb)
          and not exists (select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id and q.process_stages @> '["rooster"]'::jsonb
              and q.status in ('pending', 'running', 'paused'))
        )
      )
      and (
        g.is_contact_overridden_at is not null
        or g.contact_checked_at is not null
        or (
          exists (select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id and q.process_stages @> '["contact"]'::jsonb)
          and not exists (select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id and q.process_stages @> '["contact"]'::jsonb
              and q.status in ('pending', 'running', 'paused'))
        )
      );

    select count(*) into v_aff_count
    from public.google_lead_gen_table
    where scrape_job_id = p_job_id
      and is_not_relevant = false
      and (force_enrich = true or is_on_monday is not true)
      and is_affiliate = true;

    select count(*) into v_stag_done
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true)
      and g.is_affiliate = true
      and (
        g.is_stag_overridden_at is not null
        or g.s_tags_checked_at is not null
        or (
          exists (select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id and q.process_stages @> '["stag"]'::jsonb)
          and not exists (select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id and q.process_stages @> '["stag"]'::jsonb
              and q.status in ('pending', 'running', 'paused'))
        )
      );

    if v_other_done < v_total or v_stag_done < v_aff_count then
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
-- advance_all_stuck_enrichment — sweep every completed scrape with
-- enrichment_status IN ('affiliate_running', 'all_running') and run
-- the chain on each. Safe to call any time; the chain is idempotent.
-- Cap on rows touched per call (default 200) so a runaway backlog
-- doesn't eat one cron tick whole.
-- ------------------------------------------------------------
create or replace function public.advance_all_stuck_enrichment(
  p_limit integer default 200
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_before  text;
  v_after   text;
  v_moved   integer := 0;
begin
  for v_id, v_before in
    select id, enrichment_status
    from public.scrape_queue
    where status = 'completed'
      and enrichment_status in ('affiliate_running', 'all_running')
    order by completed_at asc
    limit p_limit
  loop
    v_after := public.advance_enrichment_chain(v_id);
    if v_after is distinct from v_before then
      v_moved := v_moved + 1;
    end if;
  end loop;
  return v_moved;
end;
$$;

grant execute on function public.advance_all_stuck_enrichment(integer) to service_role;
revoke execute on function public.advance_all_stuck_enrichment(integer) from anon, authenticated;
