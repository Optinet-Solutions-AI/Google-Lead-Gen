-- ============================================================
-- Per-user "available for CAPTCHA review" toggle.
--
-- The captcha-solver flow currently parks a scrape in needs_human
-- and waits up to 65 minutes for an admin to click through on
-- /admin/interactive. If nobody is around, the worker eventually
-- gives up with "Scrape took too long (65 min) and was stopped."
--
-- This toggle adds a finer-grained gate per user: when the job's
-- owner is NOT available for CAPTCHA review, the worker skips the
-- needs_human checkpoint entirely and either goes straight to the
-- 2Captcha auto-solver (when captcha_auto_solve = ON) or fails
-- fast (status='captcha'). Either path is preferable to a 65-min
-- silent wait.
--
-- Defaults OFF so nothing changes for users who don't opt in.
--   user_profiles.available_for_captcha_review  bool, default false
--
-- The worker reads availability via captcha_review_available_for_job
-- which resolves the job's created_by_email to a user_profiles row.
-- Returns true ONLY when the user explicitly opted in. Anonymous /
-- legacy jobs (no created_by_email) resolve to false so they don't
-- sit waiting either.
-- ============================================================

alter table public.user_profiles
  add column if not exists available_for_captcha_review boolean not null default false;

create or replace function public.captcha_review_available_for_job(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(
    (
      select up.available_for_captcha_review
      from public.scrape_queue sq
      join auth.users u
        on lower(u.email) = lower(sq.created_by_email)
      join public.user_profiles up
        on up.id = u.id
      where sq.id = p_job_id
      limit 1
    ),
    false
  );
$$;

grant execute on function public.captcha_review_available_for_job(uuid) to service_role;
revoke execute on function public.captcha_review_available_for_job(uuid) from anon, authenticated;
