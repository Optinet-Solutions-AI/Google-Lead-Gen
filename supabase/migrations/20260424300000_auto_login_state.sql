-- ============================================================
-- Migration: Auto-detect Google login state per scrape
--
-- Each scrape now reports whether the GoLogin profile is signed
-- into a Google account (detected by inspecting the rendered
-- search-results HTML for sign-in / sign-out indicators). The
-- worker passes this through complete_scrape_job's p_summary
-- as { ..., is_logged_in: true/false/null }.
--
-- Updates:
--   1. complete_scrape_job — reads p_summary.is_logged_in and,
--      when not null, bumps gologin_profiles.is_google_logged_in
--      + google_login_verified_at + login_check_source = 'auto'
--   2. Adds login_check_source column ('auto' | 'manual' | NULL)
--      so the UI can show whether the most recent verification
--      came from a real scrape or a user click.
-- ============================================================

alter table public.gologin_profiles
  add column if not exists login_check_source text;

-- ------------------------------------------------------------
-- Updated complete_scrape_job — same shape, now also bumps
-- gologin_profiles when summary.is_logged_in is set.
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

  -- Atomic batch increment
  update public.batch_counter
  set next_value = next_value + 1
  where id = 1
  returning next_value - 1 into v_batch_id;

  -- Insert every result row in a single statement
  if p_results is not null and jsonb_typeof(p_results) = 'array' then
    insert into public.google_lead_gen_table (
      keyword, country, country_code,
      url, domain,
      page_number, position_on_page, overall_position,
      result_type,
      batch_id, scrape_job_id
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
      v_job.id
    from jsonb_array_elements(p_results) r
    where coalesce(r->>'url', '') <> '';
  end if;

  -- Flip the queue row to completed
  update public.scrape_queue
  set status         = 'completed',
      completed_at   = now(),
      batch_id       = v_batch_id,
      result_summary = p_summary,
      raw_results    = p_results,
      error_message  = null,
      updated_at     = now()
  where id = p_job_id;

  -- Free the country lock
  delete from public.active_profile_locks where job_id = p_job_id;

  -- Auto-bump login state if the scraper detected it
  if p_summary is not null then
    v_logged_in_raw := p_summary->>'is_logged_in';
    if v_logged_in_raw is not null and v_logged_in_raw <> 'null' then
      v_logged_in := (v_logged_in_raw = 'true');
      update public.gologin_profiles
      set is_google_logged_in      = v_logged_in,
          google_login_verified_at = now(),
          login_check_source       = 'auto',
          updated_at               = now()
      where country_code = v_job.country_code;
    end if;
  end if;

  return v_batch_id;
end;
$$;

grant execute on function public.complete_scrape_job(uuid, jsonb, jsonb) to service_role;
revoke execute on function public.complete_scrape_job(uuid, jsonb, jsonb) from anon, authenticated;

-- Update the manual-toggle action's RPC behaviour by stamping
-- login_check_source = 'manual' (handled in the server action;
-- this column being present is enough).
