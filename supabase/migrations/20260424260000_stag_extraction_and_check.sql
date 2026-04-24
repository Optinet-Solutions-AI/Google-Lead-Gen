-- ============================================================
-- Migration: S-Tag Extraction + Duplicate Check (Epic 7.5 + 7.6)
--
-- Stores affiliate-tracking S-tags extracted from each lead's
-- outbound tracking links + flags whether each tag is already
-- recorded against an item on Monday (via the Supabase mirror).
--
-- Schema mirrors the legacy `s_tags_table`. Key design points:
--   - Many s-tags can attach to one lead (one row per extracted tag)
--   - Each tag carries its source param (btag/stag/cxd/mid/affid)
--     because the param tells you the affiliate program
--   - On-Monday check is a Postgres RPC that searches across the
--     4 board tables + their updates (mirrors the catalog's
--     legacy search_s_tag_across_all_boards_and_updates)
-- ============================================================

create table if not exists public.s_tags_table (
  id                  bigint      generated always as identity primary key,
  lead_id             bigint      not null references public.google_lead_gen_table(id) on delete cascade,
  s_tag               text        not null,
  source_param        text,                          -- 'btag' | 'stag' | 'cxd' | 'mid' | 'affid'
  brand               text,                          -- guessed brand from final URL
  tracking_url        text,                          -- the affiliate-side link we followed
  final_url           text,                          -- where the chain ended
  is_existing_on_monday  boolean,                    -- result of 7.6 check
  monday_match_kind      text,                       -- 'item' | 'updates' | null
  monday_match_item_id   text,
  created_at          timestamptz not null default now()
);

alter table public.s_tags_table enable row level security;

create index if not exists idx_s_tags_lead_id on public.s_tags_table (lead_id);
create index if not exists idx_s_tags_value   on public.s_tags_table (lower(s_tag));

alter table public.google_lead_gen_table
  add column if not exists s_tags_checked_at         timestamptz,
  add column if not exists is_stag_overridden_at     timestamptz;

create index if not exists idx_glg_s_tag_id
  on public.google_lead_gen_table (s_tag_id)
  where s_tag_id is not null;

-- ------------------------------------------------------------
-- replace_s_tags_for_lead — atomic; clears + reinserts
-- ------------------------------------------------------------
create or replace function public.replace_s_tags_for_lead(
  p_lead_id bigint,
  p_tags    jsonb        -- [{ s_tag, source_param, brand, tracking_url, final_url }, ...]
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count       integer := 0;
  v_first_id    bigint;
begin
  delete from public.s_tags_table where lead_id = p_lead_id;

  if p_tags is not null and jsonb_typeof(p_tags) = 'array' then
    insert into public.s_tags_table (
      lead_id, s_tag, source_param, brand, tracking_url, final_url
    )
    select
      p_lead_id,
      t->>'s_tag',
      t->>'source_param',
      t->>'brand',
      t->>'tracking_url',
      t->>'final_url'
    from jsonb_array_elements(p_tags) t
    where coalesce(t->>'s_tag', '') <> ''
    returning id into v_first_id;

    select count(*) into v_count
    from public.s_tags_table where lead_id = p_lead_id;
  end if;

  update public.google_lead_gen_table
  set s_tag_id           = v_first_id,
      has_s_tags         = (v_count > 0),
      s_tags_checked_at  = now()
  where id = p_lead_id;

  return v_count;
end;
$$;

grant execute on function public.replace_s_tags_for_lead(bigint, jsonb) to service_role;
revoke execute on function public.replace_s_tags_for_lead(bigint, jsonb) from anon, authenticated;

-- ------------------------------------------------------------
-- search_s_tag_on_monday(tag) — single-row lookup across all
-- boards + their updates. Returns {kind, item_id} for the first
-- match, or no rows if not found.
-- ------------------------------------------------------------
create or replace function public.search_s_tag_on_monday(p_tag text)
returns table(kind text, item_id text)
language sql
stable
security definer
set search_path = public
as $$
  with t as (select lower(coalesce(p_tag, '')) as v)
  -- 1. body_text mention in any updates table
  (select 'updates'::text, monday_item_id from leads_updates_table, t
     where t.v <> '' and body_text ilike '%' || p_tag || '%' limit 1)
  union all
  (select 'updates'::text, monday_item_id from affiliates_updates_table, t
     where t.v <> '' and body_text ilike '%' || p_tag || '%' limit 1)
  union all
  (select 'updates'::text, monday_item_id from not_relevant_leads_updates_table, t
     where t.v <> '' and body_text ilike '%' || p_tag || '%' limit 1)
  union all
  (select 'updates'::text, monday_item_id from email_undelivered_leads_updates_table, t
     where t.v <> '' and body_text ilike '%' || p_tag || '%' limit 1)
  -- 2. Mention in raw_column_values of any item (catches s-tag stored as a column value)
  union all
  (select 'item'::text, monday_item_id from leads_table, t
     where t.v <> '' and raw_column_values::text ilike '%' || p_tag || '%' limit 1)
  union all
  (select 'item'::text, monday_item_id from affiliates_table, t
     where t.v <> '' and raw_column_values::text ilike '%' || p_tag || '%' limit 1)
  union all
  (select 'item'::text, monday_item_id from not_relevant_leads_table, t
     where t.v <> '' and raw_column_values::text ilike '%' || p_tag || '%' limit 1)
  union all
  (select 'item'::text, monday_item_id from email_undelivered_leads_table, t
     where t.v <> '' and raw_column_values::text ilike '%' || p_tag || '%' limit 1)
  limit 1;
$$;

grant execute on function public.search_s_tag_on_monday(text) to service_role;
revoke execute on function public.search_s_tag_on_monday(text) from anon, authenticated;

-- ------------------------------------------------------------
-- mark_s_tag_duplicates_for_job — bulk processor (Epic 7.6)
-- Looks up every s-tag attached to a job's leads against Monday
-- and writes the result back onto s_tags_table.
-- ------------------------------------------------------------
create or replace function public.mark_s_tag_duplicates_for_job(p_job_id uuid)
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
  with target_tags as (
    select t.id, t.s_tag
    from s_tags_table t
    join google_lead_gen_table g on g.id = t.lead_id
    where g.scrape_job_id = p_job_id
  ),
  results as (
    select tt.id as tag_id, m.kind, m.item_id
    from target_tags tt
    left join lateral (
      select * from search_s_tag_on_monday(tt.s_tag) limit 1
    ) m on true
  ),
  upd as (
    update s_tags_table s
    set is_existing_on_monday = (r.item_id is not null),
        monday_match_kind     = r.kind,
        monday_match_item_id  = r.item_id
    from results r
    where s.id = r.tag_id
    returning s.is_existing_on_monday
  )
  select count(*)::integer, count(*) filter (where is_existing_on_monday)::integer
    into v_checked, v_matched
  from upd;

  return query select v_checked, v_matched;
end;
$$;

grant execute on function public.mark_s_tag_duplicates_for_job(uuid) to service_role;
revoke execute on function public.mark_s_tag_duplicates_for_job(uuid) from anon, authenticated;
