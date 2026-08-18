-- ============================================================
-- Count the Apify job toward the daily quota.
--
-- The old flow split a google/bing batch into a FREE Apify organic job + a
-- counted VM PPC job, so count_user_scrapes_today excluded scrape_source='apify'.
-- That split is retired — a google/bing batch is now a SINGLE Apify job that
-- returns both organic + paid ads. If Apify stayed excluded, every google/bing
-- scrape would cost 0 quota. Drop the exclusion: count distinct (keyword,
-- country) across all non-child, non-rerun jobs regardless of source. Distinct
-- keying means legacy split rows (apify + vm for the same keyword) still collapse
-- to one, so nobody is retroactively double-charged.
-- ============================================================

create or replace function public.count_user_scrapes_today(p_email text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(distinct (lower(keyword), country_code))::int
  from public.scrape_queue
  where lower(coalesce(created_by_email, '')) = lower(coalesce(p_email, ''))
    and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
    and parent_scrape_job_id is null
    and coalesce(is_rerun, false) = false
$$;
grant execute on function public.count_user_scrapes_today(text) to service_role, authenticated;
