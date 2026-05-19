-- ============================================================
-- Add `seen_on` column to google_lead_gen_table.
--
-- A lot of casino-vertical PPC ads are configured as "mobile only" on
-- Google Ads — desktop scrapers see zero of those ads in the SERP. To
-- surface them, vm/scraper.py now runs a second pass after the desktop
-- scrape: switches the tab to an iPhone UA + 375x812 viewport via CDP,
-- re-fetches page 0 of the SERP, and extracts the sponsored URLs that
-- appear under mobile rendering.
--
-- Each lead now carries which view(s) it was seen in:
--   'desktop' — found only under desktop rendering
--   'mobile'  — found only under mobile rendering (the new visibility)
--   'both'    — same URL seen under both views (cross-device PPC)
--
-- Organic results stay desktop-only because they don't differ
-- meaningfully between devices and a second organic parse just buys
-- extra captcha exposure for no benefit.
-- ============================================================

alter table public.google_lead_gen_table
  add column if not exists seen_on text;

create index if not exists idx_google_lead_gen_seen_on
  on public.google_lead_gen_table (seen_on)
  where seen_on is not null;

create index if not exists idx_google_lead_gen_mobile_ppc
  on public.google_lead_gen_table (scrape_job_id)
  where seen_on = 'mobile';

-- ------------------------------------------------------------
-- Patch complete_scrape_job — INSERT now carries `seen_on` from the
-- JSONB results payload. Rest of the RPC body is unchanged from
-- migration 20260507000000_serp_screenshot.
-- ------------------------------------------------------------
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
      -- seen_on: nullable text. Worker sets to 'desktop', 'mobile', or 'both'.
      -- Anything outside that set falls through to null so we can spot
      -- payload-shape regressions without rejecting the row.
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
