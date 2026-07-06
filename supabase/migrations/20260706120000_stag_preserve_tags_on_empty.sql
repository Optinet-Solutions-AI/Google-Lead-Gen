-- ============================================================
-- Guard replace_and_verify_s_tags_for_lead against destructive
-- empty re-runs.
--
-- Bug (found 2026-07-06): the RPC opened with an UNCONDITIONAL
--   delete from s_tags_table where lead_id = p_lead_id
-- and only re-inserted when p_tags was a non-empty array. An s-tag
-- enrichment run that completed OK but extracted ZERO tracking links
-- ships tags=[] to score-row, which called this RPC with an empty
-- array — wiping the lead's existing (proven) s-tags and inserting
-- nothing. Reproduced live on lead 9733: 7 tags -> 0.
--
-- A zero-result run is NOT proof the site has no affiliate links: a
-- transient cookie-consent wall, proxy hiccup, geo-serve, or a
-- redirect-resolve failure all yield []. Losing proven s-tags to a
-- transient miss is unacceptable data loss.
--
-- Fix: when the incoming payload has no usable tag (null / not an
-- array / no element with a non-empty s_tag), PRESERVE the existing
-- rows and only stamp s_tags_checked_at (so the lead still records
-- that it was checked and isn't re-queued forever). Existing rows and
-- has_s_tags are left untouched. The normal replace path (a non-empty
-- payload fully replaces the set) is unchanged.
--
-- Single chokepoint: this protects every caller — the VM enrichment
-- worker, the in-app score-row ▶ action, and any backfill script.
-- Rest of the RPC body is unchanged from 20260519000000_stag_extracted_via.
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
  v_has_tags boolean := false;
begin
  -- Does the payload carry at least one usable tag (non-empty s_tag)?
  if p_tags is not null and jsonb_typeof(p_tags) = 'array' then
    select exists (
      select 1
      from jsonb_array_elements(p_tags) t
      where coalesce(t->>'s_tag', '') <> ''
    ) into v_has_tags;
  end if;

  -- GUARD: an empty/failed extraction must never destroy proven tags.
  -- Preserve existing rows; only record that we checked this lead.
  if not v_has_tags then
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
  where coalesce(t->>'s_tag', '') <> '';

  select count(*)::integer into v_inserted
  from public.s_tags_table where lead_id = p_lead_id;

  select id into v_first_id
  from public.s_tags_table
  where lead_id = p_lead_id
  order by id asc
  limit 1;

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
