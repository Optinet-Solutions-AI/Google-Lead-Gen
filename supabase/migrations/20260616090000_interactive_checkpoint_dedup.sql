-- ============================================================
-- Migration: one live interactive checkpoint per job
--
-- Bug (reported by Darren 2026-06-16): a single scrape job can hold
-- MULTIPLE 'waiting' checkpoints at once, across different workers.
-- When a job is requeued mid-captcha and re-claimed by a second VM
-- (release_stale_locks → another worker's claim_scrape_job), the
-- original worker's checkpoint stays 'waiting' even though that VM has
-- already recycled its browser to a different job.
--
-- Concretely: job 0399953a ("casino en ligne Interac", CA) parked
-- checkpoint 1337 on vm3-9222, got re-claimed by vm2-9222 which parked
-- 1338, and BOTH sat 'waiting'. The operator opened VNC on the vm3 card
-- (1337) but vm3 was now scraping something else — the live browser
-- showed an unrelated Akamai "Access Denied" page, not the captcha — so
-- "opening VNC does nothing" and "Resume does nothing" (Resume flips the
-- job to 'running', but the job is owned by vm2, so vm3 never resumes).
--
-- Fix: when a worker parks a NEW checkpoint for a job, supersede any
-- prior 'waiting' checkpoint(s) for that same job. The newest checkpoint
-- is always the one on the worker that currently holds the live browser
-- session (a job runs on one worker at a time; older waiting rows are
-- from superseded attempts). Result: exactly one live card per job —
-- the solvable one.
--
-- Superseded rows get a dedicated terminal status 'superseded' rather
-- than 'timed_out'/'cancelled' ON PURPOSE: both of those render a
-- "Re-queue with Captcha solver" button (checkpoint-card.tsx), and
-- requeue_scrape_after_captcha_solver accepts 'needs_human' jobs — so an
-- operator clicking Re-queue on a stale card would reset the job that's
-- actively scraping on the new worker. 'superseded' is not in the page's
-- status-tab list, so these rows drop out of the default Waiting view
-- and carry no action buttons. (A future UI PR can add a "Superseded"
-- tab + badge colour for auditability; functionally it's already inert.)
--
-- DB-only. Idempotent (create or replace + guarded constraint swap). No
-- VM redeploy and no app deploy required — the scraper already calls
-- create_interactive_checkpoint unchanged.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Allow the new terminal status.
-- ------------------------------------------------------------
-- The original status check is an inline column constraint, so its name
-- is whatever Postgres auto-generated (normally
-- interactive_checkpoints_status_check). Drop EVERY check constraint
-- that mentions the status column so we can't end up with a stale
-- constraint still rejecting 'superseded' alongside the new one.
do $$
declare
  v_con record;
begin
  for v_con in (
    select con.conname
    from pg_constraint con
    join pg_class rel  on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = 'interactive_checkpoints'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%status%'
  ) loop
    execute format('alter table public.interactive_checkpoints drop constraint %I', v_con.conname);
  end loop;
end$$;

alter table public.interactive_checkpoints
  add constraint interactive_checkpoints_status_check
  check (status in ('waiting', 'resolved', 'cancelled', 'timed_out', 'superseded'));

-- ------------------------------------------------------------
-- 2. Recreate create_interactive_checkpoint as a strict superset of the
--    current definition (20260528220000_shadow_user.sql) with the
--    supersede step added. Signature unchanged so the scraper's RPC call
--    keeps working without a redeploy.
-- ------------------------------------------------------------
create or replace function public.create_interactive_checkpoint(
  p_job_id          uuid,
  p_worker_id       text,
  p_worker_port     integer,
  p_reason          text,
  p_current_url     text default null,
  p_page_title      text default null,
  p_screenshot_path text default null,
  p_ttl_minutes     integer default 15,
  p_vnc_host        text default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_id            bigint;
  v_is_shadow     boolean;
begin
  -- Supersede any still-'waiting' checkpoint for this job. They belong to
  -- a prior attempt whose worker has moved on; leaving them 'waiting'
  -- sends operators to a dead VNC session and a no-op Resume. Does NOT
  -- touch scrape_queue.status — the insert below (re)asserts needs_human,
  -- and the live attempt owns the job's status.
  update public.interactive_checkpoints
  set status          = 'superseded',
      resolution_note = coalesce(resolution_note,
        'Superseded — a newer checkpoint was parked for this job (worker re-parked or job re-claimed).'),
      resolved_at     = now(),
      updated_at      = now()
  where job_id = p_job_id
    and status = 'waiting';

  select coalesce(created_by_is_shadow, false) into v_is_shadow
  from public.scrape_queue where id = p_job_id;

  insert into public.interactive_checkpoints
    (job_id, worker_id, worker_port, reason, current_url, page_title,
     screenshot_path, expires_at, vnc_host, job_is_shadow)
  values
    (p_job_id, p_worker_id, p_worker_port, p_reason, p_current_url, p_page_title,
     p_screenshot_path, now() + make_interval(mins => p_ttl_minutes),
     p_vnc_host, coalesce(v_is_shadow, false))
  returning id into v_id;

  update public.scrape_queue
  set status = 'needs_human',
      updated_at = now()
  where id = p_job_id;

  return v_id;
end;
$$;

grant execute on function public.create_interactive_checkpoint(
  uuid, text, integer, text, text, text, text, integer, text
) to service_role;
revoke execute on function public.create_interactive_checkpoint(
  uuid, text, integer, text, text, text, text, integer, text
) from anon, authenticated;
