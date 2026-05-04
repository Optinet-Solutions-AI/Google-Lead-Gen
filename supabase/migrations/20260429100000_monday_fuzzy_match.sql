-- ============================================================
-- Migration: Fuzzy Monday duplicate match (registered-domain fallback)
--
-- QA reported many leads showing "Is on Monday: No" when the lead's
-- root domain is in fact on a Monday board. Common cause: subdomain
-- variants between the scrape and the Monday record.
--
--   Scraped URL                          Monday `website`      Old behavior
--   de.trustpilot.com/review/foo         trustpilot.com         miss
--   www.norgekasino.com                  norgekasino.com        hit (www stripped)
--   en-nz.new-zealand-online-pokies.it   new-zealand-online-…   miss
--   nzcasino.co.nz                       nzcasino.co.nz         hit (exact)
--
-- Fix: keep exact match as the priority-1 hit (fast, indexed), then
-- add a priority-2 fallback that matches by `registered_domain()` —
-- the domain stripped down to eTLD+1, with awareness of common
-- compound TLDs (.co.uk, .co.nz, .com.au, etc).
--
-- Returns a new match_kind column so the UI can show whether a hit
-- was an exact or fuzzy match.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Helper: extract the registered domain (eTLD+1)
-- ------------------------------------------------------------
create or replace function public.registered_domain(p_normalized text)
returns text
language plpgsql
immutable
parallel safe
as $$
declare
  v_parts text[];
  v_n int;
  v_tld2 text;
begin
  if p_normalized is null or p_normalized = '' then return ''; end if;
  v_parts := string_to_array(p_normalized, '.');
  v_n := array_length(v_parts, 1);
  if v_n is null or v_n < 2 then return p_normalized; end if;

  -- Compound TLD detection: take the last two segments and check
  -- whether they form a known multi-part TLD. If so, the registered
  -- domain is the last 3 segments; otherwise it's the last 2.
  if v_n >= 3 then
    v_tld2 := v_parts[v_n - 1] || '.' || v_parts[v_n];
    if v_tld2 in (
      'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk',
      'co.nz', 'org.nz', 'ac.nz', 'net.nz', 'govt.nz',
      'com.au', 'org.au', 'net.au', 'gov.au', 'edu.au', 'id.au',
      'co.za', 'org.za', 'ac.za',
      'co.jp', 'com.jp', 'ne.jp', 'or.jp', 'ac.jp',
      'com.br', 'net.br', 'org.br',
      'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'com.tw',
      'co.in', 'in.net', 'co.kr', 'or.kr', 'ne.kr',
      'co.il', 'co.th', 'co.id'
    ) then
      return v_parts[v_n - 2] || '.' || v_tld2;
    end if;
  end if;

  return v_parts[v_n - 1] || '.' || v_parts[v_n];
end;
$$;

grant execute on function public.registered_domain(text) to service_role, anon, authenticated;

-- ------------------------------------------------------------
-- 2. New column on google_lead_gen_table to record match strategy
-- ------------------------------------------------------------
alter table public.google_lead_gen_table
  add column if not exists monday_match_kind text;

-- ------------------------------------------------------------
-- 3. Updated search — exact match first, registered-domain fallback
--
-- Returns at most one row. Priority order:
--   1. Exact normalized match (fastest, indexed) across the 4 boards
--      in priority: affiliates → leads → not_relevant → email_undelivered
--   2. Same registered domain (catches subdomain variants) across the
--      4 boards in the same priority order
--
-- Note: must DROP first because we're adding `match_kind` to the
-- return table — Postgres treats that as a different return type and
-- CREATE OR REPLACE rejects it.
-- ------------------------------------------------------------
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
  -- ----- Priority 1: exact match -----
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
  -- Only fires when r differs from d (otherwise priority-1 already covered it).
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
  limit 1;
$$;

grant execute on function public.search_website_on_monday(text) to service_role;
revoke execute on function public.search_website_on_monday(text) from anon, authenticated;

-- ------------------------------------------------------------
-- 4. Updated bulk processor — also stores match_kind on the lead
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
    select l.id as lead_id, m.board, m.item_id, m.match_kind
    from leads l
    left join lateral (
      select * from search_website_on_monday(l.nd) limit 1
    ) m on true
  ),
  upd as (
    update google_lead_gen_table g
    set is_on_monday      = (r.item_id is not null),
        monday_board      = r.board,
        monday_item_id    = r.item_id,
        monday_match_kind = r.match_kind
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
-- 5. Backfill: re-run the duplicate check across every existing
-- lead so the QA-flagged false-negatives flip on migration apply.
-- This is safe to run multiple times — overwrites in place.
-- ------------------------------------------------------------
update public.google_lead_gen_table g
set is_on_monday      = (sub.item_id is not null),
    monday_board      = sub.board,
    monday_item_id    = sub.item_id,
    monday_match_kind = sub.match_kind
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
