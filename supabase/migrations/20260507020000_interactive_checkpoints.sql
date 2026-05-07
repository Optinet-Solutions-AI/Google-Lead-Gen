-- ============================================================
-- Migration: Human-in-the-loop interactive checkpoints
--
-- When the scraper hits a wall it can't get past on its own
-- (Google captcha, age-verification dialog, cookie consent banner
-- with no programmatic close button), it writes a row here and
-- polls for the operator to resolve it via a noVNC stream in the
-- dashboard. Once 'resolved', the scraper continues from where it
-- paused.
--
-- The country lock stays held for the duration so no other worker
-- steals the session while the human is clicking through. To stop
-- pg_cron's release_stale_locks(30) from yanking the lock out from
-- under a paused job, we teach it to skip jobs whose status is
-- 'needs_human'.
-- ============================================================

-- ------------------------------------------------------------
-- 1. interactive_checkpoints table
-- ------------------------------------------------------------
create table if not exists public.interactive_checkpoints (
  id              bigint generated always as identity primary key,
  job_id          uuid        not null references public.scrape_queue(id) on delete cascade,
  worker_id       text        not null,
  -- Chrome debugger port the paused browser is on (9222 / 9223 / 9224).
  -- Drives the noVNC URL the dashboard hands the operator.
  worker_port     integer     not null,
  -- 'captcha' | 'age_gate' | 'cookie_banner' | 'unknown'. Drives the
  -- banner copy + per-card icon.
  reason          text        not null,
  current_url     text,
  -- Page title at the moment of pause — quick at-a-glance ID for the
  -- operator deciding which paused session is which when several are
  -- waiting at once.
  page_title      text,
  -- A small PNG of the Chromium viewport at the moment of pause,
  -- stored in the lead-screenshots Storage bucket. The dashboard
  -- thumbnails it on the checkpoint card so the operator can match
  -- card → live session before clicking Open VNC.
  screenshot_path text,
  status          text        not null default 'waiting'
                    check (status in ('waiting', 'resolved', 'cancelled', 'timed_out')),
  resolution_note text,
  resolved_at     timestamptz,
  resolved_by     text,
  -- TTL — auto-cancel after this so an abandoned session doesn't
  -- hold a country lock indefinitely. Default 15 minutes.
  expires_at      timestamptz not null default (now() + interval '15 minutes'),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_interactive_checkpoints_status_created_at
  on public.interactive_checkpoints (status, created_at desc);
create index if not exists idx_interactive_checkpoints_job_id
  on public.interactive_checkpoints (job_id);

-- Touch updated_at on row changes so the dashboard "last activity"
-- field stays honest without hand-stamping every update.
create or replace function public.touch_interactive_checkpoints_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_interactive_checkpoints_updated_at on public.interactive_checkpoints;
create trigger trg_interactive_checkpoints_updated_at
  before update on public.interactive_checkpoints
  for each row execute function public.touch_interactive_checkpoints_updated_at();

-- ------------------------------------------------------------
-- 2. needs_human status on scrape_queue
-- ------------------------------------------------------------
-- Add 'needs_human' to the allowed scrape_queue.status values so the
-- scraper can flip the row while it polls + the rest of the system
-- knows the row is paused, not running.
do $$
begin
  if exists (
    select 1 from information_schema.constraint_column_usage
    where table_schema = 'public'
      and table_name   = 'scrape_queue'
      and column_name  = 'status'
  ) then
    alter table public.scrape_queue drop constraint if exists scrape_queue_status_check;
  end if;
exception when others then
  -- swallow; we re-add below regardless
  null;
end$$;

alter table public.scrape_queue
  add constraint scrape_queue_status_check
  check (status in (
    'pending', 'running', 'completed', 'failed',
    'captcha', 'paused', 'cancelled', 'needs_human'
  ));

-- ------------------------------------------------------------
-- 3. release_stale_locks: skip jobs whose status is 'needs_human'
-- ------------------------------------------------------------
-- Re-creates the function from 20260424320000_enrichment_fetch_queue.sql
-- as a strict superset — same parameter name, same semantics for
-- both `scrape` and `enrichment` job_kinds — with one new exception:
-- locks held by a scrape_queue row in status='needs_human' are
-- considered intentionally-idle (an admin is clicking through a
-- captcha via noVNC) and are NOT released. The interactive_checkpoint
-- TTL on the parent row handles eventual cleanup if the operator
-- never shows up.
--
-- DROP first because we cannot CREATE OR REPLACE while keeping the
-- original parameter name `p_max_age_minutes` AND adjusting body —
-- Postgres actually allows that, but earlier in this migration we
-- attempted a rename (`p_grace_seconds`) which the planner caches as
-- the existing signature. Drop-and-recreate is the cleanest way to
-- guarantee we land on a known shape regardless of prior state.
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
    -- Brand-new HITL exception: never release a scrape lock for a
    -- job that's currently parked at an interactive checkpoint.
    -- The operator may legitimately need 5-15 min to click through.
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

    delete from public.active_profile_locks where country_code = v_lock.country_code;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

grant execute on function public.release_stale_locks(integer) to service_role;
revoke execute on function public.release_stale_locks(integer) from anon, authenticated;

-- ------------------------------------------------------------
-- 4. Helper RPCs for the scraper + dashboard to coordinate without
-- racing on direct writes.
-- ------------------------------------------------------------

-- Scraper calls this when it detects a wall. Returns the new row id.
create or replace function public.create_interactive_checkpoint(
  p_job_id          uuid,
  p_worker_id       text,
  p_worker_port     integer,
  p_reason          text,
  p_current_url     text default null,
  p_page_title      text default null,
  p_screenshot_path text default null,
  p_ttl_minutes     integer default 15
)
returns bigint
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  insert into public.interactive_checkpoints
    (job_id, worker_id, worker_port, reason, current_url, page_title,
     screenshot_path, expires_at)
  values
    (p_job_id, p_worker_id, p_worker_port, p_reason, p_current_url, p_page_title,
     p_screenshot_path, now() + make_interval(mins => p_ttl_minutes))
  returning id into v_id;

  -- Flip the parent job into needs_human so release_stale_locks
  -- skips it and the scrape_queue table tells the dashboard "paused".
  update public.scrape_queue
  set status = 'needs_human',
      updated_at = now()
  where id = p_job_id;

  return v_id;
end;
$$;

grant execute on function public.create_interactive_checkpoint(
  uuid, text, integer, text, text, text, text, integer
) to service_role;
revoke execute on function public.create_interactive_checkpoint(
  uuid, text, integer, text, text, text, text, integer
) from anon, authenticated;

-- Operator (admin) clicked Resume in the dashboard. Flips the
-- checkpoint to resolved + bounces the job back to running so the
-- scraper's polling loop sees the change.
create or replace function public.resolve_interactive_checkpoint(
  p_id      bigint,
  p_note    text default null,
  p_user    text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  update public.interactive_checkpoints
  set status          = 'resolved',
      resolution_note = p_note,
      resolved_at     = now(),
      resolved_by     = p_user
  where id = p_id and status = 'waiting'
  returning job_id into v_job_id;

  if v_job_id is not null then
    update public.scrape_queue
    set status = 'running',
        updated_at = now()
    where id = v_job_id and status = 'needs_human';
  end if;
end;
$$;

grant execute on function public.resolve_interactive_checkpoint(bigint, text, text)
  to service_role;
revoke execute on function public.resolve_interactive_checkpoint(bigint, text, text)
  from anon, authenticated;

-- Cancel = give up. Marks the job failed + frees the country lock.
create or replace function public.cancel_interactive_checkpoint(
  p_id      bigint,
  p_note    text default null,
  p_user    text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  update public.interactive_checkpoints
  set status          = 'cancelled',
      resolution_note = p_note,
      resolved_at     = now(),
      resolved_by     = p_user
  where id = p_id and status = 'waiting'
  returning job_id into v_job_id;

  if v_job_id is not null then
    update public.scrape_queue
    set status        = 'failed',
        error_message = coalesce(p_note, 'cancelled by operator at human-in-the-loop checkpoint'),
        completed_at  = now(),
        updated_at    = now()
    where id = v_job_id and status = 'needs_human';

    delete from public.active_profile_locks where job_id = v_job_id;
  end if;
end;
$$;

grant execute on function public.cancel_interactive_checkpoint(bigint, text, text)
  to service_role;
revoke execute on function public.cancel_interactive_checkpoint(bigint, text, text)
  from anon, authenticated;
