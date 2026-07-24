-- ============================================================
-- Allow replace_and_verify_s_tags_for_lead to persist rows with
-- an empty s_tag when a brand is recorded.
--
-- Context: affiliate review sites cloak the actual tracking tag
-- behind JS/redirect chains that sometimes land on the operator's
-- own domain with no query params and no cookies. The affiliate
-- STILL promotes that brand — the tag is just invisible to us.
-- New expectation (2026-07-24): keep the brand row even when the
-- tag is empty. Operators need "affiliate X promotes brands
-- A, B, C, ..." even when we can't attribute the specific tag.
--
-- Backwards-compatible: the existing "prove-tags-non-empty" guard
-- still fires when the payload has NO usable brand-or-tag rows
-- (protects against the destructive empty-extraction bug fixed
-- in 20260706120000). What's changed: a row is "usable" when it
-- has EITHER a non-empty s_tag OR a non-empty brand.
-- ============================================================

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
  v_has_usable boolean := false;
begin
  -- Does the payload carry at least one usable row (non-empty s_tag
  -- OR non-empty brand)? Empty on both is a genuine dead extraction.
  if p_tags is not null and jsonb_typeof(p_tags) = 'array' then
    select exists (
      select 1
      from jsonb_array_elements(p_tags) t
      where coalesce(t->>'s_tag', '') <> ''
         or coalesce(t->>'brand', '') <> ''
    ) into v_has_usable;
  end if;

  -- GUARD: keep the protective behaviour from 20260706120000 when
  -- the payload is truly empty (transient consent-wall / geo-block
  -- misses would otherwise destroy proven tags). Only fire the
  -- guard when NO row has either tag or brand.
  if not v_has_usable then
    update public.google_lead_gen_table g
    set s_tags_checked_at     = v_now,
        stag_check_checked_at = v_now
    where g.id = p_lead_id;
    return query select 0, 0, 0;
    return;
  end if;

  -- Non-empty payload: replace the full set (original behaviour).
  delete from public.s_tags_table where lead_id = p_lead_id;

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
  -- Keep every row with EITHER a tag or a brand. Empty-both is
  -- garbage from a broken extraction — skip it.
  where coalesce(t->>'s_tag', '') <> ''
     or coalesce(t->>'brand', '') <> '';

  select count(*)::integer into v_inserted
  from public.s_tags_table where lead_id = p_lead_id;

  select id into v_first_id
  from public.s_tags_table
  where lead_id = p_lead_id
  order by id asc
  limit 1;

  -- Monday match runs on the s_tag value. Brand-only rows won't
  -- match here (they have no tag to search) so they get
  -- is_existing_on_monday = false / monday_match_kind = null —
  -- which is correct: we know the brand but not the tag.
  with results as (
    select s.id as tag_id, m.kind, m.item_id
    from public.s_tags_table s
    left join lateral (
      select * from public.search_s_tag_on_monday(s.s_tag) limit 1
    ) m on true
    where s.lead_id = p_lead_id
      and coalesce(s.s_tag, '') <> ''
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
