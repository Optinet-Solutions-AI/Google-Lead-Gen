-- ============================================================
-- Capture the PPC landing-page screenshot at scrape time too.
--
-- Today every PPC row gets a `serp_screenshot_path` (the small ad
-- creative on Google's results page, 100% reliable). The actual
-- landing page screenshot — `screenshot_content_link` — only fires
-- during enrichment, which (a) sometimes isn't run, (b) re-fetches
-- without the Google referer so cloakers serve a decoy instead of
-- the real page.
--
-- This migration teaches complete_scrape_job to ALSO read a
-- `screenshot_content_link` field from each JSONB result row. The
-- scraper now captures the post-click landing image during the
-- same Ctrl+Click pass it already does for URL resolution
-- (cloakers tend to whitelist that real-user gesture), uploads the
-- PNG to the lead-screenshots bucket, and ships the bucket path
-- alongside the SERP screenshot path.
--
-- Net effect: PPC leads in the dashboard now show two distinct
-- screenshots — "SERP ad creative" and "Landing page (post-click)"
-- — whenever the cloaker doesn't win that fight. Rest of the RPC
-- body is unchanged from migration 20260519010000_mobile_only_ppc.
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
      seen_on
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
      -- screenshot_content_link is the post-click landing page; only
      -- present on PPC rows when the click-through screenshot
      -- survived cloaker checks. NULL falls through to whatever
      -- enrichment captures later (or stays NULL if enrichment
      -- isn't run for this lead).
      nullif(r->>'screenshot_content_link', ''),
      case lower(coalesce(r->>'seen_on', ''))
        when 'desktop' then 'desktop'
        when 'mobile'  then 'mobile'
        when 'both'    then 'both'
        else null
      end
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

  return v_batch_id;
end;
$$;

grant execute on function public.complete_scrape_job(uuid, jsonb, jsonb) to service_role;
revoke execute on function public.complete_scrape_job(uuid, jsonb, jsonb) from anon, authenticated;
