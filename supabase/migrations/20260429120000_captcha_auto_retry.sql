-- ============================================================
-- Migration: Auto-retry on CAPTCHA up to 10 attempts
--
-- GoLogin rotates the residential proxy IP every time a profile
-- starts a fresh session, so a captcha hit on attempt N often
-- isn't reproducible on attempt N+1. Currently captcha_scrape_job
-- marks the row terminal, requiring a manual click. This auto-
-- retries up to 10 times silently, then surfaces it for user
-- intervention.
--
-- Behaviour:
--   - On every captcha hit, captcha_attempts increments.
--   - If captcha_attempts < 10: status flips back to 'pending' so
--     workers re-claim and try again. `attempts` resets to 0 so
--     the regular retry-cap (3) doesn't preempt this.
--   - If captcha_attempts >= 10: status stays 'captcha' (terminal)
--     and the kebab modal lets the user reset and try again.
-- ============================================================

alter table public.scrape_queue
  add column if not exists captcha_attempts integer not null default 0;

-- ------------------------------------------------------------
-- captcha_scrape_job — auto-retry up to MAX_CAPTCHA_ATTEMPTS
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
    -- Auto-retry path. Reset general `attempts` so claim_scrape_job
    -- doesn't bounce off its max-attempts filter, and clear the
    -- claimed_by/started_at so the row presents as fresh-pending.
    update public.scrape_queue
    set status            = 'pending',
        captcha_attempts  = v_attempts,
        attempts          = 0,
        claimed_by        = null,
        started_at        = null,
        completed_at      = null,
        error_message     = format(
          'Captcha hit; auto-retrying (%s of %s). The proxy IP rotates per session.',
          v_attempts, v_max_captcha
        ),
        updated_at        = now()
    where id = p_job_id;
  else
    -- Cap reached. Stay in captcha state until the user resets.
    update public.scrape_queue
    set status            = 'captcha',
        captcha_attempts  = v_attempts,
        completed_at      = now(),
        error_message     = format(
          'Captcha hit %s times — manual retry required.',
          v_attempts
        ),
        updated_at        = now()
    where id = p_job_id;
  end if;

  -- Always free the country lock so the next claim attempt (whether
  -- this row or a sibling) can grab the profile.
  delete from public.active_profile_locks where job_id = p_job_id;
end;
$$;

grant execute on function public.captcha_scrape_job(uuid) to service_role;
revoke execute on function public.captcha_scrape_job(uuid) from anon, authenticated;

-- ------------------------------------------------------------
-- reset_captcha_retries — used by the "Try again" button in the
-- kebab modal once a job has hit the 10-attempt cap.
-- ------------------------------------------------------------
create or replace function public.reset_captcha_retries(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  update public.scrape_queue
  set status            = 'pending',
      captcha_attempts  = 0,
      attempts          = 0,
      claimed_by        = null,
      started_at        = null,
      completed_at      = null,
      error_message     = null,
      updated_at        = now()
  where id = p_job_id
    and status = 'captcha'
  returning status into v_status;
  return coalesce(v_status, 'no-op');
end;
$$;

grant execute on function public.reset_captcha_retries(uuid) to service_role;
revoke execute on function public.reset_captcha_retries(uuid) from anon, authenticated;
