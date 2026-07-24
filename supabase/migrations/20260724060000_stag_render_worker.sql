-- ============================================================
-- Stag render worker infrastructure.
--
-- The v2 audit found 26.5% of failed extractions were "FETCH_EMPTY" —
-- html body < 500 bytes because the site is an SPA that needed JS to
-- render. vm/stag_render_worker.py loads each URL in a real GoLogin
-- Chromium session and writes the post-JS HTML back to
-- fetched_html_cache so the standard extraction pipeline can find the
-- tag on re-run.
--
-- This migration adds:
--   1. Claim columns on fetched_html_cache so multiple render workers
--      can atomically pick up work without stepping on each other.
--   2. claim_stag_render_batch(worker_id, batch_size, country_code)
--      RPC that returns the next N leads whose cached HTML is empty
--      AND hasn't been rendered by Playwright yet.
--   3. release_stale_render_claims() cleanup for orphaned claims.
--
-- Non-invasive — no worker restart needed for existing scrape /
-- enrichment workers. Only vm/stag_render_worker.py talks to this.
-- ============================================================

alter table public.fetched_html_cache
  add column if not exists render_claimed_by  text,
  add column if not exists render_claimed_at  timestamptz,
  add column if not exists render_completed_at timestamptz;

-- Index for the claim scan — most predicates are on html length +
-- source + render_claimed_at, so index render_claimed_at where it's
-- currently unclaimed (partial index keeps it tiny).
create index if not exists fetched_html_cache_render_pending_idx
  on public.fetched_html_cache (fetched_at desc)
  where render_claimed_by is null
    and (source is null or source <> 'playwright_render');

-- ------------------------------------------------------------
-- claim_stag_render_batch
-- ------------------------------------------------------------
-- Returns up to p_batch_size leads whose cached HTML is empty
-- (< 500 bytes) and hasn't been rendered by Playwright yet. Atomic
-- via FOR UPDATE SKIP LOCKED so competing workers each pick disjoint
-- rows. Also joins google_lead_gen_table so we only return leads
-- that still need a tag (is_affiliate=true, has_s_tags=false, no
-- operator override).
--
-- p_country_code (optional) lets a country-scoped worker pool grab
-- only rows in its country — useful when the render worker's
-- GoLogin session is pinned to one geography. Pass NULL to accept
-- any country.
-- ------------------------------------------------------------
create or replace function public.claim_stag_render_batch(
  p_worker_id    text,
  p_batch_size   integer default 8,
  p_country_code text    default null
)
returns table(lead_id bigint, url text, country_code text)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select c.lead_id, c.url, l.country_code
    from public.fetched_html_cache c
    join public.google_lead_gen_table l on l.id = c.lead_id
    where
      -- HTML empty enough that a JS render is expected to add value.
      (c.html is null or char_length(c.html) < 500)
      -- Not currently held by another worker (or stale hold > 10 min).
      and (
        c.render_claimed_by is null
        or c.render_claimed_at < now() - interval '10 minutes'
      )
      -- Not already re-rendered by Playwright previously.
      and (c.source is null or c.source <> 'playwright_render')
      -- Lead still needs a tag.
      and l.is_affiliate = true
      and l.has_s_tags = false
      and l.is_stag_overridden_at is null
      -- Optional country scope.
      and (p_country_code is null or l.country_code = p_country_code)
    order by c.fetched_at desc
    limit greatest(1, least(p_batch_size, 32))
    for update of c skip locked
  ),
  claimed as (
    update public.fetched_html_cache c
    set render_claimed_by = p_worker_id,
        render_claimed_at = now()
    from candidate
    where c.lead_id = candidate.lead_id
      and c.url = candidate.url
    returning c.lead_id, c.url, candidate.country_code
  )
  select claimed.lead_id, claimed.url, claimed.country_code from claimed;
end;
$$;

grant execute on function public.claim_stag_render_batch(text, integer, text) to service_role;
revoke execute on function public.claim_stag_render_batch(text, integer, text) from anon, authenticated;


-- ------------------------------------------------------------
-- release_stale_render_claims
-- ------------------------------------------------------------
-- Clears render_claimed_by on rows locked more than N minutes ago
-- so a crashed worker can't hold work hostage. Called on a cron
-- schedule the same way release_stale_locks handles scrape/
-- enrichment claims.
-- ------------------------------------------------------------
create or replace function public.release_stale_render_claims(
  p_max_age_minutes integer default 10
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with released as (
    update public.fetched_html_cache
    set render_claimed_by = null,
        render_claimed_at = null
    where render_claimed_by is not null
      and render_claimed_at < now() - (p_max_age_minutes || ' minutes')::interval
      and render_completed_at is null
    returning 1
  )
  select count(*) into v_count from released;
  return coalesce(v_count, 0);
end;
$$;

grant execute on function public.release_stale_render_claims(integer) to service_role;
revoke execute on function public.release_stale_render_claims(integer) from anon, authenticated;
