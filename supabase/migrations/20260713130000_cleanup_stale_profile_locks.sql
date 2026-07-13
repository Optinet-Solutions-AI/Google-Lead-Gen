-- ============================================================
-- Auto-cleanup of active_profile_locks when the owning job goes.
--
-- Bug observed 2026-07-13: 4 stale rows in active_profile_locks
-- pointing to scrape_queue jobs that no longer existed — three of
-- them for Italy, which pinned the country at the 3-slot cap
-- (max_concurrent_per_country) and blocked every subsequent IT
-- scrape from being claimed. VMs looked idle; queue looked stuck.
--
-- Root cause: 20260424320000_enrichment_fetch_queue.sql dropped
-- the FK active_profile_locks.job_id → scrape_queue.id when the
-- lock table was extended to hold enrichment jobs too. Since then,
-- deleting a scrape_queue row does NOT auto-cascade to
-- active_profile_locks. The delete_scrape_job_cascade RPC handles
-- it explicitly (line 109 of 20260429030000_pause_cancel_delete.sql),
-- but any other delete path — hand SQL, an admin panel wipe, a
-- migration cleanup — leaves the lock behind.
--
-- Fix: AFTER DELETE triggers on scrape_queue and enrichment_fetch_queue
-- that remove the matching lock row. Scoped by job_kind so a
-- (theoretical) UUID collision between the two job systems can't
-- delete the wrong lock. This makes the cleanup unconditional —
-- every delete path is safe, no matter which code opens it.
--
-- One-shot cleanup at the bottom removes any stale locks already
-- sitting in the table when this migration applies, so we don't
-- need a manual script to unwedge existing stuck countries.
-- ============================================================

create or replace function public.cleanup_locks_on_scrape_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.active_profile_locks
  where job_id = OLD.id
    and job_kind = 'scrape';
  return OLD;
end;
$$;

drop trigger if exists trg_cleanup_locks_on_scrape_delete
  on public.scrape_queue;
create trigger trg_cleanup_locks_on_scrape_delete
  after delete on public.scrape_queue
  for each row
  execute function public.cleanup_locks_on_scrape_delete();


create or replace function public.cleanup_locks_on_enrichment_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.active_profile_locks
  where job_id = OLD.id
    and job_kind = 'enrichment';
  return OLD;
end;
$$;

drop trigger if exists trg_cleanup_locks_on_enrichment_delete
  on public.enrichment_fetch_queue;
create trigger trg_cleanup_locks_on_enrichment_delete
  after delete on public.enrichment_fetch_queue
  for each row
  execute function public.cleanup_locks_on_enrichment_delete();


-- ------------------------------------------------------------
-- One-shot: remove any stale locks already in the table when
-- this migration applies. Delete rows whose job_id doesn't map
-- to a row in the source table matching the lock's job_kind.
-- ------------------------------------------------------------
with orphans as (
  select l.job_id, l.job_kind
  from public.active_profile_locks l
  where (l.job_kind = 'scrape'
         and not exists (select 1 from public.scrape_queue s where s.id = l.job_id))
     or (l.job_kind = 'enrichment'
         and not exists (select 1 from public.enrichment_fetch_queue e where e.id = l.job_id))
)
delete from public.active_profile_locks l
using orphans o
where l.job_id = o.job_id
  and l.job_kind = o.job_kind;
