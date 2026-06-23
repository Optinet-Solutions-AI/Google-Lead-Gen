-- ============================================================
-- Re-match leads against the Monday replica after each sync.
--
-- Bug: mark_monday_duplicates_for_job runs once at scrape-complete
-- time. If a Monday item is added LATER (e.g. operator pushes a lead
-- to Not Relevant after the lead's owning job has finished), the
-- lead row stays is_on_monday=false even after the replica picks
-- up the new Monday item on the next sync.
--
-- Real-world hits (2026-06-23 QA):
--   lead 26568 (casino.welt.de) — replica has the row in
--     not_relevant_leads_table, but the lead is still is_on_monday=false
--     because mark_monday_duplicates_for_job ran before the Monday
--     item existed.
--
-- Fix: two new RPCs that re-run the match against the current
-- replica state, and a hook in the sync runner so we re-match
-- after every sync.
--
--   rematch_monday_for_leads(p_lead_ids bigint[])
--     Targeted: re-run match for specific leads. Used by the QA
--     unstick script.
--
--   rematch_monday_for_all_leads(p_limit int default 50000)
--     Sweep: re-run match for every lead without a manual override.
--     Returns the count of rows whose is_on_monday flipped.
--     Cron-friendly cap so a 50k-row table doesn't lock the worker
--     for too long.
--
-- Both skip leads with monday_overridden_at set so a manual operator
-- override survives the re-match.
-- ============================================================

create or replace function public.rematch_monday_for_leads(
  p_lead_ids bigint[]
)
returns table(checked integer, flipped integer)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_checked integer := 0;
  v_flipped integer := 0;
begin
  with leads as (
    select
      id,
      is_on_monday as prior_flag,
      monday_board as prior_board,
      normalize_domain(coalesce(domain, url)) as nd
    from public.google_lead_gen_table
    where id = any(p_lead_ids)
      and monday_overridden_at is null
  ),
  results as (
    select l.id as lead_id, l.prior_flag, l.prior_board, m.board, m.item_id, m.match_kind
    from leads l
    left join lateral (
      select * from public.search_website_on_monday(l.nd) limit 1
    ) m on true
  ),
  upd as (
    update public.google_lead_gen_table g
    set is_on_monday      = (r.item_id is not null),
        monday_board      = r.board,
        monday_item_id    = r.item_id,
        monday_match_kind = r.match_kind
    from results r
    where g.id = r.lead_id
    returning
      r.prior_flag,
      g.is_on_monday,
      r.prior_board,
      g.monday_board
  )
  select
    count(*)::integer,
    count(*) filter (
      where prior_flag is distinct from is_on_monday
         or prior_board is distinct from monday_board
    )::integer
    into v_checked, v_flipped
  from upd;

  return query select v_checked, v_flipped;
end;
$$;

grant execute on function public.rematch_monday_for_leads(bigint[]) to service_role;
revoke execute on function public.rematch_monday_for_leads(bigint[]) from anon, authenticated;

create or replace function public.rematch_monday_for_all_leads(
  p_limit integer default 50000
)
returns table(checked integer, flipped integer)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ids bigint[];
begin
  select array_agg(id) into v_ids
  from (
    select id
    from public.google_lead_gen_table
    where monday_overridden_at is null
    order by id desc
    limit p_limit
  ) t;
  if v_ids is null or array_length(v_ids, 1) is null then
    return query select 0, 0;
    return;
  end if;
  return query select * from public.rematch_monday_for_leads(v_ids);
end;
$$;

grant execute on function public.rematch_monday_for_all_leads(integer) to service_role;
revoke execute on function public.rematch_monday_for_all_leads(integer) from anon, authenticated;
