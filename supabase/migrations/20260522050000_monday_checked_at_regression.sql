-- ============================================================
-- Migration: restore monday_checked_at stamping in
-- mark_monday_duplicates_for_job + backfill the rows that lost it.
--
-- Regression history:
--   * 20260424270000_stage_run_timestamps.sql introduced monday_checked_at
--     and the RPC set it to now() on every covered row.
--   * 20260429100000_monday_fuzzy_match.sql redefined the RPC to add
--     monday_match_kind but accidentally dropped the
--     `monday_checked_at = v_now` line — and its own backfill UPDATE
--     also forgot the column.
--   * 20260505010000_lead_not_relevant_filter.sql redefined the RPC
--     again to auto-flag is_not_relevant, carrying the bug forward.
--
-- Symptom (found via QA on scrape 44b60a37-29f4-...): every lead
-- scraped since 2026-04-29 has monday_checked_at = null even though
-- is_on_monday / monday_board / monday_item_id are populated. The
-- EnrichmentStages "last run at" column for the Monday stage and any
-- staleness gating that depends on the timestamp both break silently.
--
-- This migration:
--   1. Re-defines mark_monday_duplicates_for_job with the not_relevant
--      auto-flag logic from 20260505010000 *plus* monday_checked_at.
--   2. Backfills the column for rows that were already matched but
--      never stamped: monday_checked_at = coalesce(
--        monday_overridden_at, created_at) — same pattern the original
--      20260424270000 backfill used, so a row's timestamp reflects
--      either its manual override moment or its scrape moment.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Restore the RPC, stamping monday_checked_at again
-- ------------------------------------------------------------
create or replace function public.mark_monday_duplicates_for_job(p_job_id uuid)
returns table(checked integer, matched integer)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_now     timestamptz := now();
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
        monday_checked_at = v_now,
        is_not_relevant   = case
          when r.board = 'not_relevant_leads' then true
          else g.is_not_relevant
        end,
        not_relevant_marked_at = case
          when r.board = 'not_relevant_leads' and g.not_relevant_marked_at is null then v_now
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
-- 2. Backfill — every lead that was Monday-matched but never stamped.
-- Uses created_at (or the manual-override moment, if newer) so the
-- timestamp reflects when the row was last evaluated rather than now,
-- which keeps any staleness/age UI honest about historical scrapes.
-- ------------------------------------------------------------
update public.google_lead_gen_table
set monday_checked_at = greatest(created_at, coalesce(monday_overridden_at, created_at))
where monday_checked_at is null
  and is_on_monday is not null;
