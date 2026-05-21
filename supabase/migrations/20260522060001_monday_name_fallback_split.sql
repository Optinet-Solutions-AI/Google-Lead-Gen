-- ============================================================
-- Split companion to 20260522060000_monday_name_fallback.sql
--
-- The original migration's combined function-replace + 14k-row
-- lateral-join backfill exceeds the Supabase SQL editor's ~60s
-- dashboard fetch timeout, which rolls the whole transaction back.
-- This file replaces that single paste with:
--   1. The function definition (identical to 060000, fast).
--   2. A small helper `backfill_monday_overridden_chunk(p_min, p_max)`
--      that runs the same UPDATE against a bounded id range.
-- The actual backfill is then driven from a node script that calls
-- the helper in chunks, well under any single-statement timeout.
--
-- Once both this file and the chunked backfill have run, the original
-- 20260522060000 is fully realised — no need to ever re-attempt it.
-- ============================================================

drop function if exists public.search_website_on_monday(text);

create or replace function public.search_website_on_monday(p_domain text)
returns table(board text, item_id text, item_name text, match_kind text)
language sql
stable
security definer
set search_path = public
as $$
  with n as (
    select
      normalize_domain(p_domain) as d,
      registered_domain(normalize_domain(p_domain)) as r
  )
  (select 'affiliates'::text, monday_item_id, name, 'exact'::text
     from affiliates_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  (select 'leads'::text, monday_item_id, name, 'exact'::text
     from leads_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  (select 'not_relevant_leads'::text, monday_item_id, name, 'exact'::text
     from not_relevant_leads_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  (select 'email_undelivered_leads'::text, monday_item_id, name, 'exact'::text
     from email_undelivered_leads_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  (select 'affiliates'::text, monday_item_id, name, 'exact_name'::text
     from affiliates_table, n
     where n.d <> ''
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and normalize_domain(name) = n.d
     limit 1)
  union all
  (select 'leads'::text, monday_item_id, name, 'exact_name'::text
     from leads_table, n
     where n.d <> ''
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and normalize_domain(name) = n.d
     limit 1)
  union all
  (select 'not_relevant_leads'::text, monday_item_id, name, 'exact_name'::text
     from not_relevant_leads_table, n
     where n.d <> ''
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and normalize_domain(name) = n.d
     limit 1)
  union all
  (select 'email_undelivered_leads'::text, monday_item_id, name, 'exact_name'::text
     from email_undelivered_leads_table, n
     where n.d <> ''
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and normalize_domain(name) = n.d
     limit 1)
  union all
  (select 'affiliates'::text, monday_item_id, name, 'registered'::text
     from affiliates_table, n
     where n.r <> '' and n.r <> n.d
       and registered_domain(website_normalized) = n.r
     limit 1)
  union all
  (select 'leads'::text, monday_item_id, name, 'registered'::text
     from leads_table, n
     where n.r <> '' and n.r <> n.d
       and registered_domain(website_normalized) = n.r
     limit 1)
  union all
  (select 'not_relevant_leads'::text, monday_item_id, name, 'registered'::text
     from not_relevant_leads_table, n
     where n.r <> '' and n.r <> n.d
       and registered_domain(website_normalized) = n.r
     limit 1)
  union all
  (select 'email_undelivered_leads'::text, monday_item_id, name, 'registered'::text
     from email_undelivered_leads_table, n
     where n.r <> '' and n.r <> n.d
       and registered_domain(website_normalized) = n.r
     limit 1)
  union all
  (select 'affiliates'::text, monday_item_id, name, 'registered_name'::text
     from affiliates_table, n
     where n.r <> '' and n.r <> n.d
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and registered_domain(normalize_domain(name)) = n.r
     limit 1)
  union all
  (select 'leads'::text, monday_item_id, name, 'registered_name'::text
     from leads_table, n
     where n.r <> '' and n.r <> n.d
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and registered_domain(normalize_domain(name)) = n.r
     limit 1)
  union all
  (select 'not_relevant_leads'::text, monday_item_id, name, 'registered_name'::text
     from not_relevant_leads_table, n
     where n.r <> '' and n.r <> n.d
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and registered_domain(normalize_domain(name)) = n.r
     limit 1)
  union all
  (select 'email_undelivered_leads'::text, monday_item_id, name, 'registered_name'::text
     from email_undelivered_leads_table, n
     where n.r <> '' and n.r <> n.d
       and coalesce(website_normalized, '') = ''
       and name is not null
       and position('/' in name) = 0
       and registered_domain(normalize_domain(name)) = n.r
     limit 1)
  union all
  (select 'affiliates'::text, i.monday_item_id, i.name, 'mentioned_in_updates'::text
     from affiliates_updates_table u
     join affiliates_table i on i.monday_item_id = u.monday_item_id
     cross join n
     where n.r <> '' and u.body_domains @> array[n.r]
     limit 1)
  union all
  (select 'leads'::text, i.monday_item_id, i.name, 'mentioned_in_updates'::text
     from leads_updates_table u
     join leads_table i on i.monday_item_id = u.monday_item_id
     cross join n
     where n.r <> '' and u.body_domains @> array[n.r]
     limit 1)
  union all
  (select 'not_relevant_leads'::text, i.monday_item_id, i.name, 'mentioned_in_updates'::text
     from not_relevant_leads_updates_table u
     join not_relevant_leads_table i on i.monday_item_id = u.monday_item_id
     cross join n
     where n.r <> '' and u.body_domains @> array[n.r]
     limit 1)
  union all
  (select 'email_undelivered_leads'::text, i.monday_item_id, i.name, 'mentioned_in_updates'::text
     from email_undelivered_leads_updates_table u
     join email_undelivered_leads_table i on i.monday_item_id = u.monday_item_id
     cross join n
     where n.r <> '' and u.body_domains @> array[n.r]
     limit 1)
  limit 1;
$$;

grant execute on function public.search_website_on_monday(text) to service_role;
revoke execute on function public.search_website_on_monday(text) from anon, authenticated;

-- ------------------------------------------------------------
-- Chunking helper: same backfill the original 060000 ran inline,
-- bounded to an id range so a single call stays under any dashboard
-- timeout. Returns (scanned, flipped_on_monday, flipped_not_relevant)
-- so the node driver can show progress. Stays as a permanent helper —
-- safe to keep around for any future Monday-replica reshuffles.
-- ------------------------------------------------------------
create or replace function public.backfill_monday_overridden_chunk(
  p_min bigint,
  p_max bigint
)
returns table(scanned integer, flipped_on_monday integer, flipped_not_relevant integer)
language plpgsql
volatile
security definer
set search_path = public
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
