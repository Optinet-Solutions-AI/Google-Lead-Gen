-- ============================================================
-- Contact-extraction v3 — per-stage Monday skip (LGP-224)
--
-- Before: leads on Monday skipped enrichment WHOLESALE. After inheritance
-- they have the data Monday could give, but stages Monday COULDN'T fill
-- (e.g. an affiliates item with no email → contact; a leads-board item →
-- affiliate/rooster/s-tags) stayed empty because the lead never entered
-- the chain.
--
-- Now: on-Monday leads flow into the chain, and each stage is skipped
-- per-lead only when Monday satisfied it (its *_checked_at is set). The
-- stages Monday couldn't fill run normally. Monday still wins where it has
-- data; to re-extract a Monday-filled stage, the operator force-enriches
-- (LGP-226 — "regenerate" is a user action).
--
-- Two coordinated changes:
--   1. inherit_monday_data_for_lead also stamps affiliate_checked_at /
--      rooster_checked_at when it set those from Monday, so the per-stage
--      skip is accurate. (+ backfill those stamps for already-inherited.)
--   2. advance_enrichment_chain: inherit this job's on-Monday leads first,
--      then include monday_inherited_at leads in the enrichable set so
--      their unfilled stages get enqueued.
-- ============================================================

-- ------------------------------------------------------------
-- 1a. inherit_monday_data_for_lead — also stamp affiliate/rooster checked_at
-- ------------------------------------------------------------
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

  if v_board = 'affiliates' or v_is_rooster then v_is_aff := true; end if;

  update public.google_lead_gen_table g set
    is_affiliate       = case when v_is_aff is true then true else g.is_affiliate end,
    affiliate_source   = case when v_is_aff is true and g.affiliate_source is null then 'monday' else g.affiliate_source end,
    -- LGP-224: mark the affiliate stage satisfied so the chain skips it.
    affiliate_checked_at = case when v_is_aff is true then coalesce(g.affiliate_checked_at, now()) else g.affiliate_checked_at end,
    is_rooster_partner = case when v_is_rooster and g.is_rooster_overridden_at is null then true else g.is_rooster_partner end,
    rooster_source     = case when v_is_rooster and g.is_rooster_overridden_at is null and g.rooster_source is null then 'monday' else g.rooster_source end,
    rooster_checked_at = case when v_is_rooster and g.is_rooster_overridden_at is null then coalesce(g.rooster_checked_at, now()) else g.rooster_checked_at end,
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

-- ------------------------------------------------------------
-- 1b. Backfill the new stamps for already-inherited leads so their
--     per-stage skip is accurate if a job is ever re-evaluated.
-- ------------------------------------------------------------
update public.google_lead_gen_table
  set affiliate_checked_at = coalesce(affiliate_checked_at, monday_inherited_at)
  where affiliate_source = 'monday' and affiliate_checked_at is null;
update public.google_lead_gen_table
  set rooster_checked_at = coalesce(rooster_checked_at, monday_inherited_at)
  where rooster_source = 'monday' and rooster_checked_at is null;

