-- ============================================================
-- Rename the "HITL" label inside the default error_message of
-- mark_scrape_job_captcha_terminal to match the user-facing
-- "Captcha helper" name used across the admin UI (Phase 1 of the
-- 2026-05-21 wording pass). The 2026-05-28 rename migration
-- supersedes this again with "Captcha solver".
--
-- Body is otherwise identical to
-- 20260522020000_friendly_rpc_error_messages.sql — only the
-- coalesce-default string is rewritten. Pre-existing scrape_queue
-- rows are not rewritten (consistent with prior wording passes).
-- ============================================================

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
        'A captcha appeared and nobody was around to solve it. Click "Re-queue with Captcha helper" on the Interactive page to try again.'
      ),
      updated_at    = now()
  where id = p_job_id
    and status in ('running', 'needs_human');

  delete from public.active_profile_locks where job_id = p_job_id;
end;
$$;

revoke execute on function public.mark_scrape_job_captcha_terminal(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_scrape_job_captcha_terminal(uuid, text) to service_role;
