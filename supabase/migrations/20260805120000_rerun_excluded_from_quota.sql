-- ============================================================
-- Re-runs must NOT consume the daily scrape quota.
--
-- Operators reported losing a whole day's allocation (e.g. "0/20 left")
-- when FAILED scrapes were re-run — either via the /scrape/[id] "Try
-- again" button or the gradual re-queue script. A re-run of a scrape that
-- failed for infra reasons (captcha, proxy, VM) is not the operator
-- spending fresh resource budget; it's recovering work that should have
-- completed. Counting it against their cap double-charges them.
--
-- Fix: mark every re-run row with is_rerun=true and exclude those rows
-- from count_user_scrapes_today. Genuinely NEW user-initiated scrapes
-- (is_rerun defaults to false) still count exactly as before. Enforcement
-- and the "X/20 left" badge both read this one RPC, so they stay in sync.
-- ============================================================

alter table public.scrape_queue
  add column if not exists is_rerun boolean not null default false;

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
    -- kick/youtube phase-2 enrichment children don't count (as before).
    and parent_scrape_job_id is null
    -- re-runs of prior scrapes don't count — they recover failed work,
    -- they aren't fresh operator-initiated scrapes.
    and coalesce(is_rerun, false) = false
$$;

grant execute on function public.count_user_scrapes_today(text) to service_role, authenticated;
