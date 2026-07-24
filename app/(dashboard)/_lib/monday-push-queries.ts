import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import type { DateRange } from './date-range'

/**
 * Queries for the "Pushed to Monday" analytics panel on the Monday
 * dashboard. Answers three operator questions in one place:
 *
 *   1. How many leads have we pushed to Monday from our tool?
 *   2. Who is pushing them and how often?
 *   3. For any given number in the panel, what were the actual leads?
 *
 * Data source: google_lead_gen_table.pushed_to_monday_at (set by
 * pushLeadToMondayAction). "Who pushed" comes from monday_pushed_by
 * on the same row; the more precise user_id lives in activity_log
 * (action='monday.push_lead') but we join that only in the detail view
 * to keep the summary query cheap. The scraped-by info comes via the
 * lead's scrape_job_id → scrape_queue join.
 *
 * We deliberately do NOT combine the 8 per-engine social entity
 * tables here. That would ~9x the query cost and the Monday board for
 * social entities is the same board — operators drilling in expect
 * the lead they'll recognise, not an entity-level row. Add a separate
 * "Social entities" panel if the request surfaces later.
 */

const PUSH_DETAIL_ROW_CAP = 2000

export type MondayPushSummary = {
  totalPushed: number
  pushedInWindow: number
  pushedToday: number
  uniquePushers: number
  /** Daily counts across the window, ready for TrendChart. Empty
   *  array for single-day windows (chart is meaningless there). Each
   *  point carries the bucket's UTC date as YYYY-MM-DD so the client
   *  can pass it back verbatim to the detail sheet without having to
   *  reverse-engineer the window boundary. */
  dailyTrend: Array<{ label: string; value: number; day: string }>
  /** [{pusher, count}] sorted desc, top 15 for the leaderboard. */
  pusherLeaderboard: Array<{ label: string; value: number }>
  /** [{country_code, count}] sorted desc. */
  countryLeaderboard: Array<{ label: string; value: number }>
}

export type MondayPushDetailRow = {
  lead_id: number
  url: string | null
  domain: string | null
  keyword: string | null
  country_code: string | null
  brand: string | null
  result_type: string | null
  scraped_at: string | null
  scraped_by: string | null
  pushed_at: string
  pushed_by: string | null
  monday_pushed_item_id: string | null
}

/**
 * Summary + trend + leaderboards for the panel. One-shot: everything
 * the panel needs to render is in the returned object.
 */
export async function loadMondayPushSummary(range: DateRange): Promise<MondayPushSummary> {
  const svc = createServiceClient()
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Cheap head counts.
  const [{ count: totalPushed }, { count: pushedInWindow }, { count: pushedToday }] = await Promise.all([
    svc
      .from('google_lead_gen_table')
      .select('id', { count: 'exact', head: true })
      .not('pushed_to_monday_at', 'is', null),
    svc
      .from('google_lead_gen_table')
      .select('id', { count: 'exact', head: true })
      .not('pushed_to_monday_at', 'is', null)
      .gte('pushed_to_monday_at', range.since)
      .lte('pushed_to_monday_at', range.until),
    svc
      .from('google_lead_gen_table')
      .select('id', { count: 'exact', head: true })
      .not('pushed_to_monday_at', 'is', null)
      .gte('pushed_to_monday_at', dayAgo),
  ])

  // Rows in window for the trend + leaderboards. Cap at PUSH_DETAIL_ROW_CAP;
  // if the window ever exceeds that, the panel's numbers are still
  // exact (from the counts above) and only the chart/leaderboard
  // truncate — the drill-down loads its own broader set from the
  // export route or from loadMondayPushDetails.
  const { data: rows } = await svc
    .from('google_lead_gen_table')
    .select('country_code, pushed_to_monday_at, monday_pushed_by')
    .not('pushed_to_monday_at', 'is', null)
    .gte('pushed_to_monday_at', range.since)
    .lte('pushed_to_monday_at', range.until)
    .order('pushed_to_monday_at', { ascending: false })
    .limit(PUSH_DETAIL_ROW_CAP)

  const list = (rows ?? []) as Array<{
    country_code: string | null
    pushed_to_monday_at: string | null
    monday_pushed_by: string | null
  }>

  // Bucket by day for the trend line. Skip when the range is a single
  // day (Today / Yesterday) — the panel already surfaces the "today"
  // tile so an hourly chart there would be redundant filler.
  const isSingleDay = range.key === 'today' || range.key === 'yesterday'
  let dailyTrend: Array<{ label: string; value: number; day: string }> = []
  if (!isSingleDay) {
    const startMs = new Date(range.since).getTime()
    const endMs = new Date(range.until).getTime()
    const dayMs = 24 * 60 * 60 * 1000
    const dayCount = Math.max(1, Math.ceil((endMs - startMs) / dayMs))
    const buckets = new Array(dayCount).fill(0)
    for (const r of list) {
      if (!r.pushed_to_monday_at) continue
      const idx = Math.floor((new Date(r.pushed_to_monday_at).getTime() - startMs) / dayMs)
      if (idx >= 0 && idx < dayCount) buckets[idx]++
    }
    dailyTrend = buckets.map((v, i) => {
      const d = new Date(startMs + i * dayMs)
      const y = d.getUTCFullYear()
      const m = String(d.getUTCMonth() + 1).padStart(2, '0')
      const day = String(d.getUTCDate()).padStart(2, '0')
      return {
        label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
        value: v,
        day: `${y}-${m}-${day}`,
      }
    })
  }

  // Leaderboards.
  const pusherCounts = new Map<string, number>()
  const countryCounts = new Map<string, number>()
  const uniquePusherSet = new Set<string>()
  for (const r of list) {
    const pusher = (r.monday_pushed_by ?? '').trim() || '(unknown)'
    pusherCounts.set(pusher, (pusherCounts.get(pusher) ?? 0) + 1)
    if (pusher !== '(unknown)') uniquePusherSet.add(pusher)
    const country = (r.country_code ?? '').trim().toUpperCase() || '??'
    countryCounts.set(country, (countryCounts.get(country) ?? 0) + 1)
  }
  const pusherLeaderboard = [...pusherCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([label, value]) => ({ label, value }))
  const countryLeaderboard = [...countryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value }))

  return {
    totalPushed: totalPushed ?? 0,
    pushedInWindow: pushedInWindow ?? 0,
    pushedToday: pushedToday ?? 0,
    uniquePushers: uniquePusherSet.size,
    dailyTrend,
    pusherLeaderboard,
    countryLeaderboard,
  }
}

