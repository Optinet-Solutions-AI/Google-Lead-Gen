import 'server-only'
import { getShadowContext, type ShadowContext } from '@/lib/shadow-filter'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * Apply the shadow visibility rule to a head-only count query.
 *
 * Used for every aggregation on the Overview page so a non-shadow
 * viewer never sees the shadow user's leads/jobs counted in their
 * KPIs, and the shadow viewer sees only their own.
 *
 * All four tables this touches (google_lead_gen_table, scrape_queue,
 * enrichment_fetch_queue, activity_log) carry the same denormalised
 * columns by this migration set, so the filter shape is uniform.
 */
 
function shadowFilter(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  q: any,
  ctx: ShadowContext,
  opts?: { emailColumn?: string; shadowColumn?: string },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const emailColumn = opts?.emailColumn ?? 'created_by_email'
  const shadowColumn = opts?.shadowColumn ?? 'created_by_is_shadow'
  if (ctx.isShadow) {
    return q.eq(emailColumn, ctx.email ?? '__shadow_no_email__')
  }
  return q.eq(shadowColumn, false)
}

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

export type Kpi = {
  total: number
  current: number
  previous: number
  delta: number
  deltaPct: number | null
}

export type ScrapeStats = {
  pending: number
  running: number
  failed_24h: number
  captcha_24h: number
  scheduled_future: number
}

export type EnrichStats = {
  pending: number
  running: number
  failed_24h: number
}

export type ProfileWarning = {
  country_code: string
  country_name: string
}

export type RecentBatch = {
  id: string
  keyword: string
  country_code: string
  status: string
  enrichment_status: string | null
  with_enrichment: boolean
  scheduled_at: string | null
  completed_at: string | null
  created_at: string
  result_summary: { total_results?: number } | null
}

export type ActivityRow = {
  id: number
  user_email: string | null
  action: string
  entity_type: string | null
  entity_id: string | null
  details: Record<string, unknown> | null
  created_at: string
}

export type ProxyBandwidth = {
  usedBytes: number
  limitBytes: number
  remainingBytes: number
  isLow: boolean
  lowThresholdBytes: number
  capturedAt: string
  /** True when the latest snapshot is old enough that the poller is
   *  probably not running / failing — the UI flags it as such. */
  stale: boolean
}

export type WorkerKind = 'scrape' | 'enrichment'

export type WorkerSlot = {
  worker_id: string
  kind: WorkerKind
  port: number
  busy: boolean
  current: null | {
    job_id: string
    country_code: string
    started_at: string | null
    keyword: string | null
    url: string | null
    process_stages: string[] | null
  }
}

export const EXPECTED_WORKERS: ReadonlyArray<{
  id: string
  kind: WorkerKind
  port: number
}> = [
  { id: 'vm1-9222', kind: 'scrape', port: 9222 },
  { id: 'vm1-9223', kind: 'scrape', port: 9223 },
  { id: 'vm1-9224', kind: 'scrape', port: 9224 },
  { id: 'enrich-vm1-9225', kind: 'enrichment', port: 9225 },
  { id: 'enrich-vm1-9226', kind: 'enrichment', port: 9226 },
  { id: 'enrich-vm1-9227', kind: 'enrichment', port: 9227 },
]

export type DashboardData = {
  kpiLeads: Kpi
  kpiAffiliates: Kpi
  kpiRooster: Kpi
  scrape: ScrapeStats
  enrich: EnrichStats
  profileWarnings: ProfileWarning[]
  recentBatches: RecentBatch[]
  recentActivity: ActivityRow[]
  workers: WorkerSlot[]
  hasActiveWork: boolean
  /** Latest proxy bandwidth snapshot, or null if none recorded yet. */
  proxyBandwidth: ProxyBandwidth | null
}

const BANDWIDTH_STALE_MS = 2 * 60 * 60 * 1000

