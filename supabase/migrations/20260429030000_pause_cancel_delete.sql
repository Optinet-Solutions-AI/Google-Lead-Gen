-- ============================================================
-- Migration: Pause / Cancel / Delete for scrape jobs + leads
--
-- Adds:
--   1. New status values on scrape_queue + enrichment_fetch_queue
--      ('paused', 'cancelled') so workers naturally skip them
--      (claim_*_job already filters by status='pending').
--   2. cancel_scrape_job(uuid)        — flips one job + its pending
--                                       enrichment rows to cancelled.
--   3. delete_scrape_job_cascade(uuid) — wipes the queue row, all
--                                       leads scraped under it, their
--                                       enrichment / s-tag / cache rows,
--                                       and any stuck profile lock.
--   4. delete_leads_cascade(bigint[]) — same for an arbitrary set of
--                                       leads (used by the bulk-select
--                                       UI on /leads).
--
-- Pause / resume are simple status flips (pending<->paused) and run as
-- direct updates from the server actions; no RPC needed.
--
-- Cascading deletes already exist for s_tags_table, enrichment_fetch_queue,
-- and fetched_html_cache (FK ON DELETE CASCADE → google_lead_gen_table.id),
-- so deleting the leads is enough — the rest fall away with them.
-- google_lead_gen_table.scrape_job_id is ON DELETE SET NULL, so we delete
-- the leads explicitly inside the RPC instead of relying on cascade.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Loosen the status CHECK constraints
-- ------------------------------------------------------------
alter table public.scrape_queue
  drop constraint if exists scrape_queue_status_check;
alter table public.scrape_queue
  add constraint scrape_queue_status_check
    check (status in ('pending', 'running', 'completed', 'failed', 'captcha', 'paused', 'cancelled'));

alter table public.enrichment_fetch_queue
  drop constraint if exists enrichment_fetch_queue_status_check;
alter table public.enrichment_fetch_queue
  add constraint enrichment_fetch_queue_status_check
    check (status in ('pending', 'running', 'completed', 'failed', 'paused', 'cancelled'));

-- ------------------------------------------------------------
-- 2. cancel_scrape_job — atomic scrape + enrichment cancel
--
-- Behaviour:
--   * pending   → cancelled (worker won't claim it)
--   * paused    → cancelled
--   * captcha   → cancelled
--   * failed    → cancelled
--   * running   → cancelled (the worker finishes naturally; the lock
--                 release happens via complete/fail RPCs, so this is
--                 a "soft" cancel — the row is marked but the in-flight
--                 work isn't aborted mid-page)
--   * completed → no-op (already done; use delete instead)
-- Also flips every pending/paused/running enrichment row whose lead
-- belongs to this job to cancelled.
-- ------------------------------------------------------------
create or replace function public.cancel_scrape_job(p_job_id uuid)
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
  set status = 'cancelled', updated_at = now()
  where id = p_job_id
    and status in ('pending', 'paused', 'running', 'failed', 'captcha')
  returning status into v_status;

  -- Cancel any pending/paused enrichment work for this job's leads.
  update public.enrichment_fetch_queue q
  set status = 'cancelled', updated_at = now()
  where q.status in ('pending', 'paused')
    and q.lead_id in (
      select id from public.google_lead_gen_table
      where scrape_job_id = p_job_id
    );

  return coalesce(v_status, 'no-op');
end;
$$;

grant execute on function public.cancel_scrape_job(uuid) to service_role;
revoke execute on function public.cancel_scrape_job(uuid) from anon, authenticated;

-- ------------------------------------------------------------
-- 3. delete_scrape_job_cascade — irreversible wipe
--
-- Returns the number of leads that were deleted, for activity-log detail.
-- Caller is responsible for removing screenshot files from Storage
-- before invoking this (since RPCs can't reach the storage bucket).
-- ------------------------------------------------------------
create or replace function public.delete_scrape_job_cascade(p_job_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_lead_count integer := 0;
begin
  -- Free the country lock first (defensive — usually already gone).
  delete from public.active_profile_locks where job_id = p_job_id;

  -- Delete leads (cascades to s_tags_table, enrichment_fetch_queue,
  -- and fetched_html_cache via existing FK ON DELETE CASCADE).
  with deleted as (
    delete from public.google_lead_gen_table
    where scrape_job_id = p_job_id
    returning 1
  )
  select count(*) into v_lead_count from deleted;

  -- Finally, the queue row itself.
  delete from public.scrape_queue where id = p_job_id;

  return v_lead_count;
end;
$$;

grant execute on function public.delete_scrape_job_cascade(uuid) to service_role;
revoke execute on function public.delete_scrape_job_cascade(uuid) from anon, authenticated;

-- ------------------------------------------------------------
-- 4. delete_leads_cascade — bulk-select wipe of arbitrary leads
-- ------------------------------------------------------------
create or replace function public.delete_leads_cascade(p_lead_ids bigint[])
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
begin
  if p_lead_ids is null or array_length(p_lead_ids, 1) is null then
    return 0;
  end if;

  with deleted as (
    delete from public.google_lead_gen_table
    where id = any(p_lead_ids)
    returning 1
  )
  select count(*) into v_count from deleted;

  return v_count;
end;
$$;

grant execute on function public.delete_leads_cascade(bigint[]) to service_role;
revoke execute on function public.delete_leads_cascade(bigint[]) from anon, authenticated;