/**
 * Per-lead detail rows for the drill-down side sheet AND the CSV
 * export route. Joins scrape_queue via scrape_job_id to surface who
 * scraped each lead (creator display / username). Also normalises
 * every column so the CSV export can .map(...) without null-checks.
 *
 * Optional filters narrow to a bucket the operator clicked on the
 * panel — a specific country, a specific pusher, or a specific day.
 */
export type MondayPushDetailFilters = {
  country?: string
  pusher?: string
  /** YYYY-MM-DD (UTC) — narrows to pushed_to_monday_at within that day. */
  day?: string
  /** true → ignore the range's since/until window and return every
   *  push ever. Used when the operator clicks the "Pushed all time"
   *  tile — the number on that tile is an all-time count so the sheet
   *  needs to match. */
  all?: boolean
}

export async function loadMondayPushDetails(
  range: DateRange,
  filters: MondayPushDetailFilters = {},
): Promise<MondayPushDetailRow[]> {
  const svc = createServiceClient()

  let q = svc
    .from('google_lead_gen_table')
    .select(
      'id, url, domain, keyword, country_code, brand, result_type, created_at, ' +
        'pushed_to_monday_at, monday_pushed_by, monday_pushed_item_id, ' +
        'scrape_job_id, scrape_queue!scrape_job_id(created_by_username, created_by_display, created_by_email)',
    )
    .not('pushed_to_monday_at', 'is', null)
    .order('pushed_to_monday_at', { ascending: false })
    .limit(PUSH_DETAIL_ROW_CAP)

  // Time window: three modes, in priority order:
  //   1. filters.day  → single UTC day (drill from a chart bar)
  //   2. filters.all  → no window at all (all-time; matches the
  //                     "Pushed all time" tile's count)
  //   3. default      → the DateRange from ?range= on the page
  if (filters.day && /^\d{4}-\d{2}-\d{2}$/.test(filters.day)) {
    const [y, m, d] = filters.day.split('-').map(n => Number(n))
    const start = new Date(Date.UTC(y!, m! - 1, d!))
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
    q = q.gte('pushed_to_monday_at', start.toISOString())
    q = q.lte('pushed_to_monday_at', end.toISOString())
  } else if (!filters.all) {
    q = q.gte('pushed_to_monday_at', range.since)
    q = q.lte('pushed_to_monday_at', range.until)
  }

  if (filters.country) q = q.eq('country_code', filters.country)
  if (filters.pusher && filters.pusher !== '(unknown)') q = q.eq('monday_pushed_by', filters.pusher)

  const { data } = await q
  // supabase-js infers a GenericStringError union for embedded FK
  // selects when the relationship isn't in its generated types.
  // Cast through unknown → concrete row shape.
  const rows = ((data ?? []) as unknown) as Array<{
    id: number
    url: string | null
    domain: string | null
    keyword: string | null
    country_code: string | null
    brand: string | null
    result_type: string | null
    created_at: string | null
    pushed_to_monday_at: string
    monday_pushed_by: string | null
    monday_pushed_item_id: string | null
    scrape_queue: {
      created_by_username: string | null
      created_by_display: string | null
      created_by_email: string | null
    } | null
  }>

  return rows.map(r => {
    const scraper =
      r.scrape_queue?.created_by_display ||
      r.scrape_queue?.created_by_username ||
      r.scrape_queue?.created_by_email ||
      null
    return {
      lead_id: r.id,
      url: r.url,
      domain: r.domain,
      keyword: r.keyword,
      country_code: r.country_code,
      brand: r.brand,
      result_type: r.result_type,
      scraped_at: r.created_at,
      scraped_by: scraper,
      pushed_at: r.pushed_to_monday_at,
      pushed_by: r.monday_pushed_by,
      monday_pushed_item_id: r.monday_pushed_item_id,
    }
  })
}
