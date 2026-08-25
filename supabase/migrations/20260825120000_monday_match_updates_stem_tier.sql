-- ============================================================
-- Add a "brand-stem mentioned in updates" match tier (tier 7).
--
-- Affiliates run domain NETWORKS across TLDs — brand.com / .net / .pro /
-- .website — and an item's Updates feed often lists just one (e.g.
-- best-online-casino-aussie.COM). When a scrape hits a sibling TLD
-- (best-online-casino-aussie.PRO), tier 6 (mentioned_in_updates) misses it
-- because it needs the EXACT registered domain in body_domains, and .pro != .com.
-- The fuzzy "possible matches" panel surfaces it for manual confirmation, but we
-- can auto-match it: if the scraped domain's brand STEM equals the stem of any
-- domain mentioned in an item's updates, it's the same brand. stem length >= 12
-- guards against short-stem false positives (same guard as the website brand_stem
-- tier 5).
--
-- body_domains is a generated column (can't derive another generated column from
-- it), so body_stems is generated from body_text directly via extract_brand_stems.
-- ============================================================

-- Extract brand-stems (>=12 chars) of every domain in free text.
create or replace function public.extract_brand_stems(p_text text)
returns text[]
language sql
immutable
parallel safe
as $$
  select coalesce(
           array_agg(distinct st) filter (where st is not null and length(st) >= 12),
           '{}'::text[])
  from (
    select public.brand_stem(d) as st
    from unnest(public.extract_normalized_domains(p_text)) as d
  ) s;
$$;
grant execute on function public.extract_brand_stems(text) to service_role, authenticated;

-- body_stems generated column + GIN index on each updates table.
alter table public.affiliates_updates_table
  add column if not exists body_stems text[]
  generated always as (public.extract_brand_stems(body_text)) stored;
alter table public.leads_updates_table
  add column if not exists body_stems text[]
  generated always as (public.extract_brand_stems(body_text)) stored;
alter table public.not_relevant_leads_updates_table
  add column if not exists body_stems text[]
  generated always as (public.extract_brand_stems(body_text)) stored;
alter table public.email_undelivered_leads_updates_table
  add column if not exists body_stems text[]
  generated always as (public.extract_brand_stems(body_text)) stored;

create index if not exists idx_affiliates_updates_body_stems
  on public.affiliates_updates_table using gin (body_stems);
create index if not exists idx_leads_updates_body_stems
  on public.leads_updates_table using gin (body_stems);
create index if not exists idx_not_relevant_updates_body_stems
  on public.not_relevant_leads_updates_table using gin (body_stems);
create index if not exists idx_email_undelivered_updates_body_stems
  on public.email_undelivered_leads_updates_table using gin (body_stems);

