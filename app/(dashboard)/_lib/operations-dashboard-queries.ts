import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import type { DateRange } from './date-range'
import { EXPECTED_WORKERS } from './dashboard-queries'

/**
 * Queries feeding the Phase 3 Operations dashboard. Everything is
 * scoped to the given date range so operators can look at "today's
 * bot performance" vs "last 7 days" side by side.
 *
 * All queries pull from scrape_queue (claimed_by = worker_id) and
 * interactive_checkpoints (worker_id + resolution_method). Row cap
 * of 8k so a 90d window over a busy fleet fits comfortably.
 */

const ROW_CAP = 8000

export type PerBotStats = {
  workerId: string
  label: string
  kind: 'scrape' | 'enrichment'
  claimsTotal: number
  claimsCompleted: number
  claimsFailed: number
  claimsCaptcha: number
  captchaAutoSolved: number
  captchaHumanSolved: number
  captchaTimedOut: number
  successPct: number
  autoSolvePct: number
}

export type OperationsData = {
  perBot: PerBotStats[]
  /** Activity heatmap cells across all bots (day-of-week × hour-of-day)
   *  for scrape claims in the window. */
  activityHeatmap: Array<{ dayOfWeek: number; hour: number; value: number }>
  /** Recent claims (any bot) for the sidebar drill-down. */
  recentClaims: Array<{
    id: string
    keyword: string | null
    country_code: string | null
    search_engine: string | null
    status: string
    claimed_by: string | null
    started_at: string | null
    completed_at: string | null
    created_by_display: string | null
  }>
  truncated: boolean
}

export async function loadOperationsData(range: DateRange): Promise<OperationsData> {
  const svc = createServiceClient()

  const { data: claimsData } = await svc
    .from('scrape_queue')
    .select(
      'id, keyword, country_code, search_engine, status, claimed_by, started_at, completed_at, created_by_display, parent_scrape_job_id',
    )
    .not('claimed_by', 'is', null)
    .gte('started_at', range.since)
    .lte('started_at', range.until)
    .order('started_at', { ascending: false })
    .limit(ROW_CAP)
  const claims = (claimsData ?? []) as Array<{
    id: string
    keyword: string | null
    country_code: string | null
    search_engine: string | null
    status: string
    claimed_by: string | null
    started_at: string | null
    completed_at: string | null
    created_by_display: string | null
    parent_scrape_job_id: string | null
  }>
  const truncated = claims.length >= ROW_CAP

  const { data: cpData } = await svc
    .from('interactive_checkpoints')
    .select('id, worker_id, status, resolution_method, created_at')
    .gte('created_at', range.since)
    .lte('created_at', range.until)
    .limit(ROW_CAP)
  const checkpoints = (cpData ?? []) as Array<{
    id: number
    worker_id: string
    status: string
    resolution_method: string | null
    created_at: string
  }>

  // Roll up per bot. Include every EXPECTED_WORKERS entry so bots that
  // had zero claims in the window still appear (as "0 claims" cards).
  const perBot: PerBotStats[] = EXPECTED_WORKERS.map(w => {
    const botClaims = claims.filter(c => c.claimed_by === w.id)
    const botCheckpoints = checkpoints.filter(c => c.worker_id === w.id)
    const claimsTotal = botClaims.length
    const claimsCompleted = botClaims.filter(c => c.status === 'completed').length
    const claimsFailed = botClaims.filter(c => c.status === 'failed').length
    const claimsCaptcha = botClaims.filter(c => c.status === 'captcha').length
    const captchaAutoSolved = botCheckpoints.filter(
      c => c.status === 'resolved' && c.resolution_method === 'auto_2captcha',
    ).length
    const captchaHumanSolved = botCheckpoints.filter(
      c => c.status === 'resolved' && c.resolution_method !== 'auto_2captcha',
    ).length
    const captchaTimedOut = botCheckpoints.filter(c => c.status === 'timed_out').length
    const successPct = claimsTotal > 0 ? Math.round((claimsCompleted / claimsTotal) * 100) : 0
    const totalCheckpoints = captchaAutoSolved + captchaHumanSolved + captchaTimedOut
    const autoSolvePct =
      totalCheckpoints > 0 ? Math.round((captchaAutoSolved / totalCheckpoints) * 100) : 0
    return {
      workerId: w.id,
      label: w.label,
      kind: w.kind,
      claimsTotal,
      claimsCompleted,
      claimsFailed,
      claimsCaptcha,
      captchaAutoSolved,
      captchaHumanSolved,
      captchaTimedOut,
      successPct,
      autoSolvePct,
    }
  })

  const heatmap = new Map<string, number>()
  for (const c of claims) {
    if (!c.started_at) continue
    const d = new Date(c.started_at)
    if (Number.isNaN(d.getTime())) continue
    const jsDow = d.getUTCDay()
    const dow = jsDow === 0 ? 6 : jsDow - 1
    const key = `${dow}:${d.getUTCHours()}`
    heatmap.set(key, (heatmap.get(key) ?? 0) + 1)
  }
  const activityHeatmap = Array.from(heatmap.entries()).map(([k, v]) => {
    const [dow, hour] = k.split(':').map(Number)
    return { dayOfWeek: dow!, hour: hour!, value: v }
  })

  const recentClaims = claims.slice(0, 40).map(c => ({
    id: c.id,
    keyword: c.keyword,
    country_code: c.country_code,
    search_engine: c.search_engine,
    status: c.status,
    claimed_by: c.claimed_by,
    started_at: c.started_at,
    completed_at: c.completed_at,
    created_by_display: c.created_by_display,
  }))

  return { perBot, activityHeatmap, recentClaims, truncated }
}
