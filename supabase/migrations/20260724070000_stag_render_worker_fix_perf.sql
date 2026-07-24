-- ============================================================
-- Perf fix for claim_stag_render_batch.
--
-- The version shipped in 20260724060000 uses char_length(html) in the
-- WHERE clause. Postgres has to detoast every non-inline html blob to
-- evaluate that predicate, so on our table (~2,800 rows, most with
-- large html) the query timed out at the default statement_timeout.
--
-- Fix: store the length in a stored generated column and index it.
-- Cheap to compute at insert/update time, near-free to filter on.
-- The RPC now filters on html_length + source + claim state — every
-- predicate is a plain column read.
-- ============================================================

alter table public.fetched_html_cache
  add column if not exists html_length integer
    generated always as (coalesce(char_length(html), 0)) stored;

-- Drop the old partial index (based on fetched_at only) and replace
-- with one that also carries html_length so the claim scan is a pure
-- index-only read for the empty-html candidates.
drop index if exists public.fetched_html_cache_render_pending_idx;
create index if not exists fetched_html_cache_render_pending_idx
  on public.fetched_html_cache (html_length, fetched_at desc)
  where render_claimed_by is null
    and (source is null or source <> 'playwright_render');

-- ------------------------------------------------------------
-- Rewritten claim_stag_render_batch — same shape, faster predicates.
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
  -- Cap the query's own statement timeout so a slow read never
  -- blocks the caller for long. Workers poll on their own cadence.
  set local statement_timeout = '10s';

  return query
  with candidate as (
    select c.lead_id, c.url, l.country_code
    from public.fetched_html_cache c
    join public.google_lead_gen_table l on l.id = c.lead_id
    where
      c.html_length < 500
      and (
        c.render_claimed_by is null
        or c.render_claimed_at < now() - interval '10 minutes'
      )
      and (c.source is null or c.source <> 'playwright_render')
      and l.is_affiliate = true
      and l.has_s_tags = false
      and l.is_stag_overridden_at is null
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
