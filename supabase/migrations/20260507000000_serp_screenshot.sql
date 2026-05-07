-- ============================================================
-- Migration: SERP-time screenshot for every detected PPC result
--
-- Existing screenshot (`screenshot_content_link`) is the lead's own
-- landing page, captured during enrichment after we navigate to the
-- domain. That happens minutes-to-hours after the Google search.
-- For PPC ads it's useful to also have the *original Google SERP
-- screenshot* — the small ad creative as it appeared in the search,
-- because Google rotates ads quickly and the landing page may not
-- match what the searcher actually saw.
--
-- Operator flow:
--   1. Worker scrapes Google for "best online casino 2026"
--   2. Detects a sponsored ad
--   3. Selenium element-screenshots the ad card on the SERP
--   4. Uploads it to the lead-screenshots bucket
--   5. Stores the bucket path on the lead row in
--      `serp_screenshot_path`
--   6. Continues scraping organic results
--
-- This migration just adds the column + teaches complete_scrape_job
-- to read `serp_screenshot_path` from each JSONB result the worker
-- ships up.
-- ============================================================

alter table public.google_lead_gen_table
  add column if not exists serp_screenshot_path text;

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
      serp_screenshot_path
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
      nullif(r->>'serp_screenshot_path', '')
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

  -- Auto-bump login state — preserves the same protect-manual-true
  -- semantics from 20260429080000_protect_manual_login_state.sql.
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
