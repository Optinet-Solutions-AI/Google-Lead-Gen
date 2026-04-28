-- ============================================================
-- Migration: Scrape-with-enrichment + scheduled-at + orchestrator
--
-- Epic 8 essentials:
--   1. New columns on scrape_queue:
--        with_enrichment        — auto-run enrichment chain on completion
--        scheduled_at           — workers won't claim until this time arrives
--        enrichment_status      — state-machine label
--        enrichment_started_at, enrichment_completed_at
--   2. New column on scheduled_keyword_sets:
--        run_enrichment         — sets with_enrichment on every spawned row
--   3. claim_scrape_job updated to honor scheduled_at
--   4. New advance_enrichment_chain RPC = state-machine for the
--      orchestrator cron (idempotent, safe to call every minute)
--
-- Chain phases:
--   pending           → run Monday dup-check (DB only) + enqueue affiliate
--   affiliate_running → wait for all rows' affiliate_checked_at, then
--                       enqueue rooster + contact (all rows) + stag
--                       (affiliate=true rows only)
--   all_running       → wait for rooster_checked_at + contact_checked_at
--                       + s_tags_checked_at (where applicable), then mark
--                       complete
--   complete          → terminal
-- ============================================================

alter table public.scrape_queue
  add column if not exists with_enrichment        boolean     not null default false,
  add column if not exists scheduled_at           timestamptz,
  add column if not exists enrichment_status      text,
  add column if not exists enrichment_started_at  timestamptz,
  add column if not exists enrichment_completed_at timestamptz;

create index if not exists idx_scrape_queue_scheduled
  on public.scrape_queue (scheduled_at)
  where scheduled_at is not null and status = 'pending';

create index if not exists idx_scrape_queue_enrichment_pending
  on public.scrape_queue (completed_at)
  where with_enrichment = true and status = 'completed'
    and (enrichment_status is null or enrichment_status not in ('complete', 'failed'));

alter table public.scheduled_keyword_sets
  add column if not exists run_enrichment boolean not null default false;

-- ------------------------------------------------------------
-- Updated claim_scrape_job — only claim rows whose scheduled_at
-- has arrived (or is unset).
-- ------------------------------------------------------------
create or replace function public.claim_scrape_job(p_worker_id text)
returns public.scrape_queue
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_candidate_id   uuid;
  v_country_code   text;
  v_row            public.scrape_queue;
begin
  select s.id, s.country_code
    into v_candidate_id, v_country_code
  from public.scrape_queue s
  where s.status = 'pending'
    and s.attempts < s.max_attempts
    and (s.scheduled_at is null or s.scheduled_at <= now())
    and not exists (
      select 1 from public.active_profile_locks l
      where l.country_code = s.country_code
    )
  order by s.priority desc, s.created_at asc
  limit 1
  for update skip locked;

  if v_candidate_id is null then
    return null;
  end if;

  insert into public.active_profile_locks (country_code, job_id, worker_id, job_kind)
  values (v_country_code, v_candidate_id, p_worker_id, 'scrape')
  on conflict (country_code) do nothing;

  if not found then
    return null;
  end if;

  update public.scrape_queue
  set status      = 'running',
      claimed_by  = p_worker_id,
      started_at  = now(),
      attempts    = attempts + 1,
      updated_at  = now()
  where id = v_candidate_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.claim_scrape_job(text) to service_role;
revoke execute on function public.claim_scrape_job(text) from anon, authenticated;

-- ------------------------------------------------------------
-- advance_enrichment_chain — state machine, called per minute by cron
-- ------------------------------------------------------------
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
  v_aff_done        integer;
  v_other_done      integer;
  v_aff_count       integer;
  v_stag_done       integer;
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
    -- Phase 0: Monday duplicate check (pure DB, no enqueue needed)
    perform public.mark_monday_duplicates_for_job(p_job_id);

    -- Phase 1: enqueue affiliate detection for non-overridden rows
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
  if v_job.enrichment_status = 'affiliate_running' then
    select count(*) into v_aff_done
    from public.google_lead_gen_table
    where scrape_job_id = p_job_id
      and (is_affiliate_overridden_at is not null or affiliate_checked_at is not null);

    if v_aff_done < v_total then
      return 'affiliate_running';
    end if;

    -- Enqueue rooster + contact (all rows) + stag (affiliate=true only)
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
  if v_job.enrichment_status = 'all_running' then
    select count(*) into v_other_done
    from public.google_lead_gen_table
    where scrape_job_id = p_job_id
      and (is_rooster_overridden_at is not null or rooster_checked_at is not null)
      and (is_contact_overridden_at is not null or contact_checked_at is not null);

    select count(*) into v_aff_count
    from public.google_lead_gen_table
    where scrape_job_id = p_job_id and is_affiliate = true;

    select count(*) into v_stag_done
    from public.google_lead_gen_table
    where scrape_job_id = p_job_id
      and is_affiliate = true
      and (is_stag_overridden_at is not null or s_tags_checked_at is not null);

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
