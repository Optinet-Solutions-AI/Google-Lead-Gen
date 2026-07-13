-- ============================================================
-- Restore the name-fallback + updates tiers to search_website_on_monday.
--
-- REGRESSION: 20260625000000_mirror_domain_match.sql rebuilt this RPC
-- from the OLD fuzzy-match base (exact + registered) and added a new
-- brand_stem tier — but in doing so it silently dropped two tiers that
-- had shipped earlier:
--   * exact_name / registered_name (20260522060001) — match items whose
--     domain lives in the ITEM TITLE with an empty website column
--     (~720 such items across the 4 boards).
--   * mentioned_in_updates (20260505000000) — match a domain that only
--     appears in an item's updates/comments feed.
--
-- QA (Supriya, batch 1873, 2026-07-13) reported leads on Monday showing
-- "No" under Is-on-Monday. Confirmed live:
--   * casibella.com   → affiliates item 1244662325, name="casibella.com",
--                       website="" → needs exact_name. Was 0 hits.
--   * esportsinsider.com → mentioned only in an update on coincierge.de
--                       (affiliates item 1237399152) → needs
--                       mentioned_in_updates. Was 0 hits.
--
-- This migration recreates the function with the full, correct tier set,
-- in priority order (first hit wins; board priority affiliates → leads →
-- not_relevant → email_undelivered within each tier):
--   1. exact
--   2. exact_name
--   3. registered
--   4. registered_name
--   5. brand_stem        (kept from 20260625 — mirror TLDs, stem >= 12)
--   6. mentioned_in_updates
--
-- brand_stem() is already defined by 20260625000000; unchanged here.
-- Pure function-replace; no data change until rematch runs afterwards.
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
      normalize_domain(p_domain)                    as d,
      registered_domain(normalize_domain(p_domain)) as r,
      brand_stem(normalize_domain(p_domain))        as s
  )
  -- ----- Priority 1: exact normalized (website column) -----
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
  -- ----- Priority 2: exact name (domain lives in the item title) -----
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
  -- ----- Priority 3: registered-domain (eTLD+1, website column) -----
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
  -- ----- Priority 4: registered-domain from the item title -----
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
  -- ----- Priority 5: brand-stem (mirror domains across TLDs, stem >= 12) -----
  union all
  (select 'affiliates'::text, monday_item_id, name, 'brand_stem'::text
     from affiliates_table, n
     where n.s <> '' and length(n.s) >= 12
       and brand_stem(website_normalized) = n.s
       and registered_domain(website_normalized) <> n.r
     limit 1)
  union all
  (select 'leads'::text, monday_item_id, name, 'brand_stem'::text
     from leads_table, n
     where n.s <> '' and length(n.s) >= 12
       and brand_stem(website_normalized) = n.s
       and registered_domain(website_normalized) <> n.r
     limit 1)
  union all
  (select 'not_relevant_leads'::text, monday_item_id, name, 'brand_stem'::text
     from not_relevant_leads_table, n
     where n.s <> '' and length(n.s) >= 12
       and brand_stem(website_normalized) = n.s
       and registered_domain(website_normalized) <> n.r
     limit 1)
  union all
  (select 'email_undelivered_leads'::text, monday_item_id, name, 'brand_stem'::text
     from email_undelivered_leads_table, n
     where n.s <> '' and length(n.s) >= 12
       and brand_stem(website_normalized) = n.s
       and registered_domain(website_normalized) <> n.r
     limit 1)
  -- ----- Priority 6: mentioned in a board item's updates/comments feed -----
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
