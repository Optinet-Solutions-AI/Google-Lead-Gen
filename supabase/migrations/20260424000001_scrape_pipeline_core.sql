-- ============================================================
-- Migration: Scrape Pipeline Core
--
-- Adds everything needed for the multi-worker scraping pipeline:
--
--   Config
--     - gologin_profiles                (seeded with 15 countries)
--   Scheduling
--     - scheduled_keyword_sets
--     - scheduled_keyword_items
--   Queue
--     - scrape_queue                    (pending -> running -> completed|failed|captcha)
--     - active_profile_locks            (one-row-per-country; enforces "same profile can't run twice")
--     - batch_counter                   (singleton, source of get_next_batch_id)
--   Output
--     - google_lead_gen_table           (where scrape results land + later pipeline stages write)
--   RPCs (SECURITY DEFINER, search_path pinned)
--     - get_next_batch_id()
--     - claim_scrape_job(worker_id)
--     - complete_scrape_job(job_id, results jsonb, summary jsonb)
--     - captcha_scrape_job(job_id)
--     - fail_scrape_job(job_id, error)
--     - release_stale_locks(max_age_minutes)
--
-- RLS is ENABLED on every new table with NO policies — anon/authenticated
-- cannot read or write any of these directly. All access goes through
-- the service role (which bypasses RLS) via Next.js API routes and
-- the worker on the VM.
-- ============================================================

