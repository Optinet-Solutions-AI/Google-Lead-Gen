-- ============================================================
-- Migration: Propagate s-tag Rooster matches to the lead row
--
-- Bug: the Rooster-partner stage (stage 3) only looks at raw HTML
-- href attributes. Affiliate sites route brand links through tracking
-- redirects (`/go/lucky7even`, `?dest=…`), so the brand domain is
-- never literally in the page source — Rooster check returns NO.
--
-- The S-tag stage (stage 5) DOES catch this: it follows tracking
-- redirects in the browser, finds the resolved brand domain, and
-- marks individual s_tags_table rows with is_rooster_brand=true.
-- But the RPC never propagated that match back to the parent lead's
-- is_rooster_partner flag — so the leads UI kept showing "No" even
-- when the s-tags clearly proved the site is promoting our brands.
--
-- This migration:
--   1. Updates replace_and_verify_s_tags_for_lead to also set
--      google_lead_gen_table.is_rooster_partner = true when ANY of
--      the lead's s-tags matched a Rooster brand. Respects manual
--      overrides — leaves is_rooster_overridden_at-stamped rows alone.
--   2. Backfills existing leads in the same way, one-time.
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

  -- Stage 6 — verify each new tag against the Monday mirror.
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

  -- Cross-reference each tag's brand domain against the active
  -- Rooster whitelist.
  update public.s_tags_table s
  set is_rooster_brand = exists (
    select 1
    from public.rooster_brands r
    where r.is_active = true
      and lower(r.domain) = lower(coalesce(s.brand, ''))
  )
  where s.lead_id = p_lead_id;

  -- Stamp s-tag check timestamps on the parent lead row.
  update public.google_lead_gen_table g
  set s_tag_id              = v_first_id,
      has_s_tags            = (v_inserted > 0),
      s_tags_checked_at     = v_now,
      stag_check_checked_at = v_now
  where g.id = p_lead_id;

  -- NEW: propagate any Rooster match back to the parent lead's
  -- is_rooster_partner flag. This is what fixes the false-negative
  -- "Rooster brand: NO" on affiliate sites that hide their brand
  -- links behind tracking redirects.
  update public.google_lead_gen_table g
  set is_rooster_partner = true,
      brand              = coalesce(g.brand, sub.first_brand),
      rooster_checked_at = coalesce(g.rooster_checked_at, v_now)
  from (
    select min(s.brand) as first_brand
    from public.s_tags_table s
    where s.lead_id = p_lead_id and s.is_rooster_brand = true
  ) sub
  where g.id = p_lead_id
    and g.is_rooster_overridden_at is null
    and sub.first_brand is not null;

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

-- ------------------------------------------------------------
-- One-time backfill: existing leads whose s-tags already
-- caught a Rooster brand but never got their lead flag flipped.
-- Skips manually-overridden rows.
-- ------------------------------------------------------------
update public.google_lead_gen_table g
set is_rooster_partner = true,
    brand              = coalesce(g.brand, sub.first_brand),
    rooster_checked_at = coalesce(g.rooster_checked_at, now())
from (
  select s.lead_id, min(s.brand) as first_brand
  from public.s_tags_table s
  where s.is_rooster_brand = true
  group by s.lead_id
) sub
where g.id = sub.lead_id
  and g.is_rooster_overridden_at is null
  and (g.is_rooster_partner is null or g.is_rooster_partner = false)
  and sub.first_brand is not null;
