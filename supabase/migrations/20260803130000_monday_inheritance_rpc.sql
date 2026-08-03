-- ============================================================
-- Contact-extraction v3 — Monday inheritance RPCs (LGP-219..223)
--
-- inherit_monday_data_for_lead(lead_id): pull a matched Monday item's
-- data into our tables, labeled Monday-sourced —
--   * contacts  (email + website)          → contact_table via v2 upsert
--   * s-tags    (brand tracking-id columns) → s_tags_table (origin=monday)
--   * class'n   (affiliate / rooster / brand) + provenance on the lead
--   * flags     has_contact_details / has_s_tags / *_checked_at so the
--               enrichment skip gate treats these stages as satisfied
-- Mirrors lib/monday/inherit.ts (unit-tested there). Idempotent per lead
-- (stamps monday_inherited_at; s-tag inserts guarded by not-exists).
--
-- inherit_monday_data_batch(limit): inherit for un-inherited on-Monday
-- leads — drives both the automatic tick and the backfill (LGP-232).
-- ============================================================

create or replace function public.inherit_monday_data_for_lead(p_lead_id bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_item        jsonb;
  v_board       text;
  v_email       text;
  v_website     text;
  v_src         text;
  v_emails      jsonb := '[]'::jsonb;
  v_items       jsonb := '[]'::jsonb;
  v_contact_url text  := null;
  v_has_contact boolean := false;
  v_is_rooster  boolean := false;
  v_is_aff      boolean := null;
  v_brand       text  := null;
  v_stags       int   := 0;
  v_bc          jsonb;
  v_colval      text;
  v_id          text;
  -- brand tracking-id columns → brand family + rooster flag
  v_brandcols   jsonb := jsonb_build_array(
    jsonb_build_object('col','l7_sj_rs_lv_ro','brand','Lucky7Even / SpinJo / RocketSpin / LuckyVibe / Rollero'),
    jsonb_build_object('col','rb_fp_su','brand','Rooster.bet / FortunePlay / SpinsUp'),
    jsonb_build_object('col','pm','brand','PlayMojo'),
    jsonb_build_object('col','nd','brand','NovaDreams')
  );
begin
  v_item := public.get_monday_item_for_lead(p_lead_id);
  if v_item is null then
    update public.google_lead_gen_table set monday_inherited_at = now() where id = p_lead_id;
    return jsonb_build_object('inherited', false, 'reason', 'no_monday_item');
  end if;
  v_board := v_item->>'_board';
  v_src   := 'https://monday.com/boards/item/' || coalesce(v_item->>'monday_item_id','');

  -- ---- contacts: email + website ----
  v_email := lower(trim(coalesce(v_item->>'email','')));
  if v_email <> '' and position('@' in v_email) > 1
     and position('.' in split_part(v_email,'@',2)) > 0 and v_email !~ '\s' then
    v_emails := jsonb_build_array(v_email);
    v_items  := v_items || jsonb_build_array(jsonb_build_object(
      'kind','email','value',v_email,'method','monday','sourceUrl',v_src,'confidence',0.9,'label','monday.com'));
    v_has_contact := true;
  end if;
  v_website := trim(coalesce(v_item->>'website',''));
  if v_website ~* '^https?://' then
    v_contact_url := v_website;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'kind','contact_link','value',v_website,'method','monday','sourceUrl',v_src,'confidence',0.6,'label','monday.com site'));
    v_has_contact := true;
  end if;
  if v_has_contact then
    perform public.upsert_contact_for_lead_v2(
      p_lead_id, v_emails, '[]'::jsonb, v_contact_url, 'monday',
      jsonb_build_object('monday_item_id', v_item->>'monday_item_id', 'inherited', true),
      v_items, '[]'::jsonb, null, '[]'::jsonb);
  end if;

  -- ---- s-tags: brand tracking-id columns (rooster) ----
  for v_bc in select value from jsonb_array_elements(v_brandcols) loop
    v_colval := coalesce(v_item->>(v_bc->>'col'), '');
    if v_colval <> '' then
      v_is_rooster := true;
      if v_brand is null then v_brand := v_bc->>'brand'; end if;
      for v_id in
        select trim(x) from regexp_split_to_table(v_colval, '[,\t\s;]+') as t(x)
        where trim(x) ~ '^[A-Za-z0-9_-]{2,}$'
      loop
        insert into public.s_tags_table (lead_id, s_tag, brand, is_rooster_brand, origin)
        select p_lead_id, v_id, v_bc->>'brand', true, 'monday'
        where not exists (select 1 from public.s_tags_table s where s.lead_id = p_lead_id and s.s_tag = v_id);
        if found then v_stags := v_stags + 1; end if;
      end loop;
    end if;
  end loop;
  -- affiliate_id column (not-relevant / email boards) → plain s-tags
  v_colval := coalesce(v_item->>'affiliate_id','');
  if v_colval <> '' then
    for v_id in
      select trim(x) from regexp_split_to_table(v_colval, '[,\t\s;]+') as t(x)
      where trim(x) ~ '^[A-Za-z0-9_-]{2,}$'
    loop
      insert into public.s_tags_table (lead_id, s_tag, origin)
      select p_lead_id, v_id, 'monday'
      where not exists (select 1 from public.s_tags_table s where s.lead_id = p_lead_id and s.s_tag = v_id);
      if found then v_stags := v_stags + 1; end if;
    end loop;
  end if;

  -- ---- classification ----
  if v_board = 'affiliates' or v_is_rooster then v_is_aff := true; end if;

  update public.google_lead_gen_table g set
    is_affiliate       = case when v_is_aff is true then true else g.is_affiliate end,
    affiliate_source   = case when v_is_aff is true and g.affiliate_source is null then 'monday' else g.affiliate_source end,
    is_rooster_partner = case when v_is_rooster and g.is_rooster_overridden_at is null then true else g.is_rooster_partner end,
    rooster_source     = case when v_is_rooster and g.is_rooster_overridden_at is null and g.rooster_source is null then 'monday' else g.rooster_source end,
    brand              = coalesce(g.brand, case when v_is_rooster then v_brand else null end),
    has_contact_details = case when v_has_contact then true else g.has_contact_details end,
    has_s_tags          = case when v_stags > 0 then true else g.has_s_tags end,
    contact_checked_at  = case when v_has_contact then coalesce(g.contact_checked_at, now()) else g.contact_checked_at end,
    s_tags_checked_at   = case when v_stags > 0 then coalesce(g.s_tags_checked_at, now()) else g.s_tags_checked_at end,
    monday_inherited_at = now()
  where g.id = p_lead_id;

  return jsonb_build_object(
    'inherited', true, 'board', v_board, 'has_contact', v_has_contact,
    'stags', v_stags, 'is_affiliate', v_is_aff, 'is_rooster', v_is_rooster, 'brand', v_brand);
end;
$$;

grant execute on function public.inherit_monday_data_for_lead(bigint) to service_role;

-- Batch driver: inherit for on-Monday leads not yet processed. Powers the
-- automatic tick and the backfill. Ordered by id for stable paging.
create or replace function public.inherit_monday_data_batch(p_limit int default 200)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id   bigint;
  v_done int := 0;
begin
  for v_id in
    select id from public.google_lead_gen_table
    where is_on_monday = true and monday_inherited_at is null
    order by id
    limit greatest(1, least(p_limit, 2000))
  loop
    perform public.inherit_monday_data_for_lead(v_id);
    v_done := v_done + 1;
  end loop;
  return jsonb_build_object('processed', v_done);
end;
$$;

grant execute on function public.inherit_monday_data_batch(int) to service_role;