-- ------------------------------------------------------------
-- 1. gologin_profiles — country -> profile mapping
-- ------------------------------------------------------------
create table if not exists public.gologin_profiles (
  country_code         text        primary key,      -- ISO 3166-1 alpha-2
  country_name         text        not null,
  gologin_profile_id   text,                         -- hex id passed to the Python scraper
  gologin_display_name text,                         -- "011 | TP Test | Germany" for debugging
  is_active            boolean     not null default true,
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.gologin_profiles enable row level security;

-- Seed 15 profiles. gologin_profile_id stays NULL; the sync script
-- (npm run gologin:sync-profiles, shipped next) fills it in.
insert into public.gologin_profiles (country_code, country_name, gologin_display_name) values
  ('DK', 'Denmark',       '023 | TP Test | Denmark'),
  ('IT', 'Italy',         '022 | TP Test | Italy'),
  ('AU', 'Australia',     '021 | TP Test | Australia'),
  ('OM', 'Oman',          '020 | TP Test | Oman'),
  ('KW', 'Kuwait',        '019 | TP Test | Kuwait'),
  ('BH', 'Bahrain',       '018 | TP Test | Bahrain'),
  ('QA', 'Qatar',         '017 | TP Test | Qatar'),
  ('SA', 'Saudi Arabia',  '016 | TP Test | Saudi Arabia'),
  ('AE', 'UAE',           '015 | TP Test | United Arab Emirates'),
  ('NO', 'Norway',        '014 | TP Test | Norway'),
  ('AT', 'Austria',       '013 | TP Test | Austria'),
  ('NZ', 'New Zealand',   '012 | TP Test | New Zealand'),
  ('DE', 'Germany',       '011 | TP Test | Germany'),
  ('CA', 'Canada',        '010 | TP Test | Canada'),
  ('GB', 'UK',            '008 | TP Test | UK')
on conflict (country_code) do nothing;

-- ------------------------------------------------------------
-- 2. scheduled_keyword_sets — cron-driven scrape schedules
-- ------------------------------------------------------------
create table if not exists public.scheduled_keyword_sets (
  id              uuid        primary key default gen_random_uuid(),
  name            text        not null unique,
  description     text,
  cron            text,                                 -- nullable = ad-hoc
  is_active       boolean     not null default true,
  default_pages   integer     not null default 1,
  last_run_at     timestamptz,
  next_run_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.scheduled_keyword_sets enable row level security;

create index if not exists idx_sks_active_next_run
  on public.scheduled_keyword_sets (next_run_at)
  where is_active = true;

-- ------------------------------------------------------------
-- 3. scheduled_keyword_items — one (keyword, country) per row
-- ------------------------------------------------------------
create table if not exists public.scheduled_keyword_items (
  id            uuid        primary key default gen_random_uuid(),
  set_id        uuid        not null references public.scheduled_keyword_sets(id) on delete cascade,
  keyword       text        not null,
  country_code  text        not null references public.gologin_profiles(country_code),
  pages         integer,                                -- null = inherit default_pages from set
  priority      integer     not null default 0,
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  unique (set_id, keyword, country_code)
);

alter table public.scheduled_keyword_items enable row level security;

create index if not exists idx_ski_set_active
  on public.scheduled_keyword_items (set_id, is_active);

-- ------------------------------------------------------------
-- 4. scrape_queue — the work queue
-- (Created before google_lead_gen_table because that table FKs into this one.)
-- ------------------------------------------------------------
create table if not exists public.scrape_queue (
  id               uuid        primary key default gen_random_uuid(),
  keyword          text        not null,
  country_code     text        not null references public.gologin_profiles(country_code),
  pages            integer     not null default 1,
  priority         integer     not null default 0,
  status           text        not null default 'pending'
                   check (status in ('pending', 'running', 'completed', 'failed', 'captcha')),
  attempts         integer     not null default 0,
  max_attempts     integer     not null default 3,
  batch_id         bigint,
  scheduled_run_id uuid        references public.scheduled_keyword_sets(id) on delete set null,
  claimed_by       text,
  started_at       timestamptz,
  completed_at     timestamptz,
  error_message    text,
  result_summary   jsonb,                               -- { total_results, organic, ppc, pages_scraped, scraped_at }
  raw_results      jsonb,                               -- full payload cache (crash-recovery)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.scrape_queue enable row level security;

-- Pending-claim index: only indexes pending rows, ordered to match claim query
create index if not exists idx_scrape_queue_pending
  on public.scrape_queue (priority desc, created_at asc)
  where status = 'pending';

create index if not exists idx_scrape_queue_status
  on public.scrape_queue (status, created_at desc);

create index if not exists idx_scrape_queue_batch_id
  on public.scrape_queue (batch_id);

-- ------------------------------------------------------------
-- 5. google_lead_gen_table — output of the scrape + downstream pipeline stages
-- ------------------------------------------------------------
create table if not exists public.google_lead_gen_table (
  id                      bigint      generated always as identity primary key,

  -- Scrape result fields (filled by the worker via complete_scrape_job)
  keyword                 text,
  country                 text,
  country_code            text        references public.gologin_profiles(country_code),
  url                     text,
  domain                  text,
  page_number             integer,
  position_on_page        integer,
  overall_position        integer,
  result_type             text,                         -- 'Organic' | 'PPC'
  batch_id                bigint,
  scrape_job_id           uuid        references public.scrape_queue(id) on delete set null,

  -- Reserved for later pipeline stages
  brand                   text,
  affiliate_name          text,
  contact_id              bigint,
  s_tag_id                bigint,
  has_contact_details     boolean,
  has_s_tags              boolean,
  html_tags               text,
  is_affiliate            boolean,
  is_on_monday            boolean,
  is_rooster_partner      boolean,
  screenshot_content_link text,
  screenshot_view_link    text,
  remarks                 text,
  status                  text,

  created_at              timestamptz not null default now()
);

alter table public.google_lead_gen_table enable row level security;

create index if not exists idx_glg_batch_id       on public.google_lead_gen_table (batch_id);
create index if not exists idx_glg_domain         on public.google_lead_gen_table (domain);
create index if not exists idx_glg_country_code   on public.google_lead_gen_table (country_code);
create index if not exists idx_glg_result_type    on public.google_lead_gen_table (result_type);
create index if not exists idx_glg_status         on public.google_lead_gen_table (status);
create index if not exists idx_glg_created_at     on public.google_lead_gen_table (created_at desc);
create index if not exists idx_glg_scrape_job_id  on public.google_lead_gen_table (scrape_job_id);

-- ------------------------------------------------------------
-- 6. active_profile_locks — one row per in-flight country
-- ------------------------------------------------------------
create table if not exists public.active_profile_locks (
  country_code text        primary key references public.gologin_profiles(country_code),
  job_id       uuid        not null references public.scrape_queue(id) on delete cascade,
  worker_id    text        not null,
  locked_at    timestamptz not null default now()
);

alter table public.active_profile_locks enable row level security;

create index if not exists idx_active_profile_locks_job_id
  on public.active_profile_locks (job_id);

create index if not exists idx_active_profile_locks_locked_at
  on public.active_profile_locks (locked_at);

-- ------------------------------------------------------------
-- 7. batch_counter — singleton for get_next_batch_id
-- ------------------------------------------------------------
create table if not exists public.batch_counter (
  id         integer primary key default 1,
  next_value bigint  not null default 1,
  constraint batch_counter_singleton check (id = 1)
);

alter table public.batch_counter enable row level security;

insert into public.batch_counter (id, next_value) values (1, 1)
on conflict (id) do nothing;

-- ============================================================
-- RPCs — all SECURITY DEFINER with pinned search_path
-- ============================================================

-- ------------------------------------------------------------
-- get_next_batch_id — atomic increment-and-return
-- ------------------------------------------------------------
create or replace function public.get_next_batch_id()
returns bigint
language sql
volatile
security definer
set search_path = public
as $$
  update public.batch_counter
  set next_value = next_value + 1
  where id = 1
  returning next_value - 1;
$$;

grant execute on function public.get_next_batch_id() to service_role;
revoke execute on function public.get_next_batch_id() from anon, authenticated;

-- ------------------------------------------------------------
-- claim_scrape_job — called by the worker every poll tick
-- Returns the claimed row, or NULL if nothing available.
--
-- Atomicity guarantees (all in one transaction):
--   1. FOR UPDATE SKIP LOCKED prevents two workers picking the same row
--   2. active_profile_locks.country_code PK prevents two workers locking
--      the same country (ON CONFLICT DO NOTHING => NOT FOUND => return NULL)
--   3. Status flip to 'running' + attempts increment happen only if
--      both the row lock and the profile lock are ours
-- ------------------------------------------------------------
create or replace function public.claim_scrape_job(p_worker_id text)
returns public.scrape_queue
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_candidate_id   uuid;
  v_country_code   text;
  v_row            public.scrape_queue;
begin
  -- Step 1: find a pending job whose country isn't currently locked
  select s.id, s.country_code
    into v_candidate_id, v_country_code
  from public.scrape_queue s
  where s.status = 'pending'
    and s.attempts < s.max_attempts
    and not exists (
      select 1 from public.active_profile_locks l
      where l.country_code = s.country_code
    )
  order by s.priority desc, s.created_at asc
  limit 1
  for update skip locked;

  if v_candidate_id is null then
    return null;
  end if;

  -- Step 2: try to acquire the country lock
  insert into public.active_profile_locks (country_code, job_id, worker_id)
  values (v_country_code, v_candidate_id, p_worker_id)
  on conflict (country_code) do nothing;

  if not found then
    -- A sibling worker beat us to it in the same tick
    return null;
  end if;

  -- Step 3: mark the job running and bump attempts
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

-- ------------------------------------------------------------
-- complete_scrape_job — called by the worker on SUCCESS
--
-- Atomic: increments batch_counter, inserts every result row into
-- google_lead_gen_table, updates scrape_queue, releases the country
-- lock. Either all of that commits, or none of it does.
--
-- p_results is the `results[]` array from the Python scraper — each
-- element has { url, full_url, title, resultType, page, position,
-- overall_position, keyword, country }.
--
-- p_summary is an optional jsonb of { total_results, organic, ppc,
-- pages_scraped, scraped_at } stored alongside the queue row.
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
  v_batch_id     bigint;
  v_job          public.scrape_queue;
  v_country_name text;
begin
  -- Fetch job info (also errors out clearly if the id is bogus)
  select * into v_job from public.scrape_queue where id = p_job_id;
  if v_job.id is null then
    raise exception 'scrape_queue row % not found', p_job_id;
  end if;

  -- Resolve display country_name once
  select country_name into v_country_name
  from public.gologin_profiles
  where country_code = v_job.country_code;

  -- Atomic batch increment
  update public.batch_counter
  set next_value = next_value + 1
  where id = 1
  returning next_value - 1 into v_batch_id;

  -- Insert every result row in a single statement (atomic w/ the rest)
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

  return v_batch_id;
end;
$$;

grant execute on function public.complete_scrape_job(uuid, jsonb, jsonb) to service_role;
revoke execute on function public.complete_scrape_job(uuid, jsonb, jsonb) from anon, authenticated;

-- ------------------------------------------------------------
-- captcha_scrape_job — worker hit CAPTCHA; mark and move on
-- Per the user's policy: mark the job, release the lock, skip to next.
-- A separate retry flow can requeue these later.
-- ------------------------------------------------------------
create or replace function public.captcha_scrape_job(p_job_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  update public.scrape_queue
  set status        = 'captcha',
      completed_at  = now(),
      error_message = 'CAPTCHA detected',
      updated_at    = now()
  where id = p_job_id;

  delete from public.active_profile_locks where job_id = p_job_id;
end;
$$;

grant execute on function public.captcha_scrape_job(uuid) to service_role;
revoke execute on function public.captcha_scrape_job(uuid) from anon, authenticated;

-- ------------------------------------------------------------
-- fail_scrape_job — generic failure; requeues if attempts remain
-- ------------------------------------------------------------
create or replace function public.fail_scrape_job(p_job_id uuid, p_error text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_attempts     integer;
  v_max_attempts integer;
begin
  select attempts, max_attempts
    into v_attempts, v_max_attempts
  from public.scrape_queue
  where id = p_job_id;

  update public.scrape_queue
  set status        = case
                        when v_attempts < v_max_attempts then 'pending'
                        else 'failed'
                      end,
      claimed_by    = null,
      started_at    = null,
      error_message = p_error,
      updated_at    = now()
  where id = p_job_id;

  delete from public.active_profile_locks where job_id = p_job_id;
end;
$$;

grant execute on function public.fail_scrape_job(uuid, text) to service_role;
revoke execute on function public.fail_scrape_job(uuid, text) from anon, authenticated;

-- ------------------------------------------------------------
-- release_stale_locks — safety net for crashed workers
-- Default max age: 30 minutes (a healthy scrape shouldn't exceed it)
-- Call via pg_cron or the worker's periodic maintenance.
-- ------------------------------------------------------------
create or replace function public.release_stale_locks(p_max_age_minutes integer default 30)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with stale as (
    delete from public.active_profile_locks
    where locked_at < now() - (p_max_age_minutes || ' minutes')::interval
    returning job_id
  )
  update public.scrape_queue s
  set status        = case
                        when s.attempts < s.max_attempts then 'pending'
                        else 'failed'
                      end,
      claimed_by    = null,
      started_at    = null,
      error_message = 'Worker timed out (lock was held > ' || p_max_age_minutes || ' min)',
      updated_at    = now()
  from stale
  where s.id = stale.job_id
    and s.status = 'running';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.release_stale_locks(integer) to service_role;
revoke execute on function public.release_stale_locks(integer) from anon, authenticated;
