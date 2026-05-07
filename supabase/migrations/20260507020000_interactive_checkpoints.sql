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
-- Find the existing function signature first so the rewrite drops
-- and re-creates it with the same arg list (the cron job calls it
-- by name + 30s arg).
create or replace function public.release_stale_locks(p_grace_seconds integer default 30)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  -- A "stale" lock is one whose claimer hasn't heartbeated within
  -- `p_grace_seconds`. We delete the lock + bounce the job back to
  -- pending so another worker can pick it up.
  --
  -- Exception: jobs in status='needs_human' have a paused worker
  -- that's intentionally idle (operator clicking through a captcha
  -- in the dashboard). Don't yank those locks; the auto-skip TTL
  -- on interactive_checkpoints handles them.
  with stale as (
    delete from public.active_profile_locks l
    using public.scrape_queue q
    where l.job_id = q.id
      and q.status <> 'needs_human'
      and l.heartbeat_at < now() - make_interval(secs => p_grace_seconds)
    returning q.id as job_id
  ),
  bounced as (
    update public.scrape_queue
    set status = 'pending',
        claimed_by = null,
        started_at = null,
        updated_at = now()
    where id in (select job_id from stale)
    returning id
  )
  select count(*) into v_count from bounced;
  return coalesce(v_count, 0);
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
