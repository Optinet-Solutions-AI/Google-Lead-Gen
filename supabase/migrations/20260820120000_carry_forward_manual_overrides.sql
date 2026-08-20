-- ============================================================
-- Carry an operator's MANUAL tag corrections forward to future scrapes.
--
-- Operator feedback (recurring): "shouldn't the tags we update on a scrape for
-- a URL be reflected on the next scrape when the tool pulls the same URL?"
--
-- Today complete_scrape_job re-derives is_on_monday / is_not_relevant FRESH on
-- every scrape (step b, mark_monday_duplicates_for_job) and only inherits the
-- enrichment booleans (step c). So when an operator manually sets a verdict —
-- "this IS on Monday" (e.g. it's in an item's Updates our matcher can't see),
-- "this IS an affiliate", "this is Not Relevant" — the NEXT scrape creates a
-- brand-new lead row that re-derives the verdict from scratch and the manual
-- correction is lost. Operators then re-fix the same URL every scrape.
--
-- Fix: add step (d) — after the Monday check + enrichment inheritance, find the
-- most-recent PRIOR lead (other jobs, same normalized domain) that carries a
-- manual override, and copy the overridden verdict(s) + their override markers
-- onto this scrape's new rows. A carried override sets its *_overridden_at
-- marker, so it also survives the nightly rematch (which skips overridden rows)
-- and re-propagates to the scrape after that.
--
-- Markers (set by the /leads override actions):
--   * monday_overridden_at        — manual is_on_monday (+ monday_board/item)
--   * is_affiliate_overridden_at   — manual is_affiliate
--   * is_rooster_overridden_at     — manual is_rooster_partner
--   * not_relevant_marked_by (human, i.e. NOT 'operator_denylist') — manual
--     is_not_relevant. The adult-domain denylist re-applies itself every scrape,
--     so we only carry HUMAN not-relevant marks, not the auto ones.
--
-- Each verdict is copied only if that prior row actually overrode it (CASE on
-- the marker), so an un-overridden verdict keeps the fresh auto-derivation.
-- Everything else in complete_scrape_job is byte-identical to the v5 from
-- 20260618000000_memory_recognition.sql.
-- ============================================================
create or replace function public.complete_scrape_job(
  p_job_id  uuid,
  p_results jsonb,
  p_summary jsonb default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_batch_id      bigint;
  v_job           public.scrape_queue;
  v_country_name  text;
  v_logged_in     boolean;
  v_logged_in_raw text;
begin
  select * into v_job from public.scrape_queue where id = p_job_id;
  if v_job.id is null then
    raise exception 'scrape_queue row % not found', p_job_id;
  end if;

  select country_name into v_country_name
  from public.gologin_profiles
  where country_code = v_job.country_code;

  update public.batch_counter
  set next_value = next_value + 1
  where id = 1
  returning next_value - 1 into v_batch_id;

  if p_results is not null and jsonb_typeof(p_results) = 'array' then
    insert into public.google_lead_gen_table (
      keyword, country, country_code,
      url, domain,
      page_number, position_on_page, overall_position,
      result_type,
      batch_id, scrape_job_id,
      serp_screenshot_path,
      screenshot_content_link,
      seen_on,
      created_by_is_shadow,
      created_by_email
    )
    select
      coalesce(r->>'keyword', v_job.keyword),
      coalesce(r->>'country', v_country_name),
      v_job.country_code,
      r->>'url',
      r->>'full_url',
      nullif(r->>'page', '')::integer,
      nullif(r->>'position', '')::integer,
      nullif(r->>'overall_position', '')::integer,
      r->>'resultType',
      v_batch_id,
      v_job.id,
      nullif(r->>'serp_screenshot_path', ''),
      nullif(r->>'screenshot_content_link', ''),
      case lower(coalesce(r->>'seen_on', ''))
        when 'desktop' then 'desktop'
        when 'mobile'  then 'mobile'
        when 'both'    then 'both'
        else null
      end,
      coalesce(v_job.created_by_is_shadow, false),
      v_job.created_by_email
    from jsonb_array_elements(p_results) r
    where coalesce(r->>'url', '') <> ''
      and (v_job.result_type_filter is null or r->>'resultType' = v_job.result_type_filter);
  end if;

  update public.scrape_queue
  set status         = 'completed',
      completed_at   = now(),
      batch_id       = v_batch_id,
      result_summary = p_summary,
      raw_results    = p_results,
      error_message  = null,
      updated_at     = now()
  where id = p_job_id;

  delete from public.active_profile_locks where job_id = p_job_id;

  if p_summary is not null then
    v_logged_in_raw := p_summary->>'is_logged_in';
    if v_logged_in_raw is not null and v_logged_in_raw <> 'null' then
      v_logged_in := (v_logged_in_raw = 'true');
      update public.gologin_profiles
      set is_google_logged_in      = v_logged_in,
          google_login_verified_at = now(),
          login_check_source       = 'auto',
          updated_at               = now()
      where country_code = v_job.country_code
        and not (
          v_logged_in = false
          and login_check_source = 'manual'
          and is_google_logged_in = true
        );
    end if;
  end if;

  -- (b) Monday match — sets is_on_monday, monday_board, monday_item_id,
  --     and is_not_relevant (when matched on not_relevant_leads).
  perform public.mark_monday_duplicates_for_job(p_job_id);

  -- (c) Inheritance — copy the known enrichment booleans forward from the
  --     latest prior lead with the same domain (does NOT touch the Monday /
  --     not-relevant verdicts; those are handled by (b) then (d)).
  with new_leads as (
    select id, normalize_domain(coalesce(domain, url)) as nd
    from public.google_lead_gen_table
    where scrape_job_id = p_job_id
  ),
  matches as (
    select n.id as new_id, prior.*
    from new_leads n
    cross join lateral (
      select id,
             is_affiliate,
             affiliate_confidence,
             affiliate_score,
             is_rooster_partner,
             brand,
             has_contact_details,
             has_s_tags,
             affiliate_checked_at,
             rooster_checked_at,
             contact_checked_at,
             s_tags_checked_at
      from public.google_lead_gen_table p
      where p.scrape_job_id <> p_job_id
        and normalize_domain(coalesce(p.domain, p.url)) = n.nd
        and n.nd is not null
        and n.nd <> ''
      order by p.created_at desc
      limit 1
    ) as prior
    where prior.id is not null
  )
  update public.google_lead_gen_table g
  set inherited_from_lead_id = m.id,
      inherited_at           = now(),
      is_affiliate           = coalesce(g.is_affiliate, m.is_affiliate),
      affiliate_confidence   = coalesce(g.affiliate_confidence, m.affiliate_confidence),
      affiliate_score        = coalesce(g.affiliate_score, m.affiliate_score),
      is_rooster_partner     = coalesce(g.is_rooster_partner, m.is_rooster_partner),
      brand                  = coalesce(g.brand, m.brand),
      has_contact_details    = coalesce(g.has_contact_details, m.has_contact_details),
      has_s_tags             = coalesce(g.has_s_tags, m.has_s_tags),
      affiliate_checked_at   = coalesce(g.affiliate_checked_at, m.affiliate_checked_at),
      rooster_checked_at     = coalesce(g.rooster_checked_at, m.rooster_checked_at),
      contact_checked_at     = coalesce(g.contact_checked_at, m.contact_checked_at),
      s_tags_checked_at      = coalesce(g.s_tags_checked_at, m.s_tags_checked_at)
  from matches m
  where g.id = m.new_id;

  -- (d) Manual-override carry-forward. For each new lead, pull the most-recent
  --     prior lead (other jobs, same domain) that carries ANY manual override
  --     and copy the overridden verdict(s) forward. Overrides WIN over the
  --     fresh Monday check from (b). Each verdict copies only if that prior row
  --     actually overrode it (CASE on the marker), so non-overridden verdicts
  --     keep their fresh auto-derivation.
  with new_leads as (
    select id, normalize_domain(coalesce(domain, url)) as nd
    from public.google_lead_gen_table
    where scrape_job_id = p_job_id
  ),
  overrides as (
    select n.id as new_id, o.*
    from new_leads n
    cross join lateral (
      select
        is_on_monday, monday_board, monday_item_id, monday_overridden_at,
        is_affiliate, is_affiliate_overridden_at,
        is_rooster_partner, is_rooster_overridden_at,
        is_not_relevant, not_relevant_marked_at, not_relevant_marked_by
      from public.google_lead_gen_table p
      where p.scrape_job_id <> p_job_id
        and n.nd is not null
        and n.nd <> ''
        and normalize_domain(coalesce(p.domain, p.url)) = n.nd
        and (
          p.monday_overridden_at is not null
          or p.is_affiliate_overridden_at is not null
          or p.is_rooster_overridden_at is not null
          or (p.is_not_relevant = true
              and p.not_relevant_marked_by is not null
              and p.not_relevant_marked_by <> 'operator_denylist')
        )
      order by p.created_at desc
      limit 1
    ) as o
  )
  update public.google_lead_gen_table g
  set
    -- Monday verdict
    is_on_monday         = case when o.monday_overridden_at is not null then o.is_on_monday        else g.is_on_monday end,
    monday_board         = case when o.monday_overridden_at is not null then o.monday_board         else g.monday_board end,
    monday_item_id       = case when o.monday_overridden_at is not null then o.monday_item_id       else g.monday_item_id end,
    monday_overridden_at = case when o.monday_overridden_at is not null then o.monday_overridden_at else g.monday_overridden_at end,
    -- Affiliate verdict
    is_affiliate               = case when o.is_affiliate_overridden_at is not null then o.is_affiliate               else g.is_affiliate end,
    is_affiliate_overridden_at = case when o.is_affiliate_overridden_at is not null then o.is_affiliate_overridden_at else g.is_affiliate_overridden_at end,
    -- Rooster verdict
    is_rooster_partner       = case when o.is_rooster_overridden_at is not null then o.is_rooster_partner       else g.is_rooster_partner end,
    is_rooster_overridden_at = case when o.is_rooster_overridden_at is not null then o.is_rooster_overridden_at else g.is_rooster_overridden_at end,
    -- Not-relevant verdict (human marks only; the adult denylist re-applies itself)
    is_not_relevant        = case when (o.is_not_relevant = true and o.not_relevant_marked_by is not null and o.not_relevant_marked_by <> 'operator_denylist')
                                  then true else g.is_not_relevant end,
    not_relevant_marked_at = case when (o.is_not_relevant = true and o.not_relevant_marked_by is not null and o.not_relevant_marked_by <> 'operator_denylist')
                                  then o.not_relevant_marked_at else g.not_relevant_marked_at end,
    not_relevant_marked_by = case when (o.is_not_relevant = true and o.not_relevant_marked_by is not null and o.not_relevant_marked_by <> 'operator_denylist')
                                  then o.not_relevant_marked_by else g.not_relevant_marked_by end
  from overrides o
  where g.id = o.new_id;

  return v_batch_id;
end;
$$;

grant execute on function public.complete_scrape_job(uuid, jsonb, jsonb) to service_role;
revoke execute on function public.complete_scrape_job(uuid, jsonb, jsonb) from anon, authenticated;
