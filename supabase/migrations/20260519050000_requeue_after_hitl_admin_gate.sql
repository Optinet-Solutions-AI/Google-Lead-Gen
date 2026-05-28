-- ============================================================
-- Lock down requeue_scrape_after_hitl: admin-only, in two layers.
-- (Legacy function name retained; the 2026-05-28 rename migration
-- adds requeue_scrape_after_captcha_solver and keeps this name as a
-- shim.)
--
-- The previous migration (20260519030000) granted EXECUTE on this
-- SECURITY DEFINER function to `authenticated`. That meant any signed-in
-- user with a valid JWT could call it via PostgREST and re-queue another
-- user's captcha/failed/cancelled job — bypassing the admin gate in the
-- UI server action. See BUGS.md R3-X2.
--
-- Defense in depth:
--   1. Revoke the EXECUTE grant from `authenticated` so PostgREST refuses
--      direct calls. Keep service_role so server actions still work.
--   2. Add `is_admin(auth.uid())` inside the function body so even if a
--      future caller (or a service_role misroute) reaches it without
--      checking, the function itself fails closed.
--
-- Idempotent: REVOKE IF EXISTS is implicit (revoke is no-op if no grant);
-- CREATE OR REPLACE handles the body update.
-- ============================================================

create or replace function public.requeue_scrape_after_hitl(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_prior_status text;
  v_caller_uid   uuid := auth.uid();
begin
  -- Inside-the-function admin gate. auth.uid() returns null when the
  -- function is called by a Postgres role that isn't a JWT-authenticated
  -- request (e.g. the service_role client used by the server action) —
  -- in that case we trust the caller (the wrapping server action already
  -- enforced requireAdmin()). Otherwise we require the JWT user to be
  -- an admin per user_profiles.is_admin.
  if v_caller_uid is not null and not public.is_admin(v_caller_uid) then
    raise exception 'admin access required to re-queue scrape jobs'
      using errcode = '42501';
  end if;

  select status into v_prior_status
  from public.scrape_queue
  where id = p_job_id;

  if v_prior_status is null then
    raise exception 'scrape_queue row % not found', p_job_id using errcode = 'P0002';
  end if;

  if v_prior_status not in ('captcha', 'failed', 'cancelled', 'needs_human') then
    raise exception 'cannot re-queue job in status %', v_prior_status using errcode = '22023';
  end if;

  update public.scrape_queue
  set status            = 'pending',
      claimed_by        = null,
      started_at        = null,
      completed_at      = null,
      error_message     = null,
      attempts          = 0,
      captcha_attempts  = 0,
      updated_at        = now()
  where id = p_job_id;

  delete from public.active_profile_locks where job_id = p_job_id;

  return coalesce(v_prior_status, 'unknown');
end;
$$;

-- Tighten the grants: only service_role may execute. PostgREST callers
-- (anon, authenticated) get a 42501 from the GRANT layer before they
-- even touch the function body.
revoke execute on function public.requeue_scrape_after_hitl(uuid) from public, anon, authenticated;
grant execute on function public.requeue_scrape_after_hitl(uuid) to service_role;
