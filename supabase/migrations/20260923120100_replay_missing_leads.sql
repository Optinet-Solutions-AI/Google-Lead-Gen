-- Replay the lead rows a completed scrape should have written.
--
-- The all-time dedupe (see 20260923120000) meant recent batches recorded
-- appearances but almost no lead rows, so the operator saw an empty table
-- under a header counting results. The original SERP payload is still on
-- the job in `raw_results`, so those rows can be rebuilt exactly — titles,
-- snippets, positions and inherited verdicts included — with no re-scrape
-- and no Apify spend.
--
-- Idempotent: a result whose url already has a lead row on this job is
-- skipped, so running it twice adds nothing. It does not touch batch ids,
-- appearance counts or job status — it only fills in the missing rows and
-- links the appearance log to them.

create or replace function public.replay_missing_leads(p_job_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_job          public.scrape_queue;
  v_country_name text;
  v_ttl          jsonb;
  v_ttl_aff      integer;
  v_ttl_roo      integer;
  v_ttl_con      integer;
  v_ttl_stag     integer;
  v_n            integer := 0;
begin
  select * into v_job from public.scrape_queue where id = p_job_id;
  if v_job.id is null then
    raise exception 'scrape_queue row % not found', p_job_id;
  end if;
  if v_job.raw_results is null or jsonb_typeof(v_job.raw_results) <> 'array' then
    return 0;
  end if;

  select country_name into v_country_name
  from public.gologin_profiles
  where country_code = v_job.country_code;

  v_ttl      := coalesce(public.get_system_setting('verdict_ttl_days'), '{}'::jsonb);
  v_ttl_aff  := coalesce(nullif(v_ttl->>'affiliate', '')::integer, 90);
  v_ttl_roo  := coalesce(nullif(v_ttl->>'rooster',   '')::integer, 60);
  v_ttl_con  := coalesce(nullif(v_ttl->>'contact',   '')::integer, 180);
  v_ttl_stag := coalesce(nullif(v_ttl->>'stags',     '')::integer, 90);

  -- Suppress the profile-sync trigger exactly as complete_scrape_job does,
  -- so replaying does not re-derive verdicts from the rows we are writing.
  perform set_config('app.skip_lead_profile_sync', '1', true);

  drop table if exists tmp_replay_results;
  create temp table tmp_replay_results on commit drop as
  select
    row_number() over (order by nullif(r->>'overall_position', '')::integer nulls last, ord) as rn,
    r,
    coalesce(public.normalize_domain(coalesce(nullif(r->>'full_url', ''), r->>'url')), '') as nd
  from jsonb_array_elements(v_job.raw_results) with ordinality as t(r, ord)
  where coalesce(r->>'url', '') <> ''
    and (v_job.result_type_filter is null or r->>'resultType' = v_job.result_type_filter);

  -- Websites first seen by this job may have no profile yet if the original
  -- run predates them; make sure every result has one to inherit from.
  insert into public.website_profiles (normalized_domain, registered_domain, brand_stem, display_name, source, first_seen_at, last_seen_at)
  select distinct on (nd) nd, coalesce(public.registered_domain(nd), nd), public.brand_stem(nd), nd, 'scrape', now(), now()
  from tmp_replay_results
  where nd <> ''
  order by nd, rn
  on conflict (normalized_domain) do nothing;

  drop table if exists tmp_lead_rows;
  create temp table tmp_lead_rows on commit drop as
  select t.rn, t.r, t.nd, p.id as profile_id
  from tmp_replay_results t
  left join public.website_profiles p on p.normalized_domain = t.nd
  where (t.nd = '' or t.rn = (select min(t2.rn) from tmp_replay_results t2 where t2.nd = t.nd))
    -- Skip anything this job already wrote, so the replay is idempotent.
    and not exists (
      select 1 from public.google_lead_gen_table g
      where g.scrape_job_id = v_job.id
        and g.url = t.r->>'url'
    );

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
        v_job.batch_id,
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

  select count(*) into v_n from tmp_lead_rows;

  -- Point the existing appearance rows at the leads we just created, so the
  -- log and the table agree about what this scrape produced.
  update public.website_appearances a
  set lead_id = g.id, created_lead = true
  from public.google_lead_gen_table g
  where a.scrape_job_id = v_job.id
    and a.lead_id is null
    and g.scrape_job_id = v_job.id
    and g.url = a.url;

  return v_n;
end;
$function$;

comment on function public.replay_missing_leads(uuid) is
  'Rebuilds the lead rows a completed scrape should have written, from the job''s retained raw_results. Idempotent; no re-scrape, no new batch.';

grant execute on function public.replay_missing_leads(uuid) to service_role;
