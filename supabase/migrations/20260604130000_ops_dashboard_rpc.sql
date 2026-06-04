-- ============================================================
-- Migration: get_ops_dashboard() RPC
--
-- Powers the /admin/ops observability page. One round trip, all
-- aggregation done DB-side, returns a single jsonb blob so the
-- server component does zero per-row work.
--
-- Why this exists: on 2026-06-04 we found vm2 & vm3 had been
-- silently running 3/6 enrichment workers for 9 days because the
-- only way to see queue/worker health was hand-written peek-*.ts
-- scripts. This RPC + page replaces those scripts with a glance.
--
-- Windows: breakdowns over 7d, totals also for 24h. Worker
-- liveness is computed over 30d so a worker that died days ago
-- still surfaces with a stale last_claim (the exact tell we missed)
-- rather than silently dropping out of a 7d window.
-- ============================================================

create or replace function public.get_ops_dashboard()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with
  scrape_7d as (
    select status, search_engine, claimed_by, created_at, started_at, error_message
    from public.scrape_queue
    where created_at > now() - interval '7 days'
  ),
  enrich_7d as (
    select status, claimed_by, created_at, started_at, error_message
    from public.enrichment_fetch_queue
    where created_at > now() - interval '7 days'
  ),
  ck_7d as (
    select status, reason, resolution_method, created_at, resolved_at
    from public.interactive_checkpoints
    where created_at > now() - interval '7 days'
  ),
  -- 30d window for worker liveness: a worker dead for 9 days must
  -- still appear (with a stale last_claim) instead of vanishing.
  worker_act as (
    select claimed_by as worker_id, 'scrape' as kind, created_at, started_at
    from public.scrape_queue
    where claimed_by is not null and created_at > now() - interval '30 days'
    union all
    select claimed_by, 'enrichment', created_at, started_at
    from public.enrichment_fetch_queue
    where claimed_by is not null and created_at > now() - interval '30 days'
  )
  select jsonb_build_object(
    'generated_at', now(),
    'scrape', jsonb_build_object(
      'by_status', (
        select coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
        from (select status, count(*) c from scrape_7d group by status) s
      ),
      'by_engine', (
        select coalesce(
          jsonb_agg(jsonb_build_object('engine', search_engine, 'status', status, 'count', c)
                    order by search_engine, status),
          '[]'::jsonb)
        from (select search_engine, status, count(*) c
              from scrape_7d group by search_engine, status) s
      ),
      'total_7d', (select count(*) from scrape_7d),
      'total_24h', (select count(*) from scrape_7d where created_at > now() - interval '24 hours')
    ),
    'enrichment', jsonb_build_object(
      'by_status', (
        select coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
        from (select status, count(*) c from enrich_7d group by status) s
      ),
      'fail_reasons', (
        select coalesce(
          jsonb_agg(jsonb_build_object('reason', reason, 'count', c) order by c desc),
          '[]'::jsonb)
        from (
          select left(coalesce(nullif(trim(error_message), ''), '(no message)'), 80) reason,
                 count(*) c
          from enrich_7d
          where status = 'failed'
          group by left(coalesce(nullif(trim(error_message), ''), '(no message)'), 80)
          order by count(*) desc
          limit 12
        ) s
      ),
      'fail_rate_7d', (
        select case when count(*) = 0 then 0
               else round(100.0 * count(*) filter (where status = 'failed') / count(*), 1) end
        from enrich_7d where status in ('completed', 'failed')
      ),
      'total_7d', (select count(*) from enrich_7d),
      'total_24h', (select count(*) from enrich_7d where created_at > now() - interval '24 hours')
    ),
    'checkpoints', jsonb_build_object(
      'by_status', (
        select coalesce(jsonb_object_agg(status, c), '{}'::jsonb)
        from (select status, count(*) c from ck_7d group by status) s
      ),
      'by_reason', (
        select coalesce(jsonb_object_agg(reason, c), '{}'::jsonb)
        from (select reason, count(*) c from ck_7d group by reason) s
      ),
      'by_resolution', (
        select coalesce(jsonb_object_agg(coalesce(resolution_method, 'unresolved'), c), '{}'::jsonb)
        from (select resolution_method, count(*) c from ck_7d group by resolution_method) s
      ),
      'resolve_rate_7d', (
        select case when count(*) = 0 then 0
               else round(100.0 * count(*) filter (where status = 'resolved') / count(*), 1) end
        from ck_7d
      ),
      'median_resolve_seconds', (
        select round(percentile_cont(0.5) within group (
                 order by extract(epoch from (resolved_at - created_at))))
        from ck_7d where status = 'resolved' and resolved_at is not null
      ),
      'total_7d', (select count(*) from ck_7d)
    ),
    'workers', (
      select coalesce(
        jsonb_agg(jsonb_build_object(
          'worker_id', worker_id,
          'kind', kind,
          'jobs_1h', jobs_1h,
          'jobs_24h', jobs_24h,
          'last_claim', last_claim
        ) order by kind, worker_id),
        '[]'::jsonb)
      from (
        select worker_id, kind,
               count(*) filter (where created_at > now() - interval '1 hour')  jobs_1h,
               count(*) filter (where created_at > now() - interval '24 hours') jobs_24h,
               max(coalesce(started_at, created_at)) last_claim
        from worker_act
        group by worker_id, kind
      ) w
    )
  );
$$;

revoke execute on function public.get_ops_dashboard() from public, anon;
grant execute on function public.get_ops_dashboard() to authenticated, service_role;
