-- ============================================================
-- Migration: Protect manually-set login state from auto-detect
--
-- Bug: complete_scrape_job auto-bumps gologin_profiles.is_google_logged_in
-- on every successful scrape based on the scraper's detect_login_state
-- read. When that detection returns a false positive (says "logged out"
-- on a logged-in session — happens with layout variants, cookie banners
-- blocking the avatar, regional sign-in prompts), it overwrites the
-- user's manual TRUE with FALSE automatically. They sign in via /profiles,
-- one scrape later their manual setting is gone.
--
-- Fix: keep auto-detect for the easy direction (false → true, i.e.
-- confirming a fresh sign-in) but never let auto-detect drop a
-- manually-confirmed TRUE down to FALSE. Real logouts will still show
-- up via the verified-at timestamp on /profiles, and the user toggles
-- manually if needed.
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

  -- Atomic batch increment
  update public.batch_counter
  set next_value = next_value + 1
  where id = 1
  returning next_value - 1 into v_batch_id;

  -- Insert every result row in a single statement. Honours the
  -- `result_type_filter` column (PPC-only / Organic-only re-runs).
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
    where coalesce(r->>'url', '') <> ''
      and (v_job.result_type_filter is null or r->>'resultType' = v_job.result_type_filter);
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

  -- Auto-bump login state — but never trample a manual TRUE.
  --
  -- Rules:
  --   - If detector says TRUE  → always update (confirms sign-in).
  --   - If detector says FALSE → only update when the current source
  --     isn't 'manual' OR the current value is already FALSE/NULL.
  --     This protects a manual TRUE from getting wiped by a single
  --     false-positive read.
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
