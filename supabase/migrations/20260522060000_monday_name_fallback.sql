-- ============================================================
-- Migration: name-as-domain fallback in search_website_on_monday
--
-- Issue (Charisse QA report on lead 12530 / casinoohneoasis.com):
-- Monday item 1241308533 on the affiliates board has
--   name      = 'casinoohneoasis.com'
--   website   = ''
--   website_normalized = ''
-- so the brand domain is present as the item *title*, but our
-- duplicate-check RPC only joins on website_normalized and returns
-- "not on Monday" for any lead with that domain.
--
-- Quantified across the 4 board tables, 720 items follow this
-- "title-is-the-domain, no website column" pattern:
--   leads_table                    165
--   affiliates_table               413
--   not_relevant_leads_table       119  (also blocks is_not_relevant auto-flag)
--   email_undelivered_leads_table   23
-- Every lead scraped against any of those 720 brands has been
-- incorrectly stamped is_on_monday=false (and for not_relevant_leads,
-- has been incorrectly *kept* enabled in /leads + enrichment).
--
-- Fix: add two new tiers to search_website_on_monday that fall back
-- to the item's `name` column when website_normalized is empty:
--
--   Priority 1.5 (exact_name)      — name has no '/' AND
--                                    normalize_domain(name) = scraped.d
--   Priority 2.5 (registered_name) — name has no '/' AND
--                                    registered_domain(normalize_domain(name)) = scraped.r
--
-- The 'no slash in name' guard avoids false positives from items
-- whose name is a profile URL (e.g. 'kick.com/xdarlov',
-- 'twitch.tv/yasar92') — those would otherwise hijack every
-- kick.com / twitch.tv scrape via name normalization to the host.
--
-- Tiers 1 and 2 (website-based) still run first, so when an item
-- has BOTH a website and a name the website wins. Tier 3
-- (mentioned_in_updates) is unchanged.
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
  -- ----- Priority 1: exact website match -----
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
  -- ----- Priority 1.5: name-as-domain when website is empty -----
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
  -- ----- Priority 2: registered-domain (eTLD+1) match on website -----
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
  -- ----- Priority 2.5: registered-domain match on name when website is empty -----
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
  -- ----- Priority 3: mentioned in board updates (unchanged) -----
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
-- Backfill: re-evaluate every non-overridden lead against the new
-- matcher. Same shape as the 20260505000000 backfill but also picks
-- up monday_checked_at stamping restored in 20260522050000, and
-- propagates is_not_relevant when the new exact_name / registered_name
-- hits land on the not_relevant_leads board.
-- ------------------------------------------------------------
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
from (
  select g.id as lead_id, m.board, m.item_id, m.match_kind
  from public.google_lead_gen_table g
  left join lateral (
    select * from public.search_website_on_monday(
      public.normalize_domain(coalesce(g.domain, g.url))
    ) limit 1
  ) m on true
  where g.monday_overridden_at is null
) sub
where g.id = sub.lead_id
  and g.monday_overridden_at is null;

-- ------------------------------------------------------------
-- Backfill cleanup: cancel in-flight enrichment for any leads that
-- got flipped to is_not_relevant=true above, matching the pattern
-- from 20260505010000.
-- ------------------------------------------------------------
update public.enrichment_fetch_queue q
set status = 'cancelled', updated_at = now()
where q.status in ('pending', 'paused')
  and exists (
    select 1 from public.google_lead_gen_table g
    where g.id = q.lead_id
      and g.is_not_relevant = true
  );