-- ------------------------------------------------------------
-- 2. advance_enrichment_chain — per-stage Monday skip.
--    (a) inherit this job's on-Monday leads first (idempotent, cheap once
--        done) so *_checked_at reflect Monday before we count.
--    (b) enrichable set now includes monday_inherited_at leads; the
--        existing per-stage `*_checked_at is null` guards mean only the
--        stages Monday couldn't fill get enqueued.
-- ------------------------------------------------------------
create or replace function public.advance_enrichment_chain(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job         public.scrape_queue;
  v_total       integer;
  v_aff_done    integer;
  v_other_done  integer;
  v_aff_count   integer;
  v_stag_done   integer;
  v_now         timestamptz := now();
begin
  select * into v_job from public.scrape_queue where id = p_job_id;
  if v_job.id is null then return null; end if;
  if not v_job.with_enrichment then return v_job.enrichment_status; end if;
  if v_job.status <> 'completed' then return v_job.enrichment_status; end if;
  if v_job.enrichment_status = 'complete' then return 'complete'; end if;

  -- LGP-224: inherit Monday data for this job's matched leads up front, so
  -- the per-stage skip below only lets through the stages Monday couldn't
  -- fill. Idempotent; a no-op once every lead is inherited.
  perform public.inherit_monday_data_for_lead(g.id)
  from public.google_lead_gen_table g
  where g.scrape_job_id = p_job_id
    and g.is_on_monday = true
    and g.monday_inherited_at is null;

  -- Enrichable set: not-relevant excluded; on-Monday leads are IN once
  -- inherited (their filled stages self-skip via *_checked_at); force_enrich
  -- still forces everything.
  select count(*) into v_total
  from public.google_lead_gen_table
  where scrape_job_id = p_job_id
    and is_not_relevant = false
    and (force_enrich = true or is_on_monday is not true or monday_inherited_at is not null);

  if v_total = 0 then
    update public.scrape_queue
    set enrichment_status = 'complete', enrichment_completed_at = v_now
    where id = p_job_id;
    return 'complete';
  end if;

  if v_job.enrichment_status is null or v_job.enrichment_status = 'pending' then
    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true,
           (g.result_type = 'PPC'),
           '["affiliate"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and g.is_affiliate_overridden_at is null
      and g.affiliate_checked_at is null;

    update public.scrape_queue
    set enrichment_status      = 'affiliate_running',
        enrichment_started_at  = coalesce(enrichment_started_at, v_now)
    where id = p_job_id;
    return 'affiliate_running';
  end if;

  if v_job.enrichment_status = 'affiliate_running' then
    select count(*) into v_aff_done
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and (
        g.is_affiliate_overridden_at is not null
        or g.affiliate_checked_at is not null
        or (
          exists (
            select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id
              and q.process_stages @> '["affiliate"]'::jsonb
          )
          and not exists (
            select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id
              and q.process_stages @> '["affiliate"]'::jsonb
              and q.status in ('pending', 'running', 'paused')
          )
        )
      );

    if v_aff_done < v_total then
      return 'affiliate_running';
    end if;

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["rooster"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and g.is_rooster_overridden_at is null
      and g.rooster_checked_at is null;

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["contact"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and g.is_contact_overridden_at is null
      and g.contact_checked_at is null;

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["stag"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and g.is_affiliate = true
      and g.is_stag_overridden_at is null
      and g.s_tags_checked_at is null;

    update public.scrape_queue
    set enrichment_status = 'all_running'
    where id = p_job_id;
    return 'all_running';
  end if;

  if v_job.enrichment_status = 'all_running' then
    select count(*) into v_other_done
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and (
        g.is_rooster_overridden_at is not null
        or g.rooster_checked_at is not null
        or (
          exists (select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id and q.process_stages @> '["rooster"]'::jsonb)
          and not exists (select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id and q.process_stages @> '["rooster"]'::jsonb
              and q.status in ('pending', 'running', 'paused'))
        )
      )
      and (
        g.is_contact_overridden_at is not null
        or g.contact_checked_at is not null
        or (
          exists (select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id and q.process_stages @> '["contact"]'::jsonb)
          and not exists (select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id and q.process_stages @> '["contact"]'::jsonb
              and q.status in ('pending', 'running', 'paused'))
        )
      );

    select count(*) into v_aff_count
    from public.google_lead_gen_table
    where scrape_job_id = p_job_id
      and is_not_relevant = false
      and (force_enrich = true or is_on_monday is not true or monday_inherited_at is not null)
      and is_affiliate = true;

    select count(*) into v_stag_done
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and (g.force_enrich = true or g.is_on_monday is not true or g.monday_inherited_at is not null)
      and g.is_affiliate = true
      and (
        g.is_stag_overridden_at is not null
        or g.s_tags_checked_at is not null
        or (
          exists (select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id and q.process_stages @> '["stag"]'::jsonb)
          and not exists (select 1 from public.enrichment_fetch_queue q
            where q.lead_id = g.id and q.process_stages @> '["stag"]'::jsonb
              and q.status in ('pending', 'running', 'paused'))
        )
      );

    if v_other_done < v_total or v_stag_done < v_aff_count then
      return 'all_running';
    end if;

    update public.scrape_queue
    set enrichment_status = 'complete', enrichment_completed_at = v_now
    where id = p_job_id;
    return 'complete';
  end if;

  return v_job.enrichment_status;
end;
$$;

grant execute on function public.advance_enrichment_chain(uuid) to service_role;
revoke execute on function public.advance_enrichment_chain(uuid) from anon, authenticated;
