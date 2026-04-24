-- ============================================================
-- Migration: Monday Duplicate Check (Epic 7.1)
--
-- Adds the "is this lead already on Monday?" check.
--
--   1. normalize_domain(text)            — IMMUTABLE; strips
--      protocol, www, path, query, case.
--   2. website_normalized                — generated/indexed
--      column on each of the 4 Monday board tables.
--   3. monday_board + monday_item_id     — new columns on
--      google_lead_gen_table to record the match.
--   4. search_website_on_monday(text)    — single-row lookup
--      across the 4 boards, priority: affiliates → leads →
--      not_relevant → email_undelivered.
--   5. mark_monday_duplicates_for_job(uuid)
--                                        — bulk processor:
--      sets is_on_monday true/false on every row in a scrape
--      job, plus monday_board / monday_item_id when matched.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Domain normalisation
-- ------------------------------------------------------------
create or replace function public.normalize_domain(p_input text)
returns text
language sql
immutable
parallel safe
as $$
  select lower(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(coalesce(p_input, ''), '^https?://', ''),
          '^www\.', ''
        ),
        '[/?#].*$', ''
      ),
      '\.+$', ''
    )
  );
$$;

grant execute on function public.normalize_domain(text) to service_role, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Generated columns + indexes on the 4 Monday board tables
-- ------------------------------------------------------------
alter table public.leads_table
  add column if not exists website_normalized text
  generated always as (public.normalize_domain(website)) stored;

alter table public.affiliates_table
  add column if not exists website_normalized text
  generated always as (public.normalize_domain(website)) stored;

alter table public.not_relevant_leads_table
  add column if not exists website_normalized text
  generated always as (public.normalize_domain(website)) stored;

alter table public.email_undelivered_leads_table
  add column if not exists website_normalized text
  generated always as (public.normalize_domain(website)) stored;

create index if not exists idx_leads_website_normalized
  on public.leads_table (website_normalized)
  where website_normalized is not null and website_normalized <> '';

create index if not exists idx_affiliates_website_normalized
  on public.affiliates_table (website_normalized)
  where website_normalized is not null and website_normalized <> '';

create index if not exists idx_not_relevant_website_normalized
  on public.not_relevant_leads_table (website_normalized)
  where website_normalized is not null and website_normalized <> '';

create index if not exists idx_email_undelivered_website_normalized
  on public.email_undelivered_leads_table (website_normalized)
  where website_normalized is not null and website_normalized <> '';

-- ------------------------------------------------------------
-- 3. Track the match on google_lead_gen_table
-- ------------------------------------------------------------
alter table public.google_lead_gen_table
  add column if not exists monday_board   text,
  add column if not exists monday_item_id text;

create index if not exists idx_glg_is_on_monday
  on public.google_lead_gen_table (is_on_monday)
  where is_on_monday is not null;

create index if not exists idx_glg_monday_item_id
  on public.google_lead_gen_table (monday_item_id)
  where monday_item_id is not null;

-- ------------------------------------------------------------
-- 4. Single-row lookup across all 4 boards
--
-- Priority order: affiliates > leads > not_relevant > email_undelivered.
-- Affiliates first because matching one of those means it's a Rooster
-- brand we already own — the most important flag.
-- Returns at most one row.
-- ------------------------------------------------------------
create or replace function public.search_website_on_monday(p_domain text)
returns table(board text, item_id text, item_name text)
language sql
stable
security definer
set search_path = public
as $$
  with n as (select normalize_domain(p_domain) as d)
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
  limit 1;
$$;

grant execute on function public.search_website_on_monday(text) to service_role;
revoke execute on function public.search_website_on_monday(text) from anon, authenticated;

-- ------------------------------------------------------------
-- 5. Bulk processor for a scrape job
--
-- For every row in google_lead_gen_table belonging to p_job_id:
--   - looks up the lead's domain across the 4 Monday boards
--   - sets is_on_monday true/false explicitly (no NULLs left after run)
--   - sets monday_board + monday_item_id when matched
--
-- Safe to re-run; overwrites previous results for the job.
--
-- Returns a single-row { checked, matched } summary.
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
    select l.id as lead_id, m.board, m.item_id
    from leads l
    left join lateral (
      select * from search_website_on_monday(l.nd) limit 1
    ) m on true
  ),
  upd as (
    update google_lead_gen_table g
    set is_on_monday   = (r.item_id is not null),
        monday_board   = r.board,
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
