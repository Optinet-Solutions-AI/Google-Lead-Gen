-- ============================================================
-- Allow up to N concurrent jobs per country (default N=3, matching
-- the VM fleet count). Before this migration, active_profile_locks
-- used country_code as its primary key, so only ONE worker could
-- hold a given country at a time — which meant a 5-min Captcha
-- solver pause on a DE job would idle every other DE job in the
-- queue, even though we have 18 workers across 3 VMs that could
-- chew through them.
--
-- After this migration:
--   - active_profile_locks PK = job_id (each running job has its own
--     lock row, multiple rows per country are allowed).
--   - claim_scrape_job / claim_enrichment_fetch_job count locks per
--     country and reject the claim only if count >= max_concurrent.
--   - release_stale_locks deletes by job_id, not country_code (so a
--     single stale lock doesn't take its siblings down with it).
--   - system_settings.max_concurrent_per_country drives the cap so
--     operators can dial it up when adding VMs without a redeploy.
--
-- Worker-side correctness note: GoLogin profiles are still 1-per-
-- country, so two concurrent DE jobs will both launch the same
-- profile_id. Whether GoLogin allows two simultaneous sessions
-- depends on plan/setup; if it errors with "profile in use", the
-- second worker fails fast and re-queues. No data is corrupted.
-- ============================================================

-- Default cap = 3 (one per VM in the current fleet). Operators
-- bump this via /admin/system when they add a 4th VM, or drop it
-- back to 1 if GoLogin's session lock rejects concurrent opens.
insert into public.system_settings (key, value)
values ('max_concurrent_per_country', '3'::jsonb)
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 1. Re-key active_profile_locks: PK becomes job_id; country_code
-- gets a regular index for the count query in the claim RPCs.
-- ------------------------------------------------------------
alter table public.active_profile_locks
  drop constraint if exists active_profile_locks_pkey;

-- job_id was already declared `not null references scrape_queue` —
-- the cross-queue scrape/enrichment use was added in
-- 20260424320000_enrichment_fetch_queue.sql by dropping that FK.
-- Adding the PK here is enough; existing rows survive the rekey
-- because country_code was unique under the old schema.
alter table public.active_profile_locks
  add constraint active_profile_locks_pkey primary key (job_id);

create index if not exists idx_active_profile_locks_country
  on public.active_profile_locks (country_code);

-- ------------------------------------------------------------
-- 2. claim_scrape_job — count locks instead of exists check
-- ------------------------------------------------------------
create or replace function public.claim_scrape_job(p_worker_id text)
returns public.scrape_queue
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_candidate_id  uuid;
  v_country_code  text;
  v_row           public.scrape_queue;
  v_max_per_country integer;
begin
  -- Read the per-country cap from system_settings each call. Cheap
  -- index lookup; lets ops tune live without restarting workers.
  select coalesce((value)::integer, 3)
    into v_max_per_country
  from public.system_settings
  where key = 'max_concurrent_per_country';
  if v_max_per_country is null then v_max_per_country := 3; end if;

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
  order by s.priority desc, s.created_at asc
  limit 1
  for update skip locked;

  if v_candidate_id is null then
    return null;
  end if;

  -- PK is now job_id, so this insert is naturally unique per job
  -- and conflicts only on race-condition double-claims of the same
  -- row (which the FOR UPDATE SKIP LOCKED above already prevents).
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

-- ------------------------------------------------------------
-- 3. claim_enrichment_fetch_job — same shape as scrape claim
-- ------------------------------------------------------------
create or replace function public.claim_enrichment_fetch_job(p_worker_id text)
returns public.enrichment_fetch_queue
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id              uuid;
  v_country         text;
  v_row             public.enrichment_fetch_queue;
  v_max_per_country integer;
begin
  select coalesce((value)::integer, 3)
    into v_max_per_country
  from public.system_settings
  where key = 'max_concurrent_per_country';
  if v_max_per_country is null then v_max_per_country := 3; end if;

  select e.id, e.country_code
    into v_id, v_country
  from public.enrichment_fetch_queue e
  where e.status = 'pending'
    and e.attempts < e.max_attempts
    and (
      select count(*) from public.active_profile_locks l
      where l.country_code = e.country_code
    ) < v_max_per_country
  order by e.created_at asc
  limit 1
  for update skip locked;

  if v_id is null then return null; end if;

  insert into public.active_profile_locks (country_code, job_id, worker_id, job_kind)
  values (v_country, v_id, p_worker_id, 'enrichment')
  on conflict (job_id) do nothing;

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
-- 4. release_stale_locks — delete by job_id, not country_code
-- ------------------------------------------------------------
-- Old version deleted every lock for a country when one went
-- stale. With multiple concurrent locks per country that would
-- clobber 2 healthy jobs. Now we only release the specific lock
-- that timed out.
-- ------------------------------------------------------------
drop function if exists public.release_stale_locks(integer);

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
  v_skip  boolean;
begin
  for v_lock in (
    select country_code, job_id, job_kind
    from public.active_profile_locks
    where locked_at < now() - (p_max_age_minutes || ' minutes')::interval
  ) loop
    -- Keep the HITL exception: jobs parked at an interactive
    -- checkpoint are intentionally idle, not stuck workers.
    v_skip := false;
    if v_lock.job_kind = 'scrape' then
      select status = 'needs_human' into v_skip
      from public.scrape_queue
      where id = v_lock.job_id;
    end if;
    if coalesce(v_skip, false) then
      continue;
    end if;

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

    -- Key change: delete THIS lock, not every lock for the country.
    delete from public.active_profile_locks where job_id = v_lock.job_id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

grant execute on function public.release_stale_locks(integer) to service_role;
revoke execute on function public.release_stale_locks(integer) from anon, authenticated;