-- Rebuild the matcher with tier 7 appended (tiers 1-6 unchanged from
-- 20260713120000).
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
  -- 1. exact normalized (website column)
  (select 'affiliates'::text, monday_item_id, name, 'exact'::text
     from affiliates_table, n where n.d <> '' and website_normalized = n.d limit 1)
  union all (select 'leads'::text, monday_item_id, name, 'exact'::text
     from leads_table, n where n.d <> '' and website_normalized = n.d limit 1)
  union all (select 'not_relevant_leads'::text, monday_item_id, name, 'exact'::text
     from not_relevant_leads_table, n where n.d <> '' and website_normalized = n.d limit 1)
  union all (select 'email_undelivered_leads'::text, monday_item_id, name, 'exact'::text
     from email_undelivered_leads_table, n where n.d <> '' and website_normalized = n.d limit 1)
  -- 2. exact name (domain in the item title, empty website)
  union all (select 'affiliates'::text, monday_item_id, name, 'exact_name'::text
     from affiliates_table, n where n.d <> '' and coalesce(website_normalized,'')='' and name is not null and position('/' in name)=0 and normalize_domain(name)=n.d limit 1)
  union all (select 'leads'::text, monday_item_id, name, 'exact_name'::text
     from leads_table, n where n.d <> '' and coalesce(website_normalized,'')='' and name is not null and position('/' in name)=0 and normalize_domain(name)=n.d limit 1)
  union all (select 'not_relevant_leads'::text, monday_item_id, name, 'exact_name'::text
     from not_relevant_leads_table, n where n.d <> '' and coalesce(website_normalized,'')='' and name is not null and position('/' in name)=0 and normalize_domain(name)=n.d limit 1)
  union all (select 'email_undelivered_leads'::text, monday_item_id, name, 'exact_name'::text
     from email_undelivered_leads_table, n where n.d <> '' and coalesce(website_normalized,'')='' and name is not null and position('/' in name)=0 and normalize_domain(name)=n.d limit 1)
  -- 3. registered domain (website column)
  union all (select 'affiliates'::text, monday_item_id, name, 'registered'::text
     from affiliates_table, n where n.r <> '' and n.r <> n.d and registered_domain(website_normalized)=n.r limit 1)
  union all (select 'leads'::text, monday_item_id, name, 'registered'::text
     from leads_table, n where n.r <> '' and n.r <> n.d and registered_domain(website_normalized)=n.r limit 1)
  union all (select 'not_relevant_leads'::text, monday_item_id, name, 'registered'::text
     from not_relevant_leads_table, n where n.r <> '' and n.r <> n.d and registered_domain(website_normalized)=n.r limit 1)
  union all (select 'email_undelivered_leads'::text, monday_item_id, name, 'registered'::text
     from email_undelivered_leads_table, n where n.r <> '' and n.r <> n.d and registered_domain(website_normalized)=n.r limit 1)
  -- 4. registered domain from the item title
  union all (select 'affiliates'::text, monday_item_id, name, 'registered_name'::text
     from affiliates_table, n where n.r <> '' and n.r <> n.d and coalesce(website_normalized,'')='' and name is not null and position('/' in name)=0 and registered_domain(normalize_domain(name))=n.r limit 1)
  union all (select 'leads'::text, monday_item_id, name, 'registered_name'::text
     from leads_table, n where n.r <> '' and n.r <> n.d and coalesce(website_normalized,'')='' and name is not null and position('/' in name)=0 and registered_domain(normalize_domain(name))=n.r limit 1)
  union all (select 'not_relevant_leads'::text, monday_item_id, name, 'registered_name'::text
     from not_relevant_leads_table, n where n.r <> '' and n.r <> n.d and coalesce(website_normalized,'')='' and name is not null and position('/' in name)=0 and registered_domain(normalize_domain(name))=n.r limit 1)
  union all (select 'email_undelivered_leads'::text, monday_item_id, name, 'registered_name'::text
     from email_undelivered_leads_table, n where n.r <> '' and n.r <> n.d and coalesce(website_normalized,'')='' and name is not null and position('/' in name)=0 and registered_domain(normalize_domain(name))=n.r limit 1)
  -- 5. brand-stem (mirror TLDs, website column, stem >= 12)
  union all (select 'affiliates'::text, monday_item_id, name, 'brand_stem'::text
     from affiliates_table, n where n.s <> '' and length(n.s) >= 12 and brand_stem(website_normalized)=n.s and registered_domain(website_normalized) <> n.r limit 1)
  union all (select 'leads'::text, monday_item_id, name, 'brand_stem'::text
     from leads_table, n where n.s <> '' and length(n.s) >= 12 and brand_stem(website_normalized)=n.s and registered_domain(website_normalized) <> n.r limit 1)
  union all (select 'not_relevant_leads'::text, monday_item_id, name, 'brand_stem'::text
     from not_relevant_leads_table, n where n.s <> '' and length(n.s) >= 12 and brand_stem(website_normalized)=n.s and registered_domain(website_normalized) <> n.r limit 1)
  union all (select 'email_undelivered_leads'::text, monday_item_id, name, 'brand_stem'::text
     from email_undelivered_leads_table, n where n.s <> '' and length(n.s) >= 12 and brand_stem(website_normalized)=n.s and registered_domain(website_normalized) <> n.r limit 1)
  -- 6. mentioned in an item's updates (exact registered domain)
  union all (select 'affiliates'::text, i.monday_item_id, i.name, 'mentioned_in_updates'::text
     from affiliates_updates_table u join affiliates_table i on i.monday_item_id = u.monday_item_id cross join n where n.r <> '' and u.body_domains @> array[n.r] limit 1)
  union all (select 'leads'::text, i.monday_item_id, i.name, 'mentioned_in_updates'::text
     from leads_updates_table u join leads_table i on i.monday_item_id = u.monday_item_id cross join n where n.r <> '' and u.body_domains @> array[n.r] limit 1)
  union all (select 'not_relevant_leads'::text, i.monday_item_id, i.name, 'mentioned_in_updates'::text
     from not_relevant_leads_updates_table u join not_relevant_leads_table i on i.monday_item_id = u.monday_item_id cross join n where n.r <> '' and u.body_domains @> array[n.r] limit 1)
  union all (select 'email_undelivered_leads'::text, i.monday_item_id, i.name, 'mentioned_in_updates'::text
     from email_undelivered_leads_updates_table u join email_undelivered_leads_table i on i.monday_item_id = u.monday_item_id cross join n where n.r <> '' and u.body_domains @> array[n.r] limit 1)
  -- 7. brand-stem of a domain mentioned in updates (TLD variant of a listed domain)
  union all (select 'affiliates'::text, i.monday_item_id, i.name, 'mentioned_in_updates_stem'::text
     from affiliates_updates_table u join affiliates_table i on i.monday_item_id = u.monday_item_id cross join n where length(n.s) >= 12 and u.body_stems @> array[n.s] limit 1)
  union all (select 'leads'::text, i.monday_item_id, i.name, 'mentioned_in_updates_stem'::text
     from leads_updates_table u join leads_table i on i.monday_item_id = u.monday_item_id cross join n where length(n.s) >= 12 and u.body_stems @> array[n.s] limit 1)
  union all (select 'not_relevant_leads'::text, i.monday_item_id, i.name, 'mentioned_in_updates_stem'::text
     from not_relevant_leads_updates_table u join not_relevant_leads_table i on i.monday_item_id = u.monday_item_id cross join n where length(n.s) >= 12 and u.body_stems @> array[n.s] limit 1)
  union all (select 'email_undelivered_leads'::text, i.monday_item_id, i.name, 'mentioned_in_updates_stem'::text
     from email_undelivered_leads_updates_table u join email_undelivered_leads_table i on i.monday_item_id = u.monday_item_id cross join n where length(n.s) >= 12 and u.body_stems @> array[n.s] limit 1)
  limit 1;
$$;

grant execute on function public.search_website_on_monday(text) to service_role;
revoke execute on function public.search_website_on_monday(text) from anon, authenticated;
