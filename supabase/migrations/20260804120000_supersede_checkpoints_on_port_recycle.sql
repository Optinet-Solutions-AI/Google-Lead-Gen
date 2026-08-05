-- ============================================================
-- Fix: stale captcha checkpoints stream the WRONG engine's session.
--
-- QA (2026-08-04): an operator opens a Google reCAPTCHA from the
-- Interactive queue but noVNC shows a Bing scrape running on that port.
-- Root cause: worker.py never closes interactive_checkpoints. When the
-- Google scraper subprocess dies before it can time out its own
-- checkpoint (OOM / systemd restart / redeploy / VM reboot / the 65-min
-- worker timeout), the row stays 'waiting' with a still-future
-- expires_at. The worker then kills the port and claims its NEXT job —
-- often a different engine (Bing/X/…) — on the SAME port + Xvfb display.
-- The noVNC URL is port-only, so the stale card streams the new session.
-- The job-status reaper can't catch it: it lags a minute, and on a
-- whole-worker death the job stays 'needs_human' (never terminal) so the
-- reaper never fires.
--
-- This RPC lets the worker close a port's stale checkpoints at the exact
-- moment it recycles the browser (from _kill_port(), which runs before
-- every job claim) — before the next engine's browser even mounts.
-- 'superseded' is already an inert, non-operator-visible status.
-- ============================================================

create or replace function public.supersede_interactive_checkpoints_for_worker(
  p_worker_id   text,
  p_worker_port integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.interactive_checkpoints
  set status          = 'superseded',
      resolved_at     = now(),
      resolved_by     = 'worker-recycle',
      resolution_note = 'Port recycled for a new job — the parked browser session is gone'
  where worker_id = p_worker_id
    and worker_port = p_worker_port
    and status = 'waiting';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.supersede_interactive_checkpoints_for_worker(text, integer) to service_role;
revoke execute on function public.supersede_interactive_checkpoints_for_worker(text, integer) from anon, authenticated;
