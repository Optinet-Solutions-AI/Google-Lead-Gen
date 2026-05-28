-- ============================================================
-- Migration: complete_enrichment_fetch_job honors retry semantics
-- on fetch errors.
--
-- Bug discovered while diagnosing batch 736: 27 enrichment-fetch
-- queue rows were marked `status='failed'` after exactly 1 attempt
-- even though max_attempts=3. Worker errors were dominated by
-- transient infra hiccups — "cannot connect to chrome at 127.0.0.1:
-- 9226" (Selenium session crash), "[Errno 2] No such file or
-- directory: '/tmp/gologin_…/orbita.config'" (GoLogin profile
-- init race), "navigation failed on homepage" — all of which
-- should have retried.
--
-- Root cause: complete_enrichment_fetch_job (called by the worker
-- to report BOTH success and fetch errors) unconditionally set
-- status='failed' when p_fetch_error was non-null. Only
-- fail_enrichment_fetch_job (used in the worker's outer Python
-- `except` clause) honored attempts < max_attempts. The two paths
-- treated failure differently for no good reason.
--
-- Fix: complete_enrichment_fetch_job now applies the same retry
-- logic as fail_enrichment_fetch_job — if attempts < max_attempts,
-- re-pend the row so a worker picks it up again. Permanent errors
-- (config issues, cancellations) still cost 2 extra attempts, but
-- that's <0.1% of traffic vs the data-quality win on transient
-- errors. The fetched_html_cache row still gets written on each
-- attempt (on-conflict overwrite), so the last error message wins.
--
-- Cancel-by-operator is a special case: those rows should not
-- retry. Detect via the literal "cancelled by operator" sentinel
-- the worker passes (vm/enrichment_worker.py line ~902).
-- ============================================================

create or replace function public.complete_enrichment_fetch_job(
  p_job_id          uuid,
  p_html            text default null,
  p_screenshot_path text default null,
  p_fetch_error     text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job      public.enrichment_fetch_queue;
  v_attempts integer;
  v_max      integer;
  v_retry    boolean;
begin
  select * into v_job from public.enrichment_fetch_queue where id = p_job_id;
  if v_job.id is null then
    raise exception 'enrichment_fetch_queue row % not found', p_job_id;
  end if;

  v_attempts := v_job.attempts;
  v_max      := v_job.max_attempts;
  -- Retry only when there's a fetch error, attempts are left, and
  -- the error isn't the operator-cancel sentinel from the worker.
  v_retry := p_fetch_error is not null
             and v_attempts < v_max
             and coalesce(p_fetch_error, '') <> 'cancelled by operator';

  -- Cache write happens on every attempt — on-conflict overwrites
  -- with the latest error or html. Last writer wins.
  insert into public.fetched_html_cache (lead_id, url, html, fetched_at, fetch_error)
  values (v_job.lead_id, v_job.url, p_html, now(), p_fetch_error)
  on conflict (lead_id) do update
  set url         = excluded.url,
      html        = excluded.html,
      fetched_at  = excluded.fetched_at,
      fetch_error = excluded.fetch_error;

  if p_screenshot_path is not null then
    update public.google_lead_gen_table
    set screenshot_content_link = p_screenshot_path,
        screenshot_view_link    = p_screenshot_path
    where id = v_job.lead_id;
  end if;

  update public.enrichment_fetch_queue
  set status        = case
                        when p_fetch_error is null then 'completed'
                        when v_retry              then 'pending'
                        else                            'failed'
                      end,
      claimed_by    = case when v_retry then null else claimed_by end,
      started_at    = case when v_retry then null else started_at end,
      completed_at  = case when p_fetch_error is null then now() else completed_at end,
      error_message = p_fetch_error,
      updated_at    = now()
  where id = p_job_id;

  -- Always release the country lock — the next attempt (if any)
  -- needs to re-claim the country profile from scratch, same as
  -- fail_enrichment_fetch_job.
  delete from public.active_profile_locks where job_id = p_job_id;
end;
$$;

grant execute on function public.complete_enrichment_fetch_job(uuid, text, text, text) to service_role;
revoke execute on function public.complete_enrichment_fetch_job(uuid, text, text, text) from anon, authenticated;
