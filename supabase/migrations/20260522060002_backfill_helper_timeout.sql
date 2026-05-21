-- ============================================================
-- Lift statement_timeout inside the chunking helper. The supabase
-- service_role connection enforces a short per-statement timeout
-- that kills even 500-row chunks of the lateral-join backfill from
-- 20260522060001. Functions can override session GUCs with a SET
-- clause, scoped to the call.
-- ============================================================

create or replace function public.backfill_monday_overridden_chunk(
  p_min bigint,
  p_max bigint
)
returns table(scanned integer, flipped_on_monday integer, flipped_not_relevant integer)
language plpgsql
volatile
security definer
set search_path = public
set statement_timeout = '5min'
as $$
declare
  v_scanned integer := 0;
  v_flipped integer := 0;
  v_nr      integer := 0;
begin
  with sub as (
    select g.id as lead_id, m.board, m.item_id, m.match_kind,
           g.is_on_monday as old_iom,
           g.is_not_relevant as old_nr
    from public.google_lead_gen_table g
    left join lateral (
      select * from public.search_website_on_monday(
        public.normalize_domain(coalesce(g.domain, g.url))
      ) limit 1
    ) m on true
    where g.monday_overridden_at is null
      and g.id between p_min and p_max
  ),
  upd as (
    update public.google_lead_gen_table g
    set is_on_monday          = (sub.item_id is not null),
        monday_board          = sub.board,
        monday_item_id        = sub.item_id,
        monday_match_kind     = sub.match_kind,
        monday_checked_at     = now(),
        is_not_relevant       = case
          when sub.board = 'not_relevant_leads' then true
          else g.is_not_relevant
        end,
        not_relevant_marked_at = case
          when sub.board = 'not_relevant_leads' and g.not_relevant_marked_at is null then now()
          else g.not_relevant_marked_at
        end,
        not_relevant_marked_by = case
          when sub.board = 'not_relevant_leads' and g.not_relevant_marked_by is null then 'monday_sync'
          else g.not_relevant_marked_by
        end
    from sub
    where g.id = sub.lead_id
      and g.monday_overridden_at is null
    returning sub.old_iom, sub.old_nr, g.is_on_monday, g.is_not_relevant, sub.board
  )
  select count(*)::integer,
         count(*) filter (where is_on_monday and not coalesce(old_iom, false))::integer,
         count(*) filter (where board = 'not_relevant_leads' and not coalesce(old_nr, false))::integer
    into v_scanned, v_flipped, v_nr
  from upd;

  return query select v_scanned, v_flipped, v_nr;
end;
$$;

grant execute on function public.backfill_monday_overridden_chunk(bigint, bigint) to service_role;
revoke execute on function public.backfill_monday_overridden_chunk(bigint, bigint) from anon, authenticated;
