-- ============================================================
-- Mirror-domain matching (priority 3) for search_website_on_monday.
--
-- QA reported 2026-06-25:
--   payid-pokies-australia.click — scraped lead, "not on Monday"
--   payid-pokies-australia.bet  — on Monday's Not Relevant board
--
-- Same casino operator, different TLDs. The exact + registered_domain
-- matchers correctly say "not the same domain." We want to roll those
-- up as the same item because for casino-affiliate work, mirror
-- domains nearly always belong to the same operator.
--
-- Risk: matching every "casino.com" to every "casino.net" because
-- the brand stem "casino" is shared by hundreds of unrelated sites.
--
-- Safe rule: only fire when the brand stem is at least 12 characters
-- AND the same stem is found on a Monday board. That filters out
-- generic 1-word brands ("casino", "bet365", "spin") while catching
-- specific multi-word names (payid-pokies-australia, casino-online-deutschland).
--
-- Adds match_kind = 'brand_stem' so operators can see this looser
-- rule fired and audit any false positives.
-- ============================================================

create or replace function public.brand_stem(p_normalized text)
returns text
language plpgsql
immutable
parallel safe
as $$
declare
  v_reg text;
  v_dot int;
begin
  if p_normalized is null or p_normalized = '' then return ''; end if;
  v_reg := public.registered_domain(p_normalized);
  if v_reg = '' then return ''; end if;
  -- Strip the TLD off the registered domain. registered_domain returns
  -- e.g. 'payid-pokies-australia.click' for the input — split on the
  -- LAST dot and keep what's before it.
  v_dot := length(v_reg) - position('.' in reverse(v_reg));
  if v_dot <= 0 then return ''; end if;
  return substring(v_reg from 1 for v_dot);
end;
$$;

grant execute on function public.brand_stem(text) to service_role, anon, authenticated;

-- Stale-plan safety: the matcher RPC is recreated with the same
-- return shape but a new third-tier branch. DROP first so any old
-- cached plan doesn't keep the previous body around.
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
      normalize_domain(p_domain)                                   as d,
      registered_domain(normalize_domain(p_domain))                as r,
      brand_stem(normalize_domain(p_domain))                       as s
  )
  -- ----- Priority 1: exact normalized match -----
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
  -- ----- Priority 2: registered-domain (eTLD+1) match -----
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
  -- ----- Priority 3: brand-stem match (mirror domains across TLDs) -----
  -- Only fires when the stem is at least 12 chars to keep generic
  -- brand names ("casino", "spin", "bet365") from false-matching
  -- across unrelated operators. The same-stem AND different-registered
  -- predicate ensures we only catch mirror TLDs, not the same-TLD
  -- variants priority 2 already handled.
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
  limit 1;
$$;

grant execute on function public.search_website_on_monday(text) to service_role;
revoke execute on function public.search_website_on_monday(text) from anon, authenticated;
