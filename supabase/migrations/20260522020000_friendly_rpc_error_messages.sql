-- ============================================================
-- Friendlier error_message text from two RPCs that ops see in
-- the Recent Activity table:
--
--   1. captcha_scrape_job — when captcha_attempts hits the cap (10),
--      the row currently surfaces "Captcha hit 10 times — manual
--      retry required." which is opaque to non-technical viewers.
--
--   2. mark_scrape_job_captcha_terminal — default p_error of
--      "HITL timed out without operator action" (legacy wording —
--      kept here for the historical record; later migrations rewrite
--      the default to "Captcha helper" and then "Captcha solver").
--      The Python worker always passes an explicit friendly override
--      so new rows from vm/worker.py don't see this; but the default
--      is what shows up if any other caller forgets to pass p_error.
--
-- Logic is unchanged in both functions — only the error_message
-- string literals are rewritten. Pre-existing scrape_queue rows
-- are NOT rewritten (consistent with the 2026-05-21 wording pass
-- in commit cd17196).
-- ============================================================

-- ------------------------------------------------------------
-- captcha_scrape_job — soften the cap-reached message.
-- (Body is identical to 20260429120000_captcha_auto_retry.sql
-- except for the two error_message strings.)
-- ------------------------------------------------------------
create or replace function public.captcha_scrape_job(p_job_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_max_captcha integer := 10;
  v_attempts    integer;
begin
  select coalesce(captcha_attempts, 0)
    into v_attempts
  from public.scrape_queue
  where id = p_job_id;

  v_attempts := v_attempts + 1;

  if v_attempts < v_max_captcha then
    update public.scrape_queue
    set status            = 'pending',
        captcha_attempts  = v_attempts,
        attempts          = 0,
        claimed_by        = null,
        started_at        = null,
        completed_at      = null,
        error_message     = format(
          'Search engine showed a captcha. Trying again with a fresh proxy IP (attempt %s of %s) — no action needed.',
          v_attempts, v_max_captcha
        ),
        updated_at        = now()
    where id = p_job_id;
  else
    update public.scrape_queue
    set status            = 'captcha',
        captcha_attempts  = v_attempts,
        completed_at      = now(),
        error_message     = format(
          'Captcha kept appearing after %s tries. Open the row menu and click "Try again" to reset and re-queue.',
          v_attempts
        ),
        updated_at        = now()
    where id = p_job_id;
  end if;

  delete from public.active_profile_locks where job_id = p_job_id;
end;
$$;

grant execute on function public.captcha_scrape_job(uuid) to service_role;
revoke execute on function public.captcha_scrape_job(uuid) from anon, authenticated;


-- ------------------------------------------------------------
-- mark_scrape_job_captcha_terminal — soften the default p_error.
-- (Body identical to 20260519030000_hitl_short_ttl_and_requeue.sql
-- except for the coalesce default string.)
-- ------------------------------------------------------------
create or replace function public.mark_scrape_job_captcha_terminal(
  p_job_id uuid,
  p_error  text default null
) returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  update public.scrape_queue
  set status        = 'captcha',
      completed_at  = now(),
      claimed_by    = null,
      error_message = coalesce(
        p_error,
        'A captcha appeared and nobody was around to solve it. Click "Re-queue with HITL" on the Interactive page to try again.'
      ),
      updated_at    = now()
  where id = p_job_id
    and status in ('running', 'needs_human');

  delete from public.active_profile_locks where job_id = p_job_id;
end;
$$;

revoke execute on function public.mark_scrape_job_captcha_terminal(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_scrape_job_captcha_terminal(uuid, text) to service_role;
