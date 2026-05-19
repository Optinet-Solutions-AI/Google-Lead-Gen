-- ============================================================
-- Add extracted_via column to s_tags_table.
--
-- The enrichment worker's S-tag extraction runs as desktop Chrome by
-- default. Casino-affiliate listing sites increasingly gate their
-- tracking-link stack behind a mobile UA / viewport / pointer:coarse
-- media query — so a desktop pass that returns zero links isn't
-- proof the page has none. Phase 1 of the mobile-rendering work is
-- a conditional retry: when the desktop pass yields zero tracking
-- links, the worker switches the running tab to iPhone UA + 375x812
-- viewport via CDP and re-extracts.
--
-- This column lets us measure how much of the lift the mobile pass
-- is actually providing (vs. desktop already getting it). Once we
-- know the ratio we can decide whether to upgrade to an always-two-
-- pass model.
-- ============================================================

alter table public.s_tags_table
  add column if not exists extracted_via text;

create index if not exists idx_s_tags_extracted_via
  on public.s_tags_table (extracted_via)
  where extracted_via is not null;

-- ------------------------------------------------------------
-- Patch replace_and_verify_s_tags_for_lead — INSERT now carries
-- extracted_via from the JSON tags payload. Rest of the RPC body
-- is unchanged from migration 20260429000000_stag_pipeline_overhaul.
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
      tracking_url, final_url, redirect_chain, screenshot_path,
      extracted_via
    )
    select
      p_lead_id,
      t->>'s_tag',
      t->>'source_param',
      t->>'brand',
      t->>'tracking_url',
      t->>'final_url',
      t->'redirect_chain',
      t->>'screenshot_path',
      t->>'extracted_via'
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
