-- A scrape has to show its results.
--
-- The dedupe added with website profiles kept ONE lead row per website
-- for all time: `p.first_lead_id is null`. So the first scrape that ever
-- met a domain wrote a row and every later one wrote none. Batch 4675
-- found 21 organic results across 19 already-known websites and produced
-- an empty table under a header reading "21 results"; the pipeline column
-- had no stages because it counts leads, and there were none. Every recent
-- batch shows it — lead_rows equalled websites_new exactly, run after run.
--
-- Deduping was never meant to hide a scrape's output. It was meant to stop
-- ONE scrape writing the same website twice (desktop + mobile passes, the
-- same site on two result pages). So scope it to the job: first occurrence
-- within these results wins, regardless of what earlier scrapes found.
--
-- Cross-scrape history is not lost — that is what website_appearances and
-- the profile's appearance_count are for, and what the website page reads.
--
-- Only the tmp_lead_rows predicate changes; the rest of the function is
-- carried over verbatim from the deployed definition.

CREATE OR REPLACE FUNCTION public.complete_scrape_job(p_job_id uuid, p_results jsonb, p_summary jsonb DEFAULT NULL::jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_batch_id      bigint;
  v_job           public.scrape_queue;
  v_country_name  text;
  v_logged_in     boolean;
  v_logged_in_raw text;
  v_dedupe        boolean;
  v_ttl           jsonb;
  v_ttl_aff       integer;
  v_ttl_roo       integer;
  v_ttl_con       integer;
  v_ttl_stag      integer;
  v_new_profiles  bigint[] := '{}'::bigint[];
  v_n_new         integer := 0;
  v_n_known       integer := 0;
  v_n_leads       integer := 0;
  v_n_app         integer := 0;
  v_n_recheck     integer := 0;
  v_tmp           integer := 0;
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

  v_dedupe   := coalesce(public.get_system_setting('profile_dedupe_enabled') = 'true'::jsonb, true);
  v_ttl      := coalesce(public.get_system_setting('verdict_ttl_days'), '{}'::jsonb);
  v_ttl_aff  := coalesce(nullif(v_ttl->>'affiliate', '')::integer, 90);
  v_ttl_roo  := coalesce(nullif(v_ttl->>'rooster',   '')::integer, 60);
  v_ttl_con  := coalesce(nullif(v_ttl->>'contact',   '')::integer, 180);
  v_ttl_stag := coalesce(nullif(v_ttl->>'stags',     '')::integer, 90);

  perform set_config('app.skip_lead_profile_sync', '1', true);

  if p_results is not null and jsonb_typeof(p_results) = 'array' then
    drop table if exists tmp_scrape_results;
    create temp table tmp_scrape_results on commit drop as
    select
      row_number() over (order by nullif(r->>'overall_position', '')::integer nulls last, ord) as rn,
      r,
      coalesce(public.normalize_domain(coalesce(nullif(r->>'full_url', ''), r->>'url')), '') as nd
    from jsonb_array_elements(p_results) with ordinality as t(r, ord)
    where coalesce(r->>'url', '') <> ''
      and (v_job.result_type_filter is null or r->>'resultType' = v_job.result_type_filter);

    with ins as (
      insert into public.website_profiles (normalized_domain, registered_domain, brand_stem, display_name, source, first_seen_at, last_seen_at)
      select distinct on (nd) nd, coalesce(public.registered_domain(nd), nd), public.brand_stem(nd), nd, 'scrape', now(), now()
      from tmp_scrape_results
      where nd <> ''
      order by nd, rn
      on conflict (normalized_domain) do nothing
      returning id
    )
    select coalesce(array_agg(id), '{}'::bigint[]) into v_new_profiles from ins;
    v_n_new := coalesce(array_length(v_new_profiles, 1), 0);

    perform public.link_profile_relations(v_new_profiles);
    perform public.apply_db_system_flags(v_new_profiles);

    drop table if exists tmp_lead_rows;
    create temp table tmp_lead_rows on commit drop as
    select t.rn, t.r, t.nd, p.id as profile_id
    from tmp_scrape_results t
    left join public.website_profiles p on p.normalized_domain = t.nd
    where (not v_dedupe)
       or t.nd = ''
       or t.rn = (select min(t2.rn) from tmp_scrape_results t2 where t2.nd = t.nd);

    with ins as (
      insert into public.google_lead_gen_table (
        keyword, country, country_code,
        url, domain,
        page_number, position_on_page, overall_position,
        result_type,
        batch_id, scrape_job_id,
        serp_screenshot_path, screenshot_content_link, seen_on,
        serp_title, serp_description,
        created_by_is_shadow, created_by_email,
        profile_id, system_flag,
        is_not_relevant, not_relevant_marked_at, not_relevant_marked_by,
        is_affiliate, affiliate_confidence, affiliate_score, affiliate_checked_at, affiliate_source, is_affiliate_overridden_at,
        is_rooster_partner, brand, rooster_brands, rooster_checked_at, rooster_source, is_rooster_overridden_at,
        has_contact_details, contact_checked_at,
        has_s_tags, s_tags_checked_at,
        inherited_from_lead_id, inherited_at
      )
      select
        coalesce(l.r->>'keyword', v_job.keyword),
        coalesce(l.r->>'country', v_country_name),
        v_job.country_code,
        l.r->>'url',
        l.r->>'full_url',
        nullif(l.r->>'page', '')::integer,
        nullif(l.r->>'position', '')::integer,
        nullif(l.r->>'overall_position', '')::integer,
        l.r->>'resultType',
        v_batch_id,
        v_job.id,
        nullif(l.r->>'serp_screenshot_path', ''),
        nullif(l.r->>'screenshot_content_link', ''),
        case lower(coalesce(l.r->>'seen_on', ''))
          when 'desktop' then 'desktop'
          when 'mobile'  then 'mobile'
          when 'both'    then 'both'
          else null
        end,
        nullif(l.r->>'title', ''),
        nullif(coalesce(l.r->>'description', l.r->>'snippet'), ''),
        coalesce(v_job.created_by_is_shadow, false),
        v_job.created_by_email,
        l.profile_id,
        p.system_flag,
        coalesce(p.is_not_relevant, false),
        case when p.is_not_relevant then coalesce(p.not_relevant_at, now()) end,
        case when p.is_not_relevant then coalesce(p.not_relevant_source, 'profile') end,
        case when p.is_affiliate_overridden_at is not null or p.affiliate_checked_at > now() - make_interval(days => v_ttl_aff) then p.is_affiliate end,
        case when p.is_affiliate_overridden_at is not null or p.affiliate_checked_at > now() - make_interval(days => v_ttl_aff) then p.affiliate_confidence end,
        case when p.is_affiliate_overridden_at is not null or p.affiliate_checked_at > now() - make_interval(days => v_ttl_aff) then p.affiliate_score end,
        case when p.is_affiliate_overridden_at is not null or p.affiliate_checked_at > now() - make_interval(days => v_ttl_aff) then p.affiliate_checked_at end,
        case when p.is_affiliate_overridden_at is not null or p.affiliate_checked_at > now() - make_interval(days => v_ttl_aff) then p.affiliate_source end,
        p.is_affiliate_overridden_at,
        case when p.is_rooster_overridden_at is not null or p.rooster_checked_at > now() - make_interval(days => v_ttl_roo) then p.is_rooster_partner end,
        case when p.is_rooster_overridden_at is not null or p.rooster_checked_at > now() - make_interval(days => v_ttl_roo) then p.brand end,
        case when p.is_rooster_overridden_at is not null or p.rooster_checked_at > now() - make_interval(days => v_ttl_roo) then p.rooster_brands end,
        case when p.is_rooster_overridden_at is not null or p.rooster_checked_at > now() - make_interval(days => v_ttl_roo) then p.rooster_checked_at end,
        case when p.is_rooster_overridden_at is not null or p.rooster_checked_at > now() - make_interval(days => v_ttl_roo) then p.rooster_source end,
        p.is_rooster_overridden_at,
        case when p.contact_checked_at > now() - make_interval(days => v_ttl_con) then p.has_contact_details end,
        case when p.contact_checked_at > now() - make_interval(days => v_ttl_con) then p.contact_checked_at end,
        case when p.s_tags_checked_at > now() - make_interval(days => v_ttl_stag) then p.has_s_tags end,
        case when p.s_tags_checked_at > now() - make_interval(days => v_ttl_stag) then p.s_tags_checked_at end,
        p.first_lead_id,
        case when p.affiliate_checked_at is not null or p.rooster_checked_at is not null or p.contact_checked_at is not null or p.s_tags_checked_at is not null then now() end
      from tmp_lead_rows l
      left join public.website_profiles p on p.id = l.profile_id
      returning id, profile_id
    ),
    firsts as (
      select distinct on (profile_id) profile_id, id
      from ins
      where profile_id is not null
      order by profile_id, id
    )
    update public.website_profiles p
    set first_lead_id = f.id, updated_at = now()
    from firsts f
    where p.id = f.profile_id
      and p.first_lead_id is null;

    select count(*) into v_n_leads from tmp_lead_rows;

    insert into public.website_appearances (
      profile_id, lead_id, scrape_job_id, batch_id,
      keyword, country_code, search_engine, result_type,
      url, page_number, position_on_page, overall_position, seen_on, serp_screenshot_path,
      created_lead, seen_at
    )
    select
      p.id, g.id, v_job.id, v_batch_id,
      coalesce(t.r->>'keyword', v_job.keyword),
      v_job.country_code,
      v_job.search_engine,
      t.r->>'resultType',
      t.r->>'url',
      nullif(t.r->>'page', '')::integer,
      nullif(t.r->>'position', '')::integer,
      nullif(t.r->>'overall_position', '')::integer,
      nullif(lower(t.r->>'seen_on'), ''),
      nullif(t.r->>'serp_screenshot_path', ''),
      (g.id is not null),
      now()
    from tmp_scrape_results t
    join public.website_profiles p on p.normalized_domain = t.nd
    left join tmp_lead_rows l on l.rn = t.rn
    left join lateral (
      select g0.id
      from public.google_lead_gen_table g0
      where l.rn is not null
        and g0.scrape_job_id = v_job.id
        and g0.profile_id = p.id
        and g0.url = t.r->>'url'
      order by g0.id
      limit 1
    ) g on true;
    get diagnostics v_n_app = row_count;

    update public.website_profiles p
    set last_seen_at     = now(),
        first_seen_at    = coalesce(p.first_seen_at, now()),
        appearance_count = p.appearance_count + s.n,
        updated_at       = now()
    from (select nd, count(*) as n from tmp_scrape_results where nd <> '' group by nd) s
    where p.normalized_domain = s.nd;

    select count(distinct nd) - v_n_new into v_n_known from tmp_scrape_results where nd <> '';

    if coalesce(v_job.with_enrichment, false) then
      insert into public.enrichment_fetch_queue (lead_id, country_code, url, want_html, want_screenshot, process_stages, created_by_email, created_by_is_shadow)
      select g.id, g.country_code, g.url, true, false, '["affiliate"]'::jsonb, v_job.created_by_email, coalesce(v_job.created_by_is_shadow, false)
      from public.website_profiles p
      join public.google_lead_gen_table g on g.id = p.first_lead_id
      where p.normalized_domain in (select nd from tmp_scrape_results where nd <> '')
        and not (p.id = any(v_new_profiles))
        and p.is_not_relevant = false
        and p.system_flag is null
        and p.is_on_monday is not true
        and p.is_affiliate_overridden_at is null
        and p.affiliate_checked_at is not null
        and p.affiliate_checked_at < now() - make_interval(days => v_ttl_aff)
        and g.url like 'http%'
        and g.country_code is not null
        and not exists (
          select 1 from public.enrichment_fetch_queue q
          where q.lead_id = g.id and q.status in ('pending', 'running', 'paused')
        );
      get diagnostics v_tmp = row_count;
      v_n_recheck := v_n_recheck + v_tmp;

      insert into public.enrichment_fetch_queue (lead_id, country_code, url, want_html, want_screenshot, process_stages, created_by_email, created_by_is_shadow)
      select g.id, g.country_code, g.url, true, false, '["rooster"]'::jsonb, v_job.created_by_email, coalesce(v_job.created_by_is_shadow, false)
      from public.website_profiles p
      join public.google_lead_gen_table g on g.id = p.first_lead_id
      where p.normalized_domain in (select nd from tmp_scrape_results where nd <> '')
        and not (p.id = any(v_new_profiles))
        and p.is_not_relevant = false
        and p.system_flag is null
        and p.is_on_monday is not true
        and p.is_rooster_overridden_at is null
        and p.rooster_checked_at is not null
        and p.rooster_checked_at < now() - make_interval(days => v_ttl_roo)
        and g.url like 'http%'
        and g.country_code is not null
        and not exists (
          select 1 from public.enrichment_fetch_queue q
          where q.lead_id = g.id and q.status in ('pending', 'running', 'paused')
        );
      get diagnostics v_tmp = row_count;
      v_n_recheck := v_n_recheck + v_tmp;
    end if;

    drop table if exists tmp_lead_rows;
    drop table if exists tmp_scrape_results;
  end if;

  update public.scrape_queue
  set status         = 'completed',
      completed_at   = now(),
      batch_id       = v_batch_id,
      result_summary = coalesce(p_summary, '{}'::jsonb) || jsonb_build_object(
                         'websites_new',    v_n_new,
                         'websites_known',  v_n_known,
                         'lead_rows',       v_n_leads,
                         'appearances',     v_n_app,
                         'rechecks_queued', v_n_recheck
                       ),
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

  perform public.mark_monday_duplicates_for_job(p_job_id);

  return v_batch_id;
end;
$function$
;
