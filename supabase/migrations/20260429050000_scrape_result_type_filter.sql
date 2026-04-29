-- ============================================================
-- Migration: Per-job result_type filter for selective re-runs
--
-- When a scrape's PPC capture fails or returns weird data, you
-- shouldn't have to re-scrape the entire keyword (organic results
-- usually pull cleanly). Adding a `result_type_filter` column
-- lets the queue row say "only keep PPC" or "only keep Organic"
-- when complete_scrape_job inserts results — the worker doesn't
-- change behaviour at all; the filter is applied at insert time.
-- ============================================================

alter table public.scrape_queue
  add column if not exists result_type_filter text
    check (result_type_filter is null or result_type_filter in ('PPC', 'Organic'));

-- Re-define complete_scrape_job to honor the filter when inserting.
-- (Same body as the original — only the WHERE clause changes.)
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
  v_batch_id     bigint;
  v_job          public.scrape_queue;
  v_country_name text;
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

  return v_batch_id;
end;
$$;

grant execute on function public.complete_scrape_job(uuid, jsonb, jsonb) to service_role;
revoke execute on function public.complete_scrape_job(uuid, jsonb, jsonb) from anon, authenticated;
