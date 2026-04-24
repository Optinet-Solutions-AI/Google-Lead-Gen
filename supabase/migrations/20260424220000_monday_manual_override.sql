-- ============================================================
-- Migration: Manual Override for Monday Duplicate Check (Epic 7.1)
--
-- Lets users manually correct the auto-detected Monday match label
-- per row, with re-runs of the auto-check honouring the override.
--
-- Adds:
--   - google_lead_gen_table.monday_overridden_at  (timestamptz)
--     NULL  → row was last set by the auto-check (or never set)
--     value → user manually set is_on_monday / monday_board, and
--             subsequent runs of mark_monday_duplicates_for_job
--             must leave this row alone.
--
-- Updates:
--   - mark_monday_duplicates_for_job skips rows where
--     monday_overridden_at IS NOT NULL.
-- ============================================================

alter table public.google_lead_gen_table
  add column if not exists monday_overridden_at timestamptz;

-- ------------------------------------------------------------
-- Bulk processor — preserves manually-set rows
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
    set is_on_monday   = (r.category is not null),
        monday_board   = r.category,
        monday_item_id = r.item_id
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
