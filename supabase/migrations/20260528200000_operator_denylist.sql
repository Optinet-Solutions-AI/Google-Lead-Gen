-- ============================================================
-- Migration: Operator denylist — auto-flag casino-operator domains
-- as is_not_relevant so they get skipped by enrichment and hidden
-- from /leads + /scrape/[id] by default.
--
-- Triggered after Darren reported batch 736 surfacing operator
-- brand pages (wildz, casumo, spinpalace, royalpanda, leovegas…)
-- as "leads". The affiliate scorer in lib/affiliate-detection/
-- catches some operators via login/deposit counter-signals but
-- leaks both ways — it falsely tags leovegas/royalpanda as
-- is_affiliate=true and never even ran on half the batch 736
-- rows. This denylist is a deterministic safety net.
--
-- Reuses the existing is_not_relevant column (sources: Monday
-- not_relevant board match, user manual flag). New source value:
-- 'operator_denylist'. Same UI toggle (?show_hidden=1) flips them
-- back into view.
--
-- Re-emits advance_enrichment_chain to inject the new flagger
-- right after mark_monday_duplicates_for_job. Base shape matches
-- 20260505040000_chain_stops_at_rooster.sql — keep both in sync
-- if the chain shape changes again.
-- ============================================================

-- ------------------------------------------------------------
-- 1. operator_domains_denylist — host suffixes to auto-flag.
-- ------------------------------------------------------------
create table if not exists public.operator_domains_denylist (
  host_suffix text        primary key,
  added_at    timestamptz not null default now(),
  added_by    text        not null default 'seed',
  note        text
);

alter table public.operator_domains_denylist enable row level security;

