-- ============================================================
-- Migration: Granular Monday match categories
--
-- Replaces the 3-bucket taxonomy (affiliate / leads / updates) with
-- one bucket per Supabase table — 8 in total — so the duplicate-check
-- result tells you exactly which board (and which kind: item vs
-- updates body) the domain was found in.
--
-- New `monday_board` values:
--    'affiliates'                       — affiliates_table.website match
--    'affiliates_updates'               — affiliates_updates_table.body_text mention
--    'leads'                            — leads_table.website match
--    'leads_updates'                    — leads_updates_table.body_text mention
--    'not_relevant_leads'               — not_relevant_leads_table.website match
--    'not_relevant_leads_updates'       — not_relevant_leads_updates_table.body_text mention
--    'email_undelivered_leads'          — email_undelivered_leads_table.website match
--    'email_undelivered_leads_updates'  — email_undelivered_leads_updates_table.body_text mention
--
-- Priority order for first-hit:
--    items first (affiliates → leads → not_relevant → email_undelivered)
--    then updates body mentions (same order)
--
-- Existing rows that hold the old short values get a one-shot remap:
--    'affiliate' → 'affiliates'
--    'updates'   → leaves the row pointed at the matched item but the
--                  exact updates-table can't be recovered → set to NULL
--                  so the next auto-run re-classifies cleanly.
-- ============================================================

drop function if exists public.search_website_on_monday(text);

create function public.search_website_on_monday(p_domain text)
returns table(category text, item_id text, item_name text)
language sql
stable
security definer
set search_path = public
as $$
  with n as (select normalize_domain(p_domain) as d)
  -- 1. Item-level website matches (highest precision, indexed)
  (select 'affiliates'::text, monday_item_id, name
     from affiliates_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  (select 'leads'::text, monday_item_id, name
     from leads_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  (select 'not_relevant_leads'::text, monday_item_id, name
     from not_relevant_leads_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  union all
  (select 'email_undelivered_leads'::text, monday_item_id, name
     from email_undelivered_leads_table, n
     where n.d <> '' and website_normalized = n.d
     limit 1)
  -- 2. Updates body-text mentions (softer signal)
  union all
  (select 'affiliates_updates'::text, monday_item_id, null::text
     from affiliates_updates_table, n
     where n.d <> '' and body_text ilike '%' || n.d || '%'
     limit 1)
  union all
  (select 'leads_updates'::text, monday_item_id, null::text
     from leads_updates_table, n
     where n.d <> '' and body_text ilike '%' || n.d || '%'
     limit 1)
  union all
  (select 'not_relevant_leads_updates'::text, monday_item_id, null::text
     from not_relevant_leads_updates_table, n
     where n.d <> '' and body_text ilike '%' || n.d || '%'
     limit 1)
  union all
  (select 'email_undelivered_leads_updates'::text, monday_item_id, null::text
     from email_undelivered_leads_updates_table, n
     where n.d <> '' and body_text ilike '%' || n.d || '%'
     limit 1)
  limit 1;
$$;

grant execute on function public.search_website_on_monday(text) to service_role;
revoke execute on function public.search_website_on_monday(text) from anon, authenticated;

-- ------------------------------------------------------------
-- One-shot remap of existing data
-- ------------------------------------------------------------
update public.google_lead_gen_table
set monday_board = case
  when monday_board = 'affiliate' then 'affiliates'
  when monday_board = 'updates'   then null
  else monday_board
end
where monday_board in ('affiliate', 'updates');

-- Rows that lost their granular updates-bucket get is_on_monday cleared
-- too so the auto re-run picks them up fresh and assigns the correct
-- granular bucket. (Manually overridden rows are left alone.)
update public.google_lead_gen_table
set is_on_monday = null
where monday_board is null
  and is_on_monday = true
  and is_affiliate_overridden_at is null
  and monday_overridden_at is null;
