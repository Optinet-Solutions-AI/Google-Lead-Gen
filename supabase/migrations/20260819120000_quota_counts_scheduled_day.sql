-- ============================================================
-- A scrape scheduled for a FUTURE day counts against that day, not today.
--
-- Charisse hit today's cap, then couldn't schedule scrapes for tomorrow — the
-- quota gate charged the scheduled-for-tomorrow rows to TODAY (it counted by
-- created_at, when the row was queued). A job that RUNS tomorrow should cost
-- tomorrow's quota, not today's.
--
-- Fix: count by the EFFECTIVE run day — coalesce(scheduled_at, created_at) —
-- bounded to the current UTC day. Immediate scrapes (scheduled_at null) are
-- unchanged (coalesce = created_at = today). A scheduled-for-tomorrow scrape now
-- lands in tomorrow's count, so it can be queued even when today is full. The
-- enqueue action separately skips the today-check for future-scheduled submits.
-- ============================================================

create or replace function public.count_user_scrapes_today(p_email text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(distinct (lower(keyword), country_code))::int
  from public.scrape_queue
  where lower(coalesce(created_by_email, '')) = lower(coalesce(p_email, ''))
    and coalesce(scheduled_at, created_at)
          >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
    and coalesce(scheduled_at, created_at)
          <  (date_trunc('day', now() at time zone 'UTC') + interval '1 day') at time zone 'UTC'
    and parent_scrape_job_id is null
    and coalesce(is_rerun, false) = false
$$;
grant execute on function public.count_user_scrapes_today(text) to service_role, authenticated;
