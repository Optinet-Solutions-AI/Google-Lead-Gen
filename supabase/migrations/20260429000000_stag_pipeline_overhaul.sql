-- ============================================================
-- Migration: S-tag pipeline overhaul (Stage 1 + Stage 2)
--
-- Adds the columns + RPC needed for the new VM-based s-tag flow:
--
--   redirect_chain  jsonb       — full chain captured by the
--                                 browser when it followed the
--                                 tracking link (Option 5)
--   screenshot_path text        — Storage object key for the
--                                 final landed page screenshot
--                                 (Option 5)
--   is_rooster_brand boolean    — true when the extracted brand
--                                 matches a row in rooster_brands
--                                 (Option 7)
--
-- New RPC replace_and_verify_s_tags_for_lead does in one call:
--   1. clears + inserts s_tags for the lead   (Option 1)
--   2. immediately runs the on-Monday dup-check for each tag    (Option 6 — auto-chain)
--   3. cross-references each tag's brand against rooster_brands (Option 7)
--   4. stamps the parent lead row's check timestamps
-- ============================================================

alter table public.s_tags_table
  add column if not exists redirect_chain   jsonb,
  add column if not exists screenshot_path  text,
  add column if not exists is_rooster_brand boolean;

create index if not exists idx_s_tags_is_rooster_brand
  on public.s_tags_table (is_rooster_brand)
  where is_rooster_brand = true;

-- ------------------------------------------------------------
-- Combined replace + verify RPC
-- ------------------------------------------------------------
create or replace function public.replace_and_verify_s_tags_for_lead(
  p_lead_id bigint,
  p_tags    jsonb
)
returns table(inserted integer, matched integer, rooster integer)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_inserted integer := 0;
  v_matched  integer := 0;
  v_rooster  integer := 0;
  v_first_id bigint;
  v_now      timestamptz := now();
begin
  delete from public.s_tags_table where lead_id = p_lead_id;

  if p_tags is not null and jsonb_typeof(p_tags) = 'array' then
    insert into public.s_tags_table (
      lead_id, s_tag, source_param, brand,
      tracking_url, final_url, redirect_chain, screenshot_path
    )
    select
      p_lead_id,
      t->>'s_tag',
      t->>'source_param',
      t->>'brand',
      t->>'tracking_url',
      t->>'final_url',
      t->'redirect_chain',
      t->>'screenshot_path'
    from jsonb_array_elements(p_tags) t
    where coalesce(t->>'s_tag', '') <> '';

    select count(*)::integer into v_inserted
    from public.s_tags_table where lead_id = p_lead_id;

    select id into v_first_id
    from public.s_tags_table
    where lead_id = p_lead_id
    order by id asc
    limit 1;
  end if;

  -- Auto-chain stage 6 (Option 6) — verify each new tag against Monday.
  with results as (
    select s.id as tag_id, m.kind, m.item_id
    from public.s_tags_table s
    left join lateral (
      select * from public.search_s_tag_on_monday(s.s_tag) limit 1
    ) m on true
    where s.lead_id = p_lead_id
  )
  update public.s_tags_table s
  set is_existing_on_monday = (r.item_id is not null),
      monday_match_kind     = r.kind,
      monday_match_item_id  = r.item_id
  from results r
  where s.id = r.tag_id;

  -- Option 7: cross-reference brand domain against the rooster_brands
  -- whitelist so we can tell "Rooster's own tag" from "competitor's tag".
  update public.s_tags_table s
  set is_rooster_brand = exists (
    select 1
    from public.rooster_brands r
    where r.is_active = true
      and lower(r.domain) = lower(coalesce(s.brand, ''))
  )
  where s.lead_id = p_lead_id;

  update public.google_lead_gen_table g
  set s_tag_id              = v_first_id,
      has_s_tags            = (v_inserted > 0),
      s_tags_checked_at     = v_now,
      stag_check_checked_at = v_now
  where g.id = p_lead_id;

  select count(*)::integer
    into v_matched
  from public.s_tags_table
  where lead_id = p_lead_id and is_existing_on_monday = true;

  select count(*)::integer
    into v_rooster
  from public.s_tags_table
  where lead_id = p_lead_id and is_rooster_brand = true;

  return query select v_inserted, v_matched, v_rooster;
end;
$$;

grant execute on function public.replace_and_verify_s_tags_for_lead(bigint, jsonb) to service_role;
revoke execute on function public.replace_and_verify_s_tags_for_lead(bigint, jsonb) from anon, authenticated;
