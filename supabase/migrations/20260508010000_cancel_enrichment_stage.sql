-- Per-stage cancellation for enrichment jobs.
--
-- Motivation: S-tag extraction can take many minutes per lead because the
-- worker resolves up to 30 tracking redirects in a real Chromium session.
-- Once it's running, the operator currently has no way to abort — they
-- have to wait it out. This migration adds:
--
--   • cancel_requested column on enrichment_fetch_queue. Worker reads
--     this flag between tracking-link iterations and stops early.
--   • cancel_enrichment_stage(p_job_id, p_stage) RPC that flips pending
--     rows for that (scrape_job, stage) pair to status='cancelled' so the
--     worker won't claim them, and sets cancel_requested=true on rows
--     that are already 'running' so they can stop cooperatively.
--
-- Cancellation is per-stage, not per-job: an operator running 50 stag jobs
-- can cancel the stag stage without affecting in-flight contact extraction
-- on the same scrape.

alter table public.enrichment_fetch_queue
  add column if not exists cancel_requested boolean not null default false;

-- Optional: an index helps the worker's per-row cancel check stay cheap
-- if the queue table grows. The check is keyed by id so the existing PK
-- index is fine; we only index where the flag is set so the predicate
-- stays tight.
create index if not exists idx_enrichment_fetch_queue_cancel_flag
  on public.enrichment_fetch_queue (id)
  where cancel_requested;

-- ---------------------------------------------------------------------------
-- RPC: cancel_enrichment_stage
-- Mark every queued or in-flight enrichment row for (scrape_job, stage) as
-- cancelled.
--
--   • status='pending' → status='cancelled'   (worker won't claim it)
--   • status='running' → cancel_requested=true (worker stops cooperatively)
--
-- Stage matches the JSONB process_stages array via the `?` operator, so
-- callers pass the bare stage name (e.g. 'stag', 'contact', 'rooster',
-- 'affiliate'). 'rooster' does NOT match 'rooster_deep' rows — those have
-- a separate fallback path that finishes quickly anyway.
--
-- Returns: jsonb {cancelled_pending: int, flagged_running: int}.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_enrichment_stage(
  p_job_id uuid,
  p_stage text
) returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_cancelled_pending int := 0;
  v_flagged_running int := 0;
begin
  if p_job_id is null then
    raise exception 'job_id required' using errcode = '22023';
  end if;
  if length(coalesce(trim(p_stage), '')) = 0 then
    raise exception 'stage required' using errcode = '22023';
  end if;

  with cancelled as (
    update public.enrichment_fetch_queue q
       set status = 'cancelled',
           updated_at = now()
     where q.status in ('pending', 'paused')
       and q.process_stages ? p_stage
       and q.lead_id in (
         select id from public.google_lead_gen_table where scrape_job_id = p_job_id
       )
    returning 1
  )
  select count(*) into v_cancelled_pending from cancelled;

  with flagged as (
    update public.enrichment_fetch_queue q
       set cancel_requested = true,
           updated_at = now()
     where q.status = 'running'
       and q.cancel_requested = false
       and q.process_stages ? p_stage
       and q.lead_id in (
         select id from public.google_lead_gen_table where scrape_job_id = p_job_id
       )
    returning 1
  )
  select count(*) into v_flagged_running from flagged;

  return jsonb_build_object(
    'cancelled_pending', v_cancelled_pending,
    'flagged_running', v_flagged_running
  );
end;
$$;

grant execute on function public.cancel_enrichment_stage(uuid, text) to service_role;
revoke execute on function public.cancel_enrichment_stage(uuid, text) from anon, authenticated;