export async function loadDashboardData(): Promise<DashboardData> {
  const svc = createServiceClient()
  // Shadow isolation: every query below is wrapped in shadowFilter so
  // the Overview KPIs, queue counts, recent lists and live worker grid
  // each show only the rows the viewer is supposed to see. Cohort
  // separation is bidirectional — non-shadow viewers don't see shadow
  // numbers; shadow viewers don't see anyone else's.
  const shadowCtx = await getShadowContext()
  const now = Date.now()
  const last24h = new Date(now - DAY_MS).toISOString()
  const last7d = new Date(now - WEEK_MS).toISOString()
  const prev14d = new Date(now - 2 * WEEK_MS).toISOString()
  const nowIso = new Date(now).toISOString()

  const headOpts = { count: 'exact' as const, head: true }
  const safe = async (p: PromiseLike<{ count: number | null }>): Promise<number> => {
    const r = await p
    return r.count ?? 0
  }

  // ----- KPIs -----
  const [
    leadsTotal, leadsCur, leadsPrev,
    affTotal, affCur, affPrev,
    roosterTotal, roosterCur, roosterPrev,
  ] = await Promise.all([
    safe(shadowFilter(svc.from('google_lead_gen_table').select('*', headOpts), shadowCtx)),
    safe(
      shadowFilter(
        svc.from('google_lead_gen_table').select('*', headOpts).gte('created_at', last7d),
        shadowCtx,
      ),
    ),
    safe(
      shadowFilter(
        svc
          .from('google_lead_gen_table')
          .select('*', headOpts)
          .gte('created_at', prev14d)
          .lt('created_at', last7d),
        shadowCtx,
      ),
    ),
    safe(
      shadowFilter(
        svc.from('google_lead_gen_table').select('*', headOpts).eq('is_affiliate', true),
        shadowCtx,
      ),
    ),
    safe(
      shadowFilter(
        svc
          .from('google_lead_gen_table')
          .select('*', headOpts)
          .eq('is_affiliate', true)
          .gte('affiliate_checked_at', last7d),
        shadowCtx,
      ),
    ),
    safe(
      shadowFilter(
        svc
          .from('google_lead_gen_table')
          .select('*', headOpts)
          .eq('is_affiliate', true)
          .gte('affiliate_checked_at', prev14d)
          .lt('affiliate_checked_at', last7d),
        shadowCtx,
      ),
    ),
    safe(
      shadowFilter(
        svc.from('google_lead_gen_table').select('*', headOpts).eq('is_rooster_partner', true),
        shadowCtx,
      ),
    ),
    safe(
      shadowFilter(
        svc
          .from('google_lead_gen_table')
          .select('*', headOpts)
          .eq('is_rooster_partner', true)
          .gte('rooster_checked_at', last7d),
        shadowCtx,
      ),
    ),
    safe(
      shadowFilter(
        svc
          .from('google_lead_gen_table')
          .select('*', headOpts)
          .eq('is_rooster_partner', true)
          .gte('rooster_checked_at', prev14d)
          .lt('rooster_checked_at', last7d),
        shadowCtx,
      ),
    ),
  ])

  // ----- Scrape stats -----
  const [scrapePending, scrapeRunning, scrapeFailed24, scrapeCaptcha24, scrapeScheduled] =
    await Promise.all([
      safe(
        shadowFilter(
          svc
            .from('scrape_queue')
            .select('*', headOpts)
            .eq('status', 'pending')
            .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`),
          shadowCtx,
        ),
      ),
      safe(
        shadowFilter(
          svc.from('scrape_queue').select('*', headOpts).eq('status', 'running'),
          shadowCtx,
        ),
      ),
      safe(
        shadowFilter(
          svc
            .from('scrape_queue')
            .select('*', headOpts)
            .eq('status', 'failed')
            .gte('updated_at', last24h),
          shadowCtx,
        ),
      ),
      safe(
        shadowFilter(
          svc
            .from('scrape_queue')
            .select('*', headOpts)
            .eq('status', 'captcha')
            .gte('updated_at', last24h),
          shadowCtx,
        ),
      ),
      safe(
        shadowFilter(
          svc
            .from('scrape_queue')
            .select('*', headOpts)
            .eq('status', 'pending')
            .gt('scheduled_at', nowIso),
          shadowCtx,
        ),
      ),
    ])

  // ----- Enrichment stats -----
  const [enrichPending, enrichRunning, enrichFailed24] = await Promise.all([
    safe(
      shadowFilter(
        svc.from('enrichment_fetch_queue').select('*', headOpts).eq('status', 'pending'),
        shadowCtx,
      ),
    ),
    safe(
      shadowFilter(
        svc.from('enrichment_fetch_queue').select('*', headOpts).eq('status', 'running'),
        shadowCtx,
      ),
    ),
    safe(
      shadowFilter(
        svc
          .from('enrichment_fetch_queue')
          .select('*', headOpts)
          .eq('status', 'failed')
          .gte('updated_at', last24h),
        shadowCtx,
      ),
    ),
  ])

  // ----- Profile warnings -----
  const { data: warnRows } = await svc
    .from('gologin_profiles')
    .select('country_code, country_name')
    .eq('requires_google_login', true)
    .eq('is_google_logged_in', false)
    .order('country_name', { ascending: true })

  // ----- Proxy bandwidth -----
  // Shared infrastructure (one metered proxy plan), so NOT shadow-
  // filtered — every operator sees the same remaining balance. Read the
  // latest snapshot written by /api/proxy/bandwidth/refresh plus the
  // configured low threshold (for the "warns below X" label).
  const [{ data: bwRow }, { data: bwThresholdRaw }] = await Promise.all([
    svc
      .from('proxy_bandwidth_snapshots')
      .select('used_bytes, limit_bytes, remaining_bytes, is_low, captured_at')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc.rpc('get_system_setting', { p_key: 'proxy_bandwidth_low_threshold_bytes' }),
  ])
  const proxyBandwidth: ProxyBandwidth | null = bwRow
    ? {
        usedBytes: (bwRow as { used_bytes: number }).used_bytes,
        limitBytes: (bwRow as { limit_bytes: number }).limit_bytes,
        remainingBytes: (bwRow as { remaining_bytes: number }).remaining_bytes,
        isLow: (bwRow as { is_low: boolean }).is_low,
        lowThresholdBytes:
          typeof bwThresholdRaw === 'number'
            ? bwThresholdRaw
            : typeof bwThresholdRaw === 'string'
              ? Number(bwThresholdRaw) || 0
              : 0,
        capturedAt: (bwRow as { captured_at: string }).captured_at,
        stale:
          now - new Date((bwRow as { captured_at: string }).captured_at).getTime() >
          BANDWIDTH_STALE_MS,
      }
    : null

  // ----- Recent batches -----
  const { data: batchRows } = await shadowFilter(
    svc
      .from('scrape_queue')
      .select(
        'id, keyword, country_code, status, enrichment_status, with_enrichment, scheduled_at, completed_at, created_at, result_summary',
      ),
    shadowCtx,
  )
    .order('created_at', { ascending: false })
    .limit(10)

  // ----- Recent activity -----
  // activity_log uses user_is_shadow (write-time stamped by
  // lib/activity-log.ts); shadow viewer filters by their own
  // user_email.
  let actQ = svc
    .from('activity_log')
    .select('id, user_email, action, entity_type, entity_id, details, created_at')
  actQ = shadowCtx.isShadow
    ? actQ.eq('user_email', shadowCtx.email ?? '__shadow_no_email__')
    : actQ.eq('user_is_shadow', false)
  const { data: actRows } = await actQ
    .order('created_at', { ascending: false })
    .limit(10)

  // ----- Worker activity -----
  // Workers themselves are shared infrastructure, but we hide the
  // *contents* of a wrong-cohort job: a non-shadow viewer never sees
  // what country/keyword the shadow user is running, and vice versa.
  // The worker simply shows as idle from the other cohort's POV.
  const [scrapeBusy, enrichBusy] = await Promise.all([
    shadowFilter(
      svc
        .from('scrape_queue')
        .select('id, claimed_by, keyword, country_code, started_at')
        .eq('status', 'running'),
      shadowCtx,
    ),
    shadowFilter(
      svc
        .from('enrichment_fetch_queue')
        .select('id, claimed_by, country_code, url, started_at, process_stages')
        .eq('status', 'running'),
      shadowCtx,
    ),
  ])

  const scrapeByWorker = new Map<string, {
    id: string; keyword: string; country_code: string; started_at: string | null
  }>()
  for (const j of scrapeBusy.data ?? []) {
    const r = j as { id: string; claimed_by: string | null; keyword: string; country_code: string; started_at: string | null }
    if (r.claimed_by) scrapeByWorker.set(r.claimed_by, r)
  }
  const enrichByWorker = new Map<string, {
    id: string; url: string; country_code: string; started_at: string | null; process_stages: string[] | null
  }>()
  for (const j of enrichBusy.data ?? []) {
    const r = j as { id: string; claimed_by: string | null; url: string; country_code: string; started_at: string | null; process_stages: string[] | null }
    if (r.claimed_by) enrichByWorker.set(r.claimed_by, r)
  }

  const workers: WorkerSlot[] = EXPECTED_WORKERS.map(w => {
    if (w.kind === 'scrape') {
      const job = scrapeByWorker.get(w.id)
      return {
        worker_id: w.id,
        kind: w.kind,
        port: w.port,
        busy: !!job,
        current: job
          ? {
              job_id: job.id,
              country_code: job.country_code,
              started_at: job.started_at,
              keyword: job.keyword,
              url: null,
              process_stages: null,
            }
          : null,
      }
    } else {
      const job = enrichByWorker.get(w.id)
      return {
        worker_id: w.id,
        kind: w.kind,
        port: w.port,
        busy: !!job,
        current: job
          ? {
              job_id: job.id,
              country_code: job.country_code,
              started_at: job.started_at,
              keyword: null,
              url: job.url,
              process_stages: Array.isArray(job.process_stages) ? job.process_stages : null,
            }
          : null,
      }
    }
  })

  const hasActiveWork =
    workers.some(w => w.busy) ||
    enrichPending > 0 ||
    enrichRunning > 0 ||
    scrapeRunning > 0 ||
    scrapePending > 0

  return {
    kpiLeads: makeKpi(leadsTotal, leadsCur, leadsPrev),
    kpiAffiliates: makeKpi(affTotal, affCur, affPrev),
    kpiRooster: makeKpi(roosterTotal, roosterCur, roosterPrev),
    scrape: {
      pending: scrapePending,
      running: scrapeRunning,
      failed_24h: scrapeFailed24,
      captcha_24h: scrapeCaptcha24,
      scheduled_future: scrapeScheduled,
    },
    enrich: {
      pending: enrichPending,
      running: enrichRunning,
      failed_24h: enrichFailed24,
    },
    profileWarnings: (warnRows ?? []) as ProfileWarning[],
    recentBatches: (batchRows ?? []) as unknown as RecentBatch[],
    recentActivity: (actRows ?? []) as unknown as ActivityRow[],
    workers,
    hasActiveWork,
    proxyBandwidth,
  }
}

function makeKpi(total: number, current: number, previous: number): Kpi {
  const delta = current - previous
  const deltaPct = previous > 0 ? Math.round((delta / previous) * 100) : null
  return { total, current, previous, delta, deltaPct }
}
