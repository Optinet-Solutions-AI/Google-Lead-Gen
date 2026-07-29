-- ============================================================
-- Auto-cancel orphaned interactive checkpoints.
--
-- Bug (2026-07-28): checkpoints were left status='waiting' after their
-- scrape job had already terminated (completed / failed / cancelled).
-- These "zombies" cluttered the /admin/interactive queue and appeared
-- to operators as captchas that "keep coming back" — solving them did
-- nothing because there was no live scrape behind them. One morning's
-- backlog reached 35 zombie checkpoints.
--
-- Root cause: nothing closed a waiting checkpoint when its job ended
-- via a path other than an explicit operator resolve (worker gave up,
-- stale-lock reaper failed the job, job completed after a late refresh,
-- etc.). The stale-lock reaper handled locks but not checkpoints.
--
-- Fix: a cheap idempotent sweep that cancels any waiting checkpoint
-- whose job is already terminal. Invoked every minute from
-- /api/scheduler/tick (Vercel cron). Safe — it only ever touches
-- checkpoints whose job is completed/failed/cancelled, so no live
-- human-in-the-loop work is affected.
-- ============================================================

create or replace function public.cancel_orphaned_interactive_checkpoints()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with orphaned as (
    select c.id
    from public.interactive_checkpoints c
    join public.scrape_queue q on q.id = c.job_id
    where c.status = 'waiting'
      and q.status in ('completed', 'failed', 'cancelled')
  )
  update public.interactive_checkpoints c
  set status          = 'cancelled',
      resolved_at     = now(),
      resolved_by     = 'auto-reaper',
      resolution_note = 'auto-closed: underlying scrape already finished (orphaned checkpoint sweep)'
  from orphaned o
  where c.id = o.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.cancel_orphaned_interactive_checkpoints() to service_role;
revoke execute on function public.cancel_orphaned_interactive_checkpoints() from anon, authenticated;
