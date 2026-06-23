-- ============================================================
-- Per-user daily scrape quota.
--
-- Operators reported runaway batches eating proxy bandwidth and
-- enrichment-VM capacity, so we cap each non-admin user at N
-- scrape-queue rows per UTC day (default 20). Admins are exempt
-- (they're the safety valve for backfills).
--
-- system_settings:
--   daily_scrape_cap_per_user (int, default 20)
--     Set to 0 to disable the cap entirely.
--
-- RPC count_user_scrapes_today(p_user_id, p_email):
--   Returns the number of scrape_queue rows the user created
--   between UTC midnight and now. Uses created_by_email since
--   that's the column denormalized at insert time + indexed.
--
-- Caller predicate: a user's "today" count includes everything
-- they queued (pending / running / completed / failed / paused /
-- cancelled) — the cap is about pacing the OPERATOR'S use of
-- shared scraping resources, not the success rate of past jobs.
-- ============================================================

insert into public.system_settings (key, value)
values ('daily_scrape_cap_per_user', '20'::jsonb)
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- RPC: count_user_scrapes_today
-- Counts scrape_queue rows the given user created since UTC
-- midnight. Email match is case-insensitive on the application
-- side (we normalize to lowercase at insert + here).
-- ------------------------------------------------------------
create or replace function public.count_user_scrapes_today(
  p_email text
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.scrape_queue
  where lower(coalesce(created_by_email, '')) = lower(coalesce(p_email, ''))
    and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'
    -- Re-runs from /scrape/[id] copy the source row's created_by_email
    -- so they count too. parent_scrape_job_id is set for kick-phase-2
    -- children — exclude those since they're operator-triggered
    -- second-pass enrichments, not "new scrapes".
    and parent_scrape_job_id is null
$$;

grant execute on function public.count_user_scrapes_today(text) to service_role, authenticated;
