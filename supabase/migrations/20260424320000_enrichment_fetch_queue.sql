-- ============================================================
-- Migration: Enrichment Fetch Queue + HTML Cache + Screenshots
--
-- Foundation for moving HTML fetching off Vercel and onto the
-- existing GoLogin VM workers (Option A) and giving every
-- enrichment stage a queue (Option C).
--
-- Pieces:
--   1. enrichment_fetch_queue        — work items the VM picks up
--   2. fetched_html_cache            — most-recent HTML per lead
--   3. lead-screenshots              — Storage bucket (private)
--   4. claim/complete/fail RPCs      — atomic queue operations
--   5. active_profile_locks          — extended to allow either a
--                                      scrape OR an enrichment job
--                                      to hold the country lock
-- ============================================================

-- ------------------------------------------------------------
-- 1. Evolve active_profile_locks so scrape AND enrichment can use it
-- ------------------------------------------------------------
alter table public.active_profile_locks
  drop constraint if exists active_profile_locks_job_id_fkey;

alter table public.active_profile_locks
  add column if not exists job_kind text not null default 'scrape'
    check (job_kind in ('scrape', 'enrichment'));

-- ------------------------------------------------------------
-- 2. enrichment_fetch_queue
-- ------------------------------------------------------------
create table if not exists public.enrichment_fetch_queue (
  id              uuid        primary key default gen_random_uuid(),
  lead_id         bigint      not null references public.google_lead_gen_table(id) on delete cascade,
  country_code    text        not null references public.gologin_profiles(country_code),
  url             text        not null,
  want_html       boolean     not null default true,
  want_screenshot boolean     not null default false,
  -- jsonb array of stages to run inline after fetch:
  -- ['affiliate'] | ['rooster'] | ['contact'] | ['stag'] | combos
  process_stages  jsonb       not null default '[]'::jsonb,
  status          text        not null default 'pending'
                  check (status in ('pending', 'running', 'completed', 'failed')),
  attempts        integer     not null default 0,
  max_attempts    integer     not null default 3,
  claimed_by      text,
  started_at      timestamptz,
  completed_at    timestamptz,
  error_message   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.enrichment_fetch_queue enable row level security;

create index if not exists idx_enrichment_fetch_pending
  on public.enrichment_fetch_queue (created_at asc)
  where status = 'pending';

create index if not exists idx_enrichment_fetch_lead
  on public.enrichment_fetch_queue (lead_id);

create index if not exists idx_enrichment_fetch_status
  on public.enrichment_fetch_queue (status, created_at desc);

-- ------------------------------------------------------------
-- 3. fetched_html_cache — single row per lead, latest fetch wins
-- ------------------------------------------------------------
create table if not exists public.fetched_html_cache (
  lead_id      bigint      primary key references public.google_lead_gen_table(id) on delete cascade,
  url          text        not null,
  html         text,
  fetched_at   timestamptz not null default now(),
  fetch_error  text,
  source       text        not null default 'gologin'
);

alter table public.fetched_html_cache enable row level security;

-- ------------------------------------------------------------
-- 4. Storage bucket for screenshots (private; signed URLs only)
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('lead-screenshots', 'lead-screenshots', false)
on conflict (id) do nothing;

-- ------------------------------------------------------------
-- 5. claim_enrichment_fetch_job — atomic claim with country lock
--
-- Shares active_profile_locks with scrape_queue so scrape and
-- enrichment can't both hold the same GoLogin profile at once.
-- ------------------------------------------------------------
create or replace function public.claim_enrichment_fetch_job(p_worker_id text)
returns public.enrichment_fetch_queue
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id      uuid;
  v_country text;
  v_row     public.enrichment_fetch_queue;
begin
  select e.id, e.country_code into v_id, v_country
  from public.enrichment_fetch_queue e
  where e.status = 'pending'
    and e.attempts < e.max_attempts
    and not exists (
      select 1 from public.active_profile_locks l
      where l.country_code = e.country_code
    )
  order by e.created_at asc
  limit 1
  for update skip locked;

  if v_id is null then return null; end if;

  insert into public.active_profile_locks (country_code, job_id, worker_id, job_kind)
  values (v_country, v_id, p_worker_id, 'enrichment')
  on conflict (country_code) do nothing;

  if not found then return null; end if;

  update public.enrichment_fetch_queue
  set status     = 'running',
      claimed_by = p_worker_id,
      started_at = now(),
      attempts   = attempts + 1,
      updated_at = now()
  where id = v_id
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.claim_enrichment_fetch_job(text) to service_role;
revoke execute on function public.claim_enrichment_fetch_job(text) from anon, authenticated;

-- ------------------------------------------------------------
-- 6. complete_enrichment_fetch_job — writes cache + screenshot link
-- ------------------------------------------------------------
create or replace function public.complete_enrichment_fetch_job(
  p_job_id          uuid,
  p_html            text default null,
  p_screenshot_path text default null,
  p_fetch_error     text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job public.enrichment_fetch_queue;
begin
  select * into v_job from public.enrichment_fetch_queue where id = p_job_id;
  if v_job.id is null then
    raise exception 'enrichment_fetch_queue row % not found', p_job_id;
  end if;

  insert into public.fetched_html_cache (lead_id, url, html, fetched_at, fetch_error)
  values (v_job.lead_id, v_job.url, p_html, now(), p_fetch_error)
  on conflict (lead_id) do update
  set url         = excluded.url,
      html        = excluded.html,
      fetched_at  = excluded.fetched_at,
      fetch_error = excluded.fetch_error;

  if p_screenshot_path is not null then
    update public.google_lead_gen_table
    set screenshot_content_link = p_screenshot_path,
        screenshot_view_link    = p_screenshot_path
    where id = v_job.lead_id;
  end if;

  update public.enrichment_fetch_queue
  set status        = case when p_fetch_error is null then 'completed' else 'failed' end,
      completed_at  = now(),
      error_message = p_fetch_error,
      updated_at    = now()
  where id = p_job_id;

  delete from public.active_profile_locks where job_id = p_job_id;
end;
$$;

grant execute on function public.complete_enrichment_fetch_job(uuid, text, text, text) to service_role;
revoke execute on function public.complete_enrichment_fetch_job(uuid, text, text, text) from anon, authenticated;

-- ------------------------------------------------------------
-- 7. fail_enrichment_fetch_job — generic failure with retry
-- ------------------------------------------------------------
create or replace function public.fail_enrichment_fetch_job(p_job_id uuid, p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_attempts int;
  v_max      int;
begin
  select attempts, max_attempts into v_attempts, v_max
  from public.enrichment_fetch_queue
  where id = p_job_id;

  update public.enrichment_fetch_queue
  set status        = case when v_attempts < v_max then 'pending' else 'failed' end,
      claimed_by    = null,
      started_at    = null,
      error_message = p_error,
      updated_at    = now()
  where id = p_job_id;

  delete from public.active_profile_locks where job_id = p_job_id;
end;
$$;

grant execute on function public.fail_enrichment_fetch_job(uuid, text) to service_role;
revoke execute on function public.fail_enrichment_fetch_job(uuid, text) from anon, authenticated;

-- ------------------------------------------------------------
-- 8. release_stale_locks — now handles both queue types
-- ------------------------------------------------------------
create or replace function public.release_stale_locks(p_max_age_minutes integer default 30)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_lock  record;
begin
  for v_lock in (
    select country_code, job_id, job_kind
    from public.active_profile_locks
    where locked_at < now() - (p_max_age_minutes || ' minutes')::interval
  ) loop
    if v_lock.job_kind = 'scrape' then
      update public.scrape_queue
      set status        = case when attempts < max_attempts then 'pending' else 'failed' end,
          claimed_by    = null,
          started_at    = null,
          error_message = 'Worker timed out (lock held > ' || p_max_age_minutes || ' min)',
          updated_at    = now()
      where id = v_lock.job_id and status = 'running';
    elsif v_lock.job_kind = 'enrichment' then
      update public.enrichment_fetch_queue
      set status        = case when attempts < max_attempts then 'pending' else 'failed' end,
          claimed_by    = null,
          started_at    = null,
          error_message = 'Worker timed out (lock held > ' || p_max_age_minutes || ' min)',
          updated_at    = now()
      where id = v_lock.job_id and status = 'running';
    end if;

    delete from public.active_profile_locks where country_code = v_lock.country_code;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

grant execute on function public.release_stale_locks(integer) to service_role;
revoke execute on function public.release_stale_locks(integer) from anon, authenticated;
