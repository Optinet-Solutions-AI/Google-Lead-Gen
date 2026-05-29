-- ============================================================
-- Extend shadow isolation to enrichment_fetch_queue + dashboard.
--
-- The Overview page (/) was the only surface left where Meny's
-- counters bled into everyone else's. KPIs counted his leads,
-- "Pending enrichment" included his queue rows, the worker grid
-- showed his country/keyword when one of his scrapes was live.
--
-- This migration denormalises the shadow flag + creator email
-- onto enrichment_fetch_queue so the dashboard count queries
-- can filter without expensive joins. A trigger keeps the
-- columns in lockstep with the parent lead row on insert.
-- ============================================================

alter table public.enrichment_fetch_queue
  add column if not exists created_by_is_shadow boolean not null default false,
  add column if not exists created_by_email     text;

create index if not exists idx_enrichment_queue_created_by_is_shadow
  on public.enrichment_fetch_queue (created_by_is_shadow)
  where created_by_is_shadow = true;

create index if not exists idx_enrichment_queue_created_by_email
  on public.enrichment_fetch_queue (created_by_email)
  where created_by_email is not null;

-- Backfill existing enrichment jobs from their parent lead rows
-- (which themselves were backfilled in the previous migration from
-- scrape_queue). Safe to re-run.
update public.enrichment_fetch_queue e
set created_by_email     = l.created_by_email,
    created_by_is_shadow = coalesce(l.created_by_is_shadow, false)
from public.google_lead_gen_table l
where e.lead_id = l.id
  and (e.created_by_email is null or e.created_by_is_shadow <> coalesce(l.created_by_is_shadow, false));

-- ------------------------------------------------------------
-- Trigger: stamp the shadow flag + email on every new enrichment
-- row from the parent lead. The enrichment chain enqueues rows
-- from several call sites (advance_enrichment_chain RPC, n8n
-- webhooks, scripts) so a row-level BEFORE INSERT trigger is the
-- single point that guarantees the columns stay denormalised.
-- ------------------------------------------------------------
create or replace function public.stamp_enrichment_shadow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead public.google_lead_gen_table;
begin
  if new.lead_id is null then
    return new;
  end if;

  -- Caller can already set these explicitly (e.g. backfill); only
  -- fill when blank so we don't override an authoritative value.
  if new.created_by_is_shadow is not null and new.created_by_email is not null then
    return new;
  end if;

  select * into v_lead
  from public.google_lead_gen_table
  where id = new.lead_id;

  if found then
    new.created_by_is_shadow := coalesce(new.created_by_is_shadow, v_lead.created_by_is_shadow, false);
    new.created_by_email     := coalesce(new.created_by_email,     v_lead.created_by_email);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_stamp_enrichment_shadow on public.enrichment_fetch_queue;
create trigger trg_stamp_enrichment_shadow
  before insert on public.enrichment_fetch_queue
  for each row execute function public.stamp_enrichment_shadow();
