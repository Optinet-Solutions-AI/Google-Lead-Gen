-- ============================================================
-- Migration: Stage-Run Timestamps (Epic 7 UI)
--
-- Adds per-stage check timestamps for the two stages that were
-- missing them, so the collapsible enrichment panel can show
-- "last run at" for all 6 stages.
--
--   monday_checked_at       — set by mark_monday_duplicates_for_job
--   stag_check_checked_at   — set by mark_s_tag_duplicates_for_job
--                             (on the parent lead row, so the
--                              summary query only needs one table)
--
-- Other four stages already have dedicated _checked_at columns.
-- ============================================================

alter table public.google_lead_gen_table
  add column if not exists monday_checked_at     timestamptz,
  add column if not exists stag_check_checked_at timestamptz;

-- ------------------------------------------------------------
-- Best-effort backfill: if a row has been classified on Monday
-- already, we know the check ran at least once. Mark it as
-- happening at created_at (or the override timestamp, whichever
-- is newer) so the UI can show a plausible "last run" time.
-- ------------------------------------------------------------
update public.google_lead_gen_table
set monday_checked_at = greatest(created_at, coalesce(monday_overridden_at, created_at))
where is_on_monday is not null and monday_checked_at is null;

-- ------------------------------------------------------------
-- Updated bulk RPC for Monday duplicate check — writes timestamp
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
  v_now     timestamptz := now();
begin
  with leads as (
    select id, normalize_domain(coalesce(domain, url)) as nd
    from google_lead_gen_table
    where scrape_job_id = p_job_id
      and monday_overridden_at is null
  ),
  results as (
    select l.id as lead_id, m.category, m.item_id
    from leads l
    left join lateral (
      select * from search_website_on_monday(l.nd) limit 1
    ) m on true
  ),
  upd as (
    update google_lead_gen_table g
    set is_on_monday      = (r.category is not null),
        monday_board      = r.category,
        monday_item_id    = r.item_id,
        monday_checked_at = v_now
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
-- Updated bulk RPC for s-tag duplicate check — also stamps the
-- parent lead row so the summary query is a single-table scan.
-- ------------------------------------------------------------
create or replace function public.mark_s_tag_duplicates_for_job(p_job_id uuid)
returns table(checked integer, matched integer)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_checked integer := 0;
  v_matched integer := 0;
  v_now     timestamptz := now();
begin
  with target_tags as (
    select t.id, t.lead_id, t.s_tag
    from s_tags_table t
    join google_lead_gen_table g on g.id = t.lead_id
    where g.scrape_job_id = p_job_id
  ),
  results as (
    select tt.id as tag_id, tt.lead_id, m.kind, m.item_id
    from target_tags tt
    left join lateral (
      select * from search_s_tag_on_monday(tt.s_tag) limit 1
    ) m on true
  ),
  upd as (
    update s_tags_table s
    set is_existing_on_monday = (r.item_id is not null),
        monday_match_kind     = r.kind,
        monday_match_item_id  = r.item_id
    from results r
    where s.id = r.tag_id
    returning s.id, s.lead_id, s.is_existing_on_monday
  ),
  stamp_leads as (
    update google_lead_gen_table g
    set stag_check_checked_at = v_now
    from (select distinct lead_id from upd) u
    where g.id = u.lead_id
    returning 1
  )
  select count(*)::integer, count(*) filter (where is_existing_on_monday)::integer
    into v_checked, v_matched
  from upd;

  -- Force stamp_leads to evaluate (CTEs without a reader are skipped)
  perform * from stamp_leads;

  return query select v_checked, v_matched;
end;
$$;

grant execute on function public.mark_s_tag_duplicates_for_job(uuid) to service_role;
revoke execute on function public.mark_s_tag_duplicates_for_job(uuid) from anon, authenticated;
