-- ============================================================
-- One keyword = one scrape, regardless of engine.
--
-- Operators reported that scraping a keyword on "Google + Bing" burned
-- TWO of their 20 daily scrapes instead of one. Root cause: the daily
-- counter counted one scrape_queue row per (keyword × engine × source),
-- so a "both" batch = 1 google-PPC row + 1 bing-PPC row = 2 counted rows.
--
-- Fix: count DISTINCT (keyword, country) per UTC day instead of raw rows.
-- Now Google, Bing, or both for the same keyword+country costs exactly
-- ONE scrape. Two different keywords still cost two; the same keyword in
-- two different countries still costs two (genuinely separate work).
-- This is strictly more lenient than before — nobody is charged MORE.
--
-- Same exclusions as before still apply: kick/youtube phase-2 children
-- (parent_scrape_job_id not null), re-runs (is_rerun), and the Apify
-- organic half of a split batch (scrape_source='apify').
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
    and coalesce(scrape_source, 'vm') <> 'apify'
$$;
grant execute on function public.count_user_scrapes_today(text) to service_role, authenticated;
