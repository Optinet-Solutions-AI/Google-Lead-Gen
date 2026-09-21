-- Migration: an irrelevant result never reaches the affiliate stage.
--
-- Relevance is judged per (website, keyword) from the SERP title and snippet.
-- A result the model rejected — a YouTube video, a Wikipedia article, a porn
-- site that merely ranked for a casino keyword — is not worth opening, so it
-- drops out of the candidate list here rather than being filtered later.
-- An operator override (relevance_overridden_at) puts it back.

create or replace function public.ai_candidates_for_job(p_job_ids uuid[])
returns table(
  profile_id        bigint,
  lead_id           bigint,
  normalized_domain text,
  url               text,
  keyword           text,
  country_code      text,
  ai_screened_at    timestamptz,
  ai_worth_checking boolean,
  ai_crawl_at       timestamptz,
  ai_is_affiliate   boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (p.id)
    p.id, g.id, p.normalized_domain, g.url, g.keyword, g.country_code,
    p.ai_screened_at, p.ai_worth_checking, p.ai_crawl_at, p.ai_is_affiliate
  from public.google_lead_gen_table g
  join public.website_profiles p on p.id = g.profile_id
  where g.scrape_job_id = any(p_job_ids)
    and p.is_on_monday = false
    and p.is_not_relevant = false
    and p.system_flag is null
    and g.url like 'http%'
    -- Relevant to the keyword, or an operator said to check it anyway.
    and (g.is_relevant is not false or g.relevance_overridden_at is not null)
  order by p.id, g.id;
$$;

grant execute on function public.ai_candidates_for_job(uuid[]) to service_role;
revoke execute on function public.ai_candidates_for_job(uuid[]) from anon, authenticated;