-- Seed list: casino operators surfaced in Darren's batch 736 +
-- recurring noise in the last 15 batches. Bare host suffixes —
-- the matcher prepends `//` and `.` so subdomain variants match
-- without false-hitting unrelated hosts (e.g. `casino.com`
-- shouldn't match `casino.guru`).
insert into public.operator_domains_denylist (host_suffix, note) values
  ('wildz.com',                'NZ batch 736'),
  ('spinpalace.com',           'NZ batch 736'),
  ('casumo.com',               'NZ batch 736'),
  ('luckynuggetcasino.com',    'NZ batch 736'),
  ('royalpanda.com',           'NZ batch 736 — scorer false-positive (is_affiliate=true)'),
  ('leovegas.com',             'NZ batch 736 — scorer false-positive (is_affiliate=true)'),
  ('skycitycasino.com',        'NZ batch 736'),
  ('betvictor.com',            'NZ batch 736'),
  ('jackpotcitycasino.com',    'NZ batch 736'),
  ('spincasino.com',           'NZ batch 736'),
  ('christchurchcasino.com',   'NZ batch 736'),
  ('christchurchcasino.co.nz', 'NZ batch 736'),
  ('888casino.com',            'recurring noise'),
  ('888casino.it',             'recurring noise — scorer false-positive'),
  ('betway.com',               'recurring noise'),
  ('betway.de',                'recurring noise — scorer false-positive'),
  ('bwin.com',                 'recurring noise'),
  ('bwin.de',                  'recurring noise'),
  ('tipico.com',               'recurring noise'),
  ('tipico.de',                'recurring noise'),
  ('williamhill.com',          'recurring noise'),
  ('williamhill.it',           'recurring noise'),
  ('unibet.com',               'recurring noise'),
  ('mrgreen.com',              'recurring noise'),
  ('bet365.com',               'recurring noise'),
  ('pokerstars.com',           'recurring noise')
on conflict (host_suffix) do nothing;

-- ------------------------------------------------------------
-- 2. flag_operator_denylist_for_job — set is_not_relevant=true
-- for any row in p_job_id whose domain matches the denylist.
-- Idempotent: never unsets an existing manual flag, never
-- overwrites the marker if a row is already not-relevant.
-- ------------------------------------------------------------
create or replace function public.flag_operator_denylist_for_job(p_job_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with matched as (
    select g.id
    from public.google_lead_gen_table g
    join public.operator_domains_denylist d
      on lower(g.domain) like '%//' || d.host_suffix
      or lower(g.domain) like '%.' || d.host_suffix
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
  ),
  upd as (
    update public.google_lead_gen_table g
    set is_not_relevant         = true,
        not_relevant_marked_at  = coalesce(g.not_relevant_marked_at, now()),
        not_relevant_marked_by  = coalesce(g.not_relevant_marked_by, 'operator_denylist')
    from matched m
    where g.id = m.id
    returning 1
  )
  select count(*)::integer into v_count from upd;
  return coalesce(v_count, 0);
end;
$$;

grant execute on function public.flag_operator_denylist_for_job(uuid) to service_role;
revoke execute on function public.flag_operator_denylist_for_job(uuid) from anon, authenticated;

-- ------------------------------------------------------------
-- 3. advance_enrichment_chain — call the new flagger right after
-- the Monday duplicate check, so operator rows are excluded from
-- every subsequent enrichment INSERT.
--
-- Base shape: 20260505040000_chain_stops_at_rooster.sql
-- (Phase 0+1 → affiliate_running → rooster_running → complete).
-- Only the Phase 0+1 block changes; rest is unchanged.
-- ------------------------------------------------------------
create or replace function public.advance_enrichment_chain(p_job_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_job             public.scrape_queue;
  v_total           integer;
  v_aff_blocked     integer;
  v_rooster_blocked integer;
  v_now             timestamptz := now();
begin
  select * into v_job from public.scrape_queue where id = p_job_id;
  if v_job.id is null then return null; end if;
  if not v_job.with_enrichment then return v_job.enrichment_status; end if;
  if v_job.status <> 'completed' then return v_job.enrichment_status; end if;
  if v_job.enrichment_status = 'complete' then return 'complete'; end if;

  select count(*) into v_total
  from public.google_lead_gen_table
  where scrape_job_id = p_job_id
    and is_not_relevant = false;

  if v_total = 0 then
    update public.scrape_queue
    set enrichment_status = 'complete', enrichment_completed_at = v_now
    where id = p_job_id;
    return 'complete';
  end if;

  -- ----- Phase 0+1 -----
  if v_job.enrichment_status is null or v_job.enrichment_status = 'pending' then
    perform public.mark_monday_duplicates_for_job(p_job_id);
    -- Operator denylist runs right after the Monday check so its
    -- is_not_relevant flag gates the same downstream INSERTs.
    perform public.flag_operator_denylist_for_job(p_job_id);

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true,
           (g.result_type = 'PPC'),
           '["affiliate"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_affiliate_overridden_at is null;

    update public.scrape_queue
    set enrichment_status      = 'affiliate_running',
        enrichment_started_at  = coalesce(enrichment_started_at, v_now)
    where id = p_job_id;
    return 'affiliate_running';
  end if;

  -- ----- Phase 2: wait for affiliate, enqueue rooster -----
  if v_job.enrichment_status = 'affiliate_running' then
    select count(*) into v_aff_blocked
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.is_affiliate_overridden_at is null
      and g.affiliate_checked_at is null
      and exists (
        select 1 from public.enrichment_fetch_queue q
        where q.lead_id = g.id
          and q.process_stages @> '["affiliate"]'::jsonb
          and q.status in ('pending', 'running', 'paused')
      );

    if v_aff_blocked > 0 then
      return 'affiliate_running';
    end if;

    insert into public.enrichment_fetch_queue (
      lead_id, country_code, url, want_html, want_screenshot, process_stages
    )
    select g.id, g.country_code, g.url, true, false, '["rooster"]'::jsonb
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.url is not null and g.url like 'http%'
      and g.country_code is not null
      and g.is_rooster_overridden_at is null;

    update public.scrape_queue
    set enrichment_status = 'rooster_running'
    where id = p_job_id;
    return 'rooster_running';
  end if;

  -- ----- Phase 3: wait for rooster, then complete -----
  -- Also catches legacy 'all_running' / 'contact_running' statuses
  -- from before the chain shrank: we only wait on rooster now.
  if v_job.enrichment_status in ('rooster_running', 'all_running', 'contact_running') then
    select count(*) into v_rooster_blocked
    from public.google_lead_gen_table g
    where g.scrape_job_id = p_job_id
      and g.is_not_relevant = false
      and g.is_rooster_overridden_at is null
      and g.rooster_checked_at is null
      and exists (
        select 1 from public.enrichment_fetch_queue q
        where q.lead_id = g.id
          and q.process_stages @> '["rooster"]'::jsonb
          and q.status in ('pending', 'running', 'paused')
      );

    if v_rooster_blocked > 0 then
      return v_job.enrichment_status;
    end if;

    update public.scrape_queue
    set enrichment_status = 'complete', enrichment_completed_at = v_now
    where id = p_job_id;
    return 'complete';
  end if;

  return v_job.enrichment_status;
end;
$$;

grant execute on function public.advance_enrichment_chain(uuid) to service_role;
revoke execute on function public.advance_enrichment_chain(uuid) from anon, authenticated;

-- ------------------------------------------------------------
-- 4. Backfill — apply the denylist to every existing row in
-- google_lead_gen_table. Mirrors the function logic but
-- unscoped by job, so historical batches (including 736) get
-- cleaned in one pass.
-- ------------------------------------------------------------
with matched as (
  select g.id
  from public.google_lead_gen_table g
  join public.operator_domains_denylist d
    on lower(g.domain) like '%//' || d.host_suffix
    or lower(g.domain) like '%.' || d.host_suffix
  where g.is_not_relevant = false
)
update public.google_lead_gen_table g
set is_not_relevant        = true,
    not_relevant_marked_at = coalesce(g.not_relevant_marked_at, now()),
    not_relevant_marked_by = coalesce(g.not_relevant_marked_by, 'operator_denylist')
from matched m
where g.id = m.id;

-- ------------------------------------------------------------
-- 5. Cancel any in-flight enrichment-fetch-queue rows for leads
-- that just got auto-flagged. Mirrors the post-backfill cleanup
-- from 20260505010000_lead_not_relevant_filter.sql so workers
-- don't keep processing operator rows already in their queue.
-- ------------------------------------------------------------
update public.enrichment_fetch_queue q
set status = 'cancelled', updated_at = now()
where q.status in ('pending', 'paused')
  and exists (
    select 1 from public.google_lead_gen_table g
    where g.id = q.lead_id
      and g.is_not_relevant = true
      and g.not_relevant_marked_by = 'operator_denylist'
  );
