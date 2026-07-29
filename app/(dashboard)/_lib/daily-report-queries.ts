import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { BOARDS } from '@/lib/monday/board-registry'
import { parseDateRange } from './date-range'

/**
 * "Daily report" snapshot for the Overview dashboard. All counts are for
 * a single UTC calendar day (today = midnight→now, yesterday = the full
 * prior UTC day), chosen by the Today/Yesterday toggle.
 *
 *   syncedFromMonday  — items mirrored FROM Monday whose synced_at falls
 *                       in the day (sum across all mirrored boards).
 *   batchesScraped    — distinct scrape batches created in the day.
 *   scrapesCompleted  — phase-1 scrape rows that completed in the day.
 *   leadsFound        — google leads discovered (created) in the day.
 *   pushedToMonday    — leads pushed to Monday from the tool in the day.
 */

export type DailyReportDay = 'today' | 'yesterday'

export type DailyReport = {
  day: DailyReportDay
  label: string
  since: string
  until: string
  syncedFromMonday: number
  batchesScraped: number
  scrapesCompleted: number
  leadsFound: number
  pushedToMonday: number
}

export async function loadDailyReport(day: DailyReportDay): Promise<DailyReport> {
  const svc = createServiceClient()
  const range = parseDateRange(day) // 'today' | 'yesterday' → UTC window
  const since = range.since
  const until = range.until

  // --- Monday sync: sum items whose synced_at is in the window, per board.
  const syncCounts = await Promise.all(
    BOARDS.map(b =>
      svc
        .from(b.items_table)
        .select('id', { count: 'exact', head: true })
        .gte('synced_at', since)
        .lte('synced_at', until)
        .then(r => r.count ?? 0),
    ),
  )
  const syncedFromMonday = syncCounts.reduce((a, b) => a + b, 0)

  // --- Scrape batches created in the window (distinct batch_id). A day's
  //     batch set is small, so fetch the ids and dedupe in memory.
  const { data: batchRows } = await svc
    .from('scrape_queue')
    .select('batch_id')
    .is('parent_scrape_job_id', null)
    .not('batch_id', 'is', null)
    .gte('created_at', since)
    .lte('created_at', until)
    .limit(10000)
  const batchesScraped = new Set(((batchRows ?? []) as Array<{ batch_id: number }>).map(r => r.batch_id)).size

  // --- Scrapes completed in the window (phase-1).
  const { count: scrapesCompleted } = await svc
    .from('scrape_queue')
    .select('id', { count: 'exact', head: true })
    .is('parent_scrape_job_id', null)
    .eq('status', 'completed')
    .gte('completed_at', since)
    .lte('completed_at', until)

  // --- Leads discovered in the window.
  const { count: leadsFound } = await svc
    .from('google_lead_gen_table')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since)
    .lte('created_at', until)

  // --- Leads pushed to Monday in the window.
  const { count: pushedToMonday } = await svc
    .from('google_lead_gen_table')
    .select('id', { count: 'exact', head: true })
    .not('pushed_to_monday_at', 'is', null)
    .gte('pushed_to_monday_at', since)
    .lte('pushed_to_monday_at', until)

  return {
    day,
    label: range.label,
    since,
    until,
    syncedFromMonday,
    batchesScraped,
    scrapesCompleted: scrapesCompleted ?? 0,
    leadsFound: leadsFound ?? 0,
    pushedToMonday: pushedToMonday ?? 0,
  }
}
