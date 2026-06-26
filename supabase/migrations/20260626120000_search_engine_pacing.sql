-- ============================================================
-- Per-country pacing for SEARCH engines (Google / Bing).
--
-- WHY: Google and Bing flag our residential (Enigma) exit IPs when
-- gambling queries hit them in quick succession from the same
-- country — the SERP comes back empty or throws a captcha (Darren's
-- 2026-06-25 DE/CA report: CA google 8/11 captcha, CA/AU bing all-
-- empty). The SAME proxy serves the social engines fine, so this is
-- a search-engine reputation problem, not a dead proxy. Spacing
-- consecutive search jobs per country out gives the IP time to cool
-- and dramatically cuts the burst rate that triggers the flag.
--
-- WHAT: claim_scrape_job won't hand a worker a google/bing job for a
-- country if another google/bing job for that country STARTED within
-- the last `search_engine_cooldown_seconds`. Social engines (kick,
-- youtube, tiktok, snapchat, twitch, facebook, telegram, x) are NOT
-- gated — they keep the existing up-to-max_concurrent_per_country
-- behaviour. A gated search job isn't head-of-line-blocking: the
-- claim picks the highest-priority NON-gated job instead, so other
-- countries / social jobs keep flowing.
--
-- SAFE BY DEFAULT: the setting defaults to 0 = DISABLED, so applying
-- this migration changes NOTHING until an operator sets a value.
-- Turn it on deliberately and watch the queue:
--   update system_settings set value = '90'::jsonb
--     where key = 'search_engine_cooldown_seconds';   -- 90s between DE/CA search hits
-- Set back to '0' to disable instantly (no redeploy). Live read per
-- claim, same pattern as max_concurrent_per_country.
--
-- NOTE: this PREVENTS future flagging; it does not un-flag IPs that
-- are already burned. Recovering already-blocked CA/DE search needs a
-- cleaner / rotated proxy pool (separate, cost-bearing decision).
-- ============================================================

insert into public.system_settings (key, value)
values ('search_engine_cooldown_seconds', '0'::jsonb)
on conflict (key) do nothing;

create or replace function public.claim_scrape_job(p_worker_id text)
returns public.scrape_queue
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_candidate_id     uuid;
  v_country_code     text;
  v_row              public.scrape_queue;
  v_max_per_country  integer;
  v_search_cooldown  integer;
begin
  -- Per-country concurrency cap (unchanged).
  select coalesce((value)::integer, 3)
    into v_max_per_country
  from public.system_settings
  where key = 'max_concurrent_per_country';
  if v_max_per_country is null then v_max_per_country := 3; end if;

  -- Search-engine pacing window. 0 (default) = disabled → identical
  -- behaviour to before this migration.
  select coalesce((value)::integer, 0)
    into v_search_cooldown
  from public.system_settings
  where key = 'search_engine_cooldown_seconds';
  if v_search_cooldown is null then v_search_cooldown := 0; end if;

  select s.id, s.country_code
    into v_candidate_id, v_country_code
  from public.scrape_queue s
  where s.status = 'pending'
    and s.attempts < s.max_attempts
    and (s.scheduled_at is null or s.scheduled_at <= now())
    and (
      select count(*) from public.active_profile_locks l
      where l.country_code = s.country_code
    ) < v_max_per_country
    -- Search-engine pacing gate: only applies to google/bing, and
    -- only when the cooldown is enabled (> 0). A search job is
    -- claimable only if no other search job for the same country
    -- started within the cooldown window.
    and (
      v_search_cooldown <= 0
      or s.search_engine not in ('google', 'bing')
      or not exists (
        select 1 from public.scrape_queue r
        where r.country_code = s.country_code
          and r.search_engine in ('google', 'bing')
          and r.id <> s.id
          and r.started_at is not null
          and r.started_at > now() - (v_search_cooldown || ' seconds')::interval
      )
    )
  order by s.priority desc, s.created_at asc
  limit 1
  for update skip locked;

  if v_candidate_id is null then
    return null;
  end if;

  insert into public.active_profile_locks (country_code, job_id, worker_id, job_kind)
  values (v_country_code, v_candidate_id, p_worker_id, 'scrape')
  on conflict (job_id) do nothing;

  if not found then
    return null;
  end if;

  update public.scrape_queue
  set status      = 'running',
      claimed_by  = p_worker_id,
      started_at  = now(),
      attempts    = attempts + 1,
      updated_at  = now()
  where id = v_candidate_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.claim_scrape_job(text) to service_role;
revoke execute on function public.claim_scrape_job(text) from anon, authenticated;
