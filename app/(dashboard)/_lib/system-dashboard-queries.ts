import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import type { DateRange } from './date-range'

/**
 * Queries feeding the Phase 2 sections of the System Overview
 * dashboard. Everything is bounded by [range.since, range.until];
 * the caller passes a parsed DateRange from date-range.ts.
 *
 * Row-fetch caps are conservative (2k-5k per query) so a long window
 * (e.g. 90d) doesn't blow the response size — the trend / heatmap
 * both aggregate to <=200 buckets from the raw rows, so 5k is plenty.
 */

const ROW_CAP = 5000

export type SystemDashboardData = {
  /** Scrape jobs (phase-1) within the window. Timestamps used for
   *  trend + heatmap; status counts feed the KPI stats. */
  scrapesCreated: Array<{
    id: string
    keyword: string | null
    country_code: string | null
    search_engine: string | null
    status: string
    created_at: string
    completed_at: string | null
    created_by_display: string | null
  }>
  /** How many succeeded within the window (completed_at falls inside). */
  successCount: number
  /** How many failed / captcha-only. */
  failedCount: number
  /** How many still open (pending / running / captcha). */
  openCount: number
  /** Leader tallies for the 4 leaderboards. */
  leaderboards: {
    byUser: Array<{ label: string; value: number }>
    byEngine: Array<{ label: string; value: number }>
    byCountry: Array<{ label: string; value: number }>
    byKeyword: Array<{ label: string; value: number }>
  }
  /** Latest 20 completions for the drill-down modal. */
  recentCompletions: Array<{
    id: string
    keyword: string | null
    country_code: string | null
    search_engine: string | null
    completed_at: string
    created_by_display: string | null
  }>
  /** True when the row cap was hit — trend / heatmap will be based on
   *  the newest ROW_CAP rows so a spike is captured but the tail is
   *  under-counted. Caller renders a warning. */
  truncated: boolean
}

export async function loadSystemDashboardData(range: DateRange): Promise<SystemDashboardData> {
  const svc = createServiceClient()

  const { data } = await svc
    .from('scrape_queue')
    .select(
      'id, keyword, country_code, search_engine, status, created_at, completed_at, created_by_display',
    )
    .gte('created_at', range.since)
    .lte('created_at', range.until)
    .is('parent_scrape_job_id', null)
    .order('created_at', { ascending: false })
    .limit(ROW_CAP)
  const rows = (data ?? []) as SystemDashboardData['scrapesCreated']
  const truncated = rows.length >= ROW_CAP

  const successCount = rows.filter(r => r.status === 'completed').length
  const failedCount = rows.filter(r => r.status === 'failed' || r.status === 'captcha').length
  const openCount = rows.filter(r => r.status === 'pending' || r.status === 'running').length

  // Leaderboards — tally per dimension over the successful subset so
  // "top scrapers" means top by delivered results, not top by attempts.
  const succ = rows.filter(r => r.status === 'completed')
  const byUserMap = new Map<string, number>()
  const byEngineMap = new Map<string, number>()
  const byCountryMap = new Map<string, number>()
  const byKeywordMap = new Map<string, number>()
  for (const r of succ) {
    const u = r.created_by_display ?? '(unknown)'
    byUserMap.set(u, (byUserMap.get(u) ?? 0) + 1)
    const e = r.search_engine ?? '(none)'
    byEngineMap.set(e, (byEngineMap.get(e) ?? 0) + 1)
    const c = r.country_code ?? '(none)'
    byCountryMap.set(c, (byCountryMap.get(c) ?? 0) + 1)
    const k = r.keyword ?? '(none)'
    byKeywordMap.set(k, (byKeywordMap.get(k) ?? 0) + 1)
  }
  const toRows = (m: Map<string, number>, cap = 10) =>
    Array.from(m.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, cap)
      .map(([label, value]) => ({ label, value }))

  const recentCompletions = rows
    .filter(r => r.status === 'completed' && r.completed_at)
    .slice(0, 20)
    .map(r => ({
      id: r.id,
      keyword: r.keyword,
      country_code: r.country_code,
      search_engine: r.search_engine,
      completed_at: r.completed_at ?? r.created_at,
      created_by_display: r.created_by_display,
    }))

  return {
    scrapesCreated: rows,
    successCount,
    failedCount,
    openCount,
    leaderboards: {
      byUser: toRows(byUserMap),
      byEngine: toRows(byEngineMap),
      byCountry: toRows(byCountryMap),
      byKeyword: toRows(byKeywordMap),
    },
    recentCompletions,
    truncated,
  }
}
