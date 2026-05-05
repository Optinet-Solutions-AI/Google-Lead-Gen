-- ============================================================
-- Migration: Not-relevant exclusion — domain-level filter for results
--
-- Two sources of "not relevant":
--   1. Domain matched a Monday item on the not_relevant_leads board
--      (auto-flagged by mark_monday_duplicates_for_job).
--   2. A user clicked "Mark as not relevant" in the lead drawer
--      (manual flag with attribution + timestamp).
--
-- Once a lead is is_not_relevant=true:
--   - Hidden from /leads by default
--   - Skipped by advance_enrichment_chain (no fetch-queue rows for it)
--   - The "blocked" semantics already gate on enrichment_fetch_queue
--     existence, so simply never enqueueing is_not_relevant leads is
--     enough — they don't stall the chain.
--
-- Persistence: once flagged, the row stays flagged across re-scrapes.
-- Future re-scrapes that match the same Monday board pattern will be
-- auto-flagged on Monday-check; the manual flag also re-applies via
-- the backfill at the end of this file.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Columns on google_lead_gen_table
-- ------------------------------------------------------------
alter table public.google_lead_gen_table
  add column if not exists is_not_relevant         boolean     not null default false,
  add column if not exists not_relevant_marked_at  timestamptz,
  add column if not exists not_relevant_marked_by  text;

-- Filter index — partial on the `true` rows so the default `where
-- is_not_relevant = false` query path can skip them quickly.
create index if not exists idx_lead_not_relevant
  on public.google_lead_gen_table (is_not_relevant)
  where is_not_relevant = true;

-- ------------------------------------------------------------
-- 2. Backfill — auto-mark every existing lead matched to the Monday
-- not_relevant board (and not manually overridden away from it).
-- ------------------------------------------------------------
update public.google_lead_gen_table
set is_not_relevant = true,
    not_relevant_marked_at = coalesce(not_relevant_marked_at, monday_checked_at, now()),
    not_relevant_marked_by = coalesce(not_relevant_marked_by, 'monday_sync')
where monday_board = 'not_relevant_leads'
  and is_not_relevant = false;

-- ------------------------------------------------------------
-- 3. mark_monday_duplicates_for_job — auto-flag is_not_relevant when
-- the matched board is 'not_relevant_leads', so freshly-scraped leads
-- get filtered out of the UI + enrichment immediately.
-- ------------------------------------------------------------
create or replace function public.mark_monday_duplicates_for_job(p_job_id uuid)
returns table(checked integer, matched integer)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_checked integer := 0;
  v_matched integer := 0;
begin
  with leads as (
    select id, normalize_domain(coalesce(domain, url)) as nd
    from google_lead_gen_table
    where scrape_job_id = p_job_id
  ),
  results as (
    select l.id as lead_id, m.board, m.item_id, m.match_kind
    from leads l
    left join lateral (
      select * from search_website_on_monday(l.nd) limit 1
    ) m on true
  ),
  upd as (
    update google_lead_gen_table g
    set is_on_monday      = (r.item_id is not null),
        monday_board      = r.board,
        monday_item_id    = r.item_id,
        monday_match_kind = r.match_kind,
        -- Auto-flag when matched against the Monday not_relevant board.
        -- Don't unset an existing manual not-relevant flag.
        is_not_relevant   = case
          when r.board = 'not_relevant_leads' then true
          else g.is_not_relevant
        end,
        not_relevant_marked_at = case
          when r.board = 'not_relevant_leads' and g.not_relevant_marked_at is null then now()
          else g.not_relevant_marked_at
        end,
        not_relevant_marked_by = case
          when r.board = 'not_relevant_leads' and g.not_relevant_marked_by is null then 'monday_sync'
          else g.not_relevant_marked_by
        end
    from results r
    where g.id = r.lead_id
    returning g.is_on_monday
  )
  select count(*)::integer, count(*) filter (where is_on_monday)::integer
    into v_checked, v_matched
  from upd;

  return query select v_checked, v_matched;
end;
$$;

grant execute on function public.mark_monday_duplicates_for_job(uuid) to service_role;
revoke execute on function public.mark_monday_duplicates_for_job(uuid) from anon, authenticated;

-- ------------------------------------------------------------
-- 4. advance_enrichment_chain — skip is_not_relevant leads when
-- enqueueing fetch-queue rows. The "blocked" check gates on queue
-- row existence, so non-enqueued leads never block the chain.
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
  where scrape_job_id = p_job_id
    and is_not_relevant = false;  -- exclude not-relevant from total

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

  -- ----- Phase 2 -----
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
    select g.id, g.country_code, g.url, true, false, '["contact"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_contact_overridden_at is null;

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

  -- ----- Phase 3 -----
  if v_job.enrichment_status = 'all_running' then
    select count(*) into v_other_blocked
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
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
-- 5. Cancel any in-flight enrichment-fetch-queue rows for leads that
-- got auto-flagged not_relevant by step 2. Otherwise workers might
-- still process them in flight.
-- ------------------------------------------------------------
update public.enrichment_fetch_queue q
set status = 'cancelled', updated_at = now()
where q.status in ('pending', 'paused')
  and exists (
    select 1 from public.google_lead_gen_table g
    where g.id = q.lead_id
      and g.is_not_relevant = true
  );
