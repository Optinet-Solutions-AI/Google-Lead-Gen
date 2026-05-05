-- ============================================================
-- Migration: Tier-3 Monday match — pre-extracted domain index on updates
--
-- The team often pastes additional affiliate URLs as comments/posts on
-- a Monday item rather than creating a new item per domain (e.g. one
-- "Brand X" item with `website = brandx.com` plus an update reading
-- "their other site is brandx-mirror.com"). The duplicate-check used
-- to miss those.
--
-- Approach: at sync time, parse every URL/host out of `body_text` and
-- store the normalized + registered forms in a `body_domains text[]`
-- generated column on each *_updates_table. Add a GIN index so tier-3
-- becomes an indexed `body_domains @> array['…']` containment probe
-- instead of a per-row regex scan.
--
-- The same extraction also runs on body_html via body_text — Monday's
-- sync stores both, but body_text is the plain prose we care about.
-- ============================================================

-- ------------------------------------------------------------
-- 1. extract_normalized_domains(text) — extract every URL / host-like
-- token out of free-form text. For each, push BOTH the normalized form
-- AND the registered (eTLD+1) form into the result so a body that says
-- "staging.brandx.com" matches a lead with registered domain
-- "brandx.com" via simple array containment.
-- ------------------------------------------------------------
create or replace function public.extract_normalized_domains(p_text text)
returns text[]
language plpgsql
immutable
parallel safe
as $$
declare
  v_result text[] := '{}'::text[];
  v_match  text;
  v_norm   text;
  v_reg    text;
begin
  if p_text is null or p_text = '' then return '{}'::text[]; end if;

  -- Match URLs (with http(s)://) and bare host tokens. The trailing
  -- TLD constraint of [a-z]{2,} avoids matching version numbers like
  -- "1.0.4" or filenames like "report.v2".
  for v_match in
    select (regexp_matches(
      p_text,
      '((?:https?://)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})',
      'gi'
    ))[1]
  loop
    v_norm := public.normalize_domain(v_match);
    if v_norm is null or v_norm = '' then continue; end if;
    v_result := array_append(v_result, v_norm);
    v_reg := public.registered_domain(v_norm);
    if v_reg is not null and v_reg <> '' and v_reg <> v_norm then
      v_result := array_append(v_result, v_reg);
    end if;
  end loop;

  -- Dedupe + sort for stable storage / indexing.
  select array_agg(distinct d order by d) into v_result from unnest(v_result) d;
  return coalesce(v_result, '{}'::text[]);
end;
$$;

grant execute on function public.extract_normalized_domains(text)
  to service_role, anon, authenticated;

-- ------------------------------------------------------------
-- 2. body_domains generated column + GIN index on each *_updates_table
-- ------------------------------------------------------------
alter table public.leads_updates_table
  add column if not exists body_domains text[]
  generated always as (public.extract_normalized_domains(body_text)) stored;

alter table public.affiliates_updates_table
  add column if not exists body_domains text[]
  generated always as (public.extract_normalized_domains(body_text)) stored;

alter table public.not_relevant_leads_updates_table
  add column if not exists body_domains text[]
  generated always as (public.extract_normalized_domains(body_text)) stored;

alter table public.email_undelivered_leads_updates_table
  add column if not exists body_domains text[]
  generated always as (public.extract_normalized_domains(body_text)) stored;

create index if not exists idx_leads_updates_body_domains
  on public.leads_updates_table using gin (body_domains);
create index if not exists idx_affiliates_updates_body_domains
  on public.affiliates_updates_table using gin (body_domains);
create index if not exists idx_not_relevant_leads_updates_body_domains
  on public.not_relevant_leads_updates_table using gin (body_domains);
create index if not exists idx_email_undelivered_leads_updates_body_domains
  on public.email_undelivered_leads_updates_table using gin (body_domains);

-- ------------------------------------------------------------
-- 3. Updated search_website_on_monday — tier 3 is now an indexed
-- containment probe against body_domains. No regex at query time.
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
  -- ----- Priority 3: mentioned in board updates (indexed lookup) -----
  -- Joins each updates table to its parent items table so we return the
  -- item's id + name rather than the update id.
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
-- 4. Backfill — re-run the duplicate check across every non-overridden
-- lead so new tier-3 hits surface immediately.
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
