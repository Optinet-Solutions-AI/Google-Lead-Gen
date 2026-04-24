-- ============================================================
-- Migration: Simplify Monday Match Categories (Epic 7.1 follow-up)
--
-- Reduces the badge taxonomy on google_lead_gen_table.monday_board
-- to 3 categories that map 1:1 to the UI labels:
--
--   'affiliate' — matched on the Affiliates board (Rooster brand)
--   'leads'     — matched on any of the 3 lead-type item boards
--                 (Leads / Not Relevant Leads / Email Undelivered)
--   'updates'   — domain mentioned in any of the 4 updates tables'
--                 body_text — softer signal than a direct item match
--   NULL        — no match (is_on_monday = false)
--
-- Changes:
--   - search_website_on_monday returns `category` not `board`
--   - It now searches the 4 updates tables too
--   - mark_monday_duplicates_for_job is updated to write the new
--     category value into monday_board
--   - Existing rows get a one-shot UPDATE to remap old board names
--     ('affiliates' / 'not_relevant_leads' / 'email_undelivered_leads')
--     to the new categories.
-- ============================================================

-- ------------------------------------------------------------
-- Drop the previous version (signature change: return col renamed)
-- ------------------------------------------------------------
drop function if exists public.search_website_on_monday(text);

-- ------------------------------------------------------------
-- New search RPC with 3-category output
-- ------------------------------------------------------------
create function public.search_website_on_monday(p_domain text)
returns table(category text, item_id text, item_name text)
language sql
stable
security definer
set search_path = public
as $$
  with n as (select normalize_domain(p_domain) as d)
  -- 1. Affiliate item (Rooster brand) — highest priority
  (select 'affiliate'::text, monday_item_id, name
     from affiliates_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  -- 2. Any lead-type board item
  (select 'leads'::text, monday_item_id, name
     from leads_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  (select 'leads'::text, monday_item_id, name
     from not_relevant_leads_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  (select 'leads'::text, monday_item_id, name
     from email_undelivered_leads_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  -- 3. Update post body mentions (any of 4 updates tables)
  (select 'updates'::text, monday_item_id, null::text
     from leads_updates_table, n
     where n.d <> '' and body_text ilike '%' || n.d || '%'
     limit 1)
  union all
  (select 'updates'::text, monday_item_id, null::text
     from affiliates_updates_table, n
     where n.d <> '' and body_text ilike '%' || n.d || '%'
     limit 1)
  union all
  (select 'updates'::text, monday_item_id, null::text
     from not_relevant_leads_updates_table, n
     where n.d <> '' and body_text ilike '%' || n.d || '%'
     limit 1)
  union all
  (select 'updates'::text, monday_item_id, null::text
     from email_undelivered_leads_updates_table, n
     where n.d <> '' and body_text ilike '%' || n.d || '%'
     limit 1)
  limit 1;
$$;

grant execute on function public.search_website_on_monday(text) to service_role;
revoke execute on function public.search_website_on_monday(text) from anon, authenticated;

-- ------------------------------------------------------------
-- Bulk processor — body now references m.category (was m.board)
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

-- ------------------------------------------------------------
-- One-shot remap of any data already marked under the old taxonomy
-- ------------------------------------------------------------
update public.google_lead_gen_table
set monday_board = case
  when monday_board = 'affiliates'              then 'affiliate'
  when monday_board = 'not_relevant_leads'      then 'leads'
  when monday_board = 'email_undelivered_leads' then 'leads'
  else monday_board
end
where monday_board in ('affiliates', 'not_relevant_leads', 'email_undelivered_leads');
