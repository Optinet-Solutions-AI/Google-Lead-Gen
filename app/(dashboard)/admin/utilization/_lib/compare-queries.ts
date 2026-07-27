import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import type { DateRange } from '../../../_lib/date-range'

/**
 * Head-to-head user performance for the "Compare users" tool. Pick a
 * set of users + a window (e.g. 20–24 Jul, Jana vs Ryan) and get each
 * one's scrape volume, outcome split, and per-day series over the same
 * day columns so they line up in one chart/table.
 *
 * "Performance" here = scrape_queue rows they created in the window,
 * broken down by terminal outcome. One row = one keyword × engine.
 */

const ROW_CAP = 20_000

export type CompareUserSeries = {
  email: string
  total: number
  completed: number
  failed: number
  captcha: number
  other: number
  /** Aligned to the shared dayIsos array below. */
  byDay: number[]
  peakDay: number
}

export type UserComparison = {
  /** Every distinct creator email seen in the window — populates the
   *  picker so the operator can tick who to compare. */
  roster: string[]
  /** UTC day-ISOs spanning the window (capped), shared x-axis. */
  dayIsos: string[]
  /** One entry per SELECTED user, in the order requested. */
  series: CompareUserSeries[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_DAYS = 62

export async function loadUserComparison(
  range: DateRange,
  selectedEmails: string[],
): Promise<UserComparison> {
  const svc = createServiceClient()

  // Build the shared day axis across the window (UTC calendar days).
  const startDay = new Date(range.since.slice(0, 10) + 'T00:00:00.000Z').getTime()
  const endDay = new Date(range.until.slice(0, 10) + 'T00:00:00.000Z').getTime()
  const allDays: string[] = []
  for (let t = startDay; t <= endDay; t += DAY_MS) {
    allDays.push(new Date(t).toISOString().slice(0, 10))
  }
  const dayIsos = allDays.length > MAX_DAYS ? allDays.slice(allDays.length - MAX_DAYS) : allDays
  const dayIndex = new Map(dayIsos.map((iso, i) => [iso, i]))

  // Pull the window's phase-1 rows once, then bucket in-memory.
  const { data } = await svc
    .from('scrape_queue')
    .select('created_by_email, created_at, status')
    .gte('created_at', range.since)
    .lte('created_at', range.until)
    .is('parent_scrape_job_id', null)
    .order('created_at', { ascending: false })
    .limit(ROW_CAP)
  const rows = (data ?? []) as Array<{
    created_by_email: string | null
    created_at: string
    status: string
  }>

  const rosterSet = new Set<string>()
  // email -> aggregate
  const agg = new Map<
    string,
    { total: number; completed: number; failed: number; captcha: number; other: number; byDay: number[] }
  >()
  const ensure = (email: string) => {
    let a = agg.get(email)
    if (!a) {
      a = { total: 0, completed: 0, failed: 0, captcha: 0, other: 0, byDay: new Array(dayIsos.length).fill(0) }
      agg.set(email, a)
    }
    return a
  }

  const wanted = new Set(selectedEmails.map(e => e.toLowerCase()))
  for (const r of rows) {
    const email = (r.created_by_email ?? 'unknown').toLowerCase()
    rosterSet.add(email)
    if (wanted.size > 0 && !wanted.has(email)) continue
    const a = ensure(email)
    a.total += 1
    if (r.status === 'completed') a.completed += 1
    else if (r.status === 'failed') a.failed += 1
    else if (r.status === 'captcha') a.captcha += 1
    else a.other += 1
    const di = dayIndex.get(r.created_at.slice(0, 10))
    if (di !== undefined) a.byDay[di] = (a.byDay[di] ?? 0) + 1
  }

  const roster = [...rosterSet].sort()

  // Series in the exact order requested (so column colours stay stable
  // as the operator toggles users). Skip emails with no rows.
  const series: CompareUserSeries[] = []
  for (const raw of selectedEmails) {
    const email = raw.toLowerCase()
    const a = agg.get(email)
    if (!a) continue
    series.push({
      email,
      total: a.total,
      completed: a.completed,
      failed: a.failed,
      captcha: a.captcha,
      other: a.other,
      byDay: a.byDay,
      peakDay: a.byDay.reduce((m, v) => (v > m ? v : m), 0),
    })
  }

  return { roster, dayIsos, series }
}
