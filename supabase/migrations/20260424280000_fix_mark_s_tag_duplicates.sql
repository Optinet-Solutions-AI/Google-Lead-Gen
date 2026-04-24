-- ============================================================
-- Fix: mark_s_tag_duplicates_for_job referenced a CTE across
-- statements ("relation 'stamp_leads' does not exist"). Rewrites
-- as two separate statements — the main aggregation then a
-- separate UPDATE to stamp the parent lead rows.
-- ============================================================

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
  -- Stage 1: update s_tags_table rows + count outcomes
  with target_tags as (
    select t.id, t.lead_id, t.s_tag
    from s_tags_table t
    join google_lead_gen_table g on g.id = t.lead_id
    where g.scrape_job_id = p_job_id
  ),
  results as (
    select tt.id as tag_id, m.kind, m.item_id
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
    returning s.is_existing_on_monday
  )
  select count(*)::integer, count(*) filter (where is_existing_on_monday)::integer
    into v_checked, v_matched
  from upd;

  -- Stage 2: stamp parent lead rows that had any tag processed
  update google_lead_gen_table g
  set stag_check_checked_at = v_now
  where g.id in (
    select distinct t.lead_id
    from s_tags_table t
    join google_lead_gen_table gl on gl.id = t.lead_id
    where gl.scrape_job_id = p_job_id
  );

  return query select v_checked, v_matched;
end;
$$;

grant execute on function public.mark_s_tag_duplicates_for_job(uuid) to service_role;
revoke execute on function public.mark_s_tag_duplicates_for_job(uuid) from anon, authenticated;
