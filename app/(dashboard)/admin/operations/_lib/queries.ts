import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'

export const BYTES_PER_GB = 1024 ** 3

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

export type BandwidthSnapshot = {
  used_bytes: number
  limit_bytes: number
  remaining_bytes: number
  is_low: boolean
  captured_at: string
}

export type BurnWindow = {
  /** Label like "Last hour" / "Last 24h". */
  label: string
  /** Window length in hours used for the rate maths. */
  hours: number
  /** Bytes consumed in the window (>=0; top-up resets are absorbed). */
  consumedBytes: number
  /** consumedBytes / hours, in bytes/hour. */
  bytesPerHour: number
  /** True when we didn't have enough snapshot history to fill the window. */
  partial: boolean
}

export type FixedCostLine = {
  key: string
  label: string
  amountUsd: number
}

export type SinceWindow = {
  /** ISO string of the start of the window (UTC). */
  sinceIso: string
  /** Bytes consumed since `sinceIso` (positive deltas only). */
  consumedBytes: number
  /** scrape_queue rows that finished (status=completed) since `sinceIso`. */
  scrapeJobsCompleted: number
  /** scrape_queue rows that started running since `sinceIso`. */
  scrapeJobsStarted: number
  /** google_lead_gen_table rows created since `sinceIso`. */
  newLeads: number
  /** USD = consumed × per-GB rate. */
  bandwidthCostUsd: number
}

export type OperationsData = {
  /** Most recent successful snapshot (null if none captured yet). */
  latest: BandwidthSnapshot | null
  /** Most recent older than 24h, used as the anchor for the 24h burn rate. */
  burns: BurnWindow[]
  /** Raw snapshots for the last 7d (newest-first) — graph fodder. */
  recentSnapshots: BandwidthSnapshot[]
  /** Bytes consumed in the current calendar month so far. */
  monthToDateBytes: number
  /** USD per GB the admin has configured for the proxy plan. */
  costPerGbUsd: number
  /** Current month's bandwidth bill (cost × monthToDate). */
  monthToDateBandwidthCostUsd: number
  /** Projected bandwidth cost for the full month at the recent burn rate. */
  monthProjectedBandwidthCostUsd: number
  fixedCosts: FixedCostLine[]
  fixedMonthlyTotalUsd: number
  /** monthToDateBandwidthCostUsd + (fraction of the month elapsed × fixed). */
  monthToDateOpExUsd: number
  /** monthProjected + fixed. */
  monthProjectedOpExUsd: number
  /**
   * Ad-hoc window starting at the operator-supplied `sinceIso`
   * (default = month start). Lets the operator answer "what's happened
   * since I topped up at 2:30pm PHT today" without writing SQL.
   */
  since: SinceWindow
}

const FIXED_COST_KEYS = [
  { key: 'fixed_cost_ec2_monthly_usd',       label: 'AWS EC2 (3 VMs)' },
  { key: 'fixed_cost_gologin_monthly_usd',   label: 'GoLogin profiles' },
  { key: 'fixed_cost_supabase_monthly_usd',  label: 'Supabase' },
  { key: 'fixed_cost_vercel_monthly_usd',    label: 'Vercel' },
  { key: 'fixed_cost_other_monthly_usd',     label: 'Other / EnigmaProxy base' },
] as const

/**
 * Compute everything the /admin/operations page renders in one
 * batch. We pull the snapshot history once and reuse it across all
 * three burn-rate windows + the month-to-date total to avoid a
 * fan-out of round trips.
 *
 * `sinceIso` (optional) anchors the "since" window panel. Default
 * is the start of the current UTC month, which matches the
 * month-to-date numbers everywhere else. Pass a custom ISO string
 * (e.g. "today at 2:30 PM PHT" → "<date>T06:30:00Z") to answer
 * ad-hoc questions like "how much have we burned since I topped up".
 */
export async function loadOperationsData(sinceIso?: string): Promise<OperationsData> {
  const svc = createServiceClient()
  const now = Date.now()
  const last7dIso = new Date(now - 7 * DAY_MS).toISOString()
  const monthStartIso = (() => {
    const d = new Date(now)
    d.setUTCDate(1)
    d.setUTCHours(0, 0, 0, 0)
    return d.toISOString()
  })()
  // Validate the supplied sinceIso — fall back to month start if it's
  // unparseable or in the future. Future timestamps would yield
  // nonsense counts so we don't bother sending them to PostgREST.
  const sinceWindowIso = (() => {
    if (!sinceIso) return monthStartIso
    const t = Date.parse(sinceIso)
    if (!Number.isFinite(t) || t > now) return monthStartIso
    return new Date(t).toISOString()
  })()

  // Pull all the settings + snapshots + counts in parallel.
  // The "since" window needs its own snapshot fetch because it could
  // legitimately reach back further than the 7-day burn-rate window
  // (an operator might ask "since two weeks ago"). We also fan out
  // three head-only count queries for the scrape/lead counters in the
  // same Promise.all so the page payload only adds one extra round
  // trip of latency.
  const [
    { data: snapshots },
    { data: monthAnchor },
    settingsResult,
    { data: sinceSnapshots },
    { count: scrapeJobsCompleted },
    { count: scrapeJobsStarted },
    { count: newLeads },
  ] = await Promise.all([
    svc
      .from('proxy_bandwidth_snapshots')
      .select('used_bytes, limit_bytes, remaining_bytes, is_low, captured_at')
      .gte('captured_at', last7dIso)
      .order('captured_at', { ascending: false }),
    // First snapshot at-or-after month start (oldest first → take row 0).
    svc
      .from('proxy_bandwidth_snapshots')
      .select('used_bytes, limit_bytes, captured_at')
      .gte('captured_at', monthStartIso)
      .order('captured_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
    svc
      .from('system_settings')
      .select('key, value')
      .in('key', [
        'proxy_bandwidth_cost_usd_per_gb',
        ...FIXED_COST_KEYS.map(k => k.key),
      ]),
    svc
      .from('proxy_bandwidth_snapshots')
      .select('used_bytes, remaining_bytes, captured_at')
      .gte('captured_at', sinceWindowIso)
      .order('captured_at', { ascending: false }),
    svc
      .from('scrape_queue')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('completed_at', sinceWindowIso),
    svc
      .from('scrape_queue')
      .select('*', { count: 'exact', head: true })
      .gte('started_at', sinceWindowIso),
    svc
      .from('google_lead_gen_table')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', sinceWindowIso),
  ])

  const rows = (snapshots ?? []) as BandwidthSnapshot[]
  const latest = rows[0] ?? null

  const settingsMap = new Map<string, number>()
  for (const r of (settingsResult.data ?? []) as Array<{ key: string; value: unknown }>) {
    settingsMap.set(r.key, parseSettingNumber(r.value))
  }
  const costPerGbUsd = settingsMap.get('proxy_bandwidth_cost_usd_per_gb') ?? 0

  // Burn-rate windows. Newest snapshot is rows[0]; pick the oldest
  // snapshot inside each window as the anchor, then sum positive
  // used_bytes deltas across the window (positive-only so a plan
  // top-up — which can momentarily drop remaining/used to zero —
  // doesn't get counted as negative consumption).
  const burnWindowHours = [1, 24, 24 * 7]
  const burnLabels = ['Last hour', 'Last 24h', 'Last 7d']
  const burns: BurnWindow[] = burnWindowHours.map((hours, i) => {
    const cutoffMs = now - hours * HOUR_MS
    const insideWindow = rows.filter(r => new Date(r.captured_at).getTime() >= cutoffMs)
    const consumed = positiveDeltaSum(insideWindow.map(r => r.used_bytes), insideWindow.map(r => r.remaining_bytes))
    const oldestInside = insideWindow[insideWindow.length - 1]
    const actualHours = oldestInside
      ? Math.max(
          0.0001,
          (now - new Date(oldestInside.captured_at).getTime()) / HOUR_MS,
        )
      : hours
    return {
      label: burnLabels[i]!,
      hours,
      consumedBytes: consumed,
      bytesPerHour: actualHours > 0 ? consumed / actualHours : 0,
      partial: actualHours < hours * 0.5,
    }
  })

  // Month-to-date: sum positive deltas inside the month-to-date
  // window. We use the monthAnchor row (oldest snapshot in the
  // month) as the baseline; if it's missing we fall back to the
  // 7-day window which is at least informative.
  let monthToDateBytes = 0
  if (monthAnchor && latest) {
    const inMonth = rows.filter(
      r => new Date(r.captured_at).getTime() >= new Date(monthStartIso).getTime(),
    )
    monthToDateBytes = positiveDeltaSum(
      inMonth.map(r => r.used_bytes),
      inMonth.map(r => r.remaining_bytes),
    )
  }

  const monthToDateBandwidthCostUsd = (monthToDateBytes / BYTES_PER_GB) * costPerGbUsd

  // Projection: project to the full month at the 24h burn rate.
  // Hour-of-month elapsed; days-in-month from latest sample.
  const burn24h = burns[1]!
  const projectedMonthlyBytes = burn24h.bytesPerHour * 24 * 30
  const monthProjectedBandwidthCostUsd =
    (projectedMonthlyBytes / BYTES_PER_GB) * costPerGbUsd

  const fixedCosts: FixedCostLine[] = FIXED_COST_KEYS.map(c => ({
    key: c.key,
    label: c.label,
    amountUsd: settingsMap.get(c.key) ?? 0,
  }))
  const fixedMonthlyTotalUsd = fixedCosts.reduce((a, c) => a + c.amountUsd, 0)

  // Pro-rate fixed costs by month elapsed so the month-to-date OpEx
  // is a fair "what you'd have paid if you stopped today" figure.
  const monthFrac = monthElapsedFraction(now)
  const monthToDateOpExUsd =
    monthToDateBandwidthCostUsd + fixedMonthlyTotalUsd * monthFrac

  const monthProjectedOpExUsd = monthProjectedBandwidthCostUsd + fixedMonthlyTotalUsd

  // "Since" window — bandwidth + activity counts. The snapshot list is
  // newest-first, same shape as the main `rows` list; positiveDeltaSum
  // takes a newest-first input so we pass it as-is.
  const sinceRows = (sinceSnapshots ?? []) as Array<{
    used_bytes: number
    remaining_bytes: number
    captured_at: string
  }>
  const consumedSinceBytes = positiveDeltaSum(
    sinceRows.map(r => r.used_bytes),
    sinceRows.map(r => r.remaining_bytes),
  )
  const sinceWindow: SinceWindow = {
    sinceIso: sinceWindowIso,
    consumedBytes: consumedSinceBytes,
    scrapeJobsCompleted: scrapeJobsCompleted ?? 0,
    scrapeJobsStarted: scrapeJobsStarted ?? 0,
    newLeads: newLeads ?? 0,
    bandwidthCostUsd: (consumedSinceBytes / BYTES_PER_GB) * costPerGbUsd,
  }

  return {
    latest,
    burns,
    recentSnapshots: rows,
    monthToDateBytes,
    costPerGbUsd,
    monthToDateBandwidthCostUsd,
    monthProjectedBandwidthCostUsd,
    fixedCosts,
    fixedMonthlyTotalUsd,
    monthToDateOpExUsd,
    monthProjectedOpExUsd,
    since: sinceWindow,
  }
}

/**
 * Sum positive used-bytes deltas across an ordered (newest-first)
 * series. Drops negative deltas, which only appear when the operator
 * tops up the plan and Enigma resets the "used" counter.
 *
 * Fallback: if used_bytes is all zeros (some sessions Enigma only
 * reports remaining), fall back to remaining-bytes deltas in the
 * other direction.
 */
function positiveDeltaSum(usedNewestFirst: number[], remainingNewestFirst: number[]): number {
  const reversed = [...usedNewestFirst].reverse()
  let total = 0
  let cumPositive = false
  for (let i = 1; i < reversed.length; i += 1) {
    const delta = (reversed[i] ?? 0) - (reversed[i - 1] ?? 0)
    if (delta > 0) {
      total += delta
      cumPositive = true
    }
  }
  if (cumPositive) return total

  const revRem = [...remainingNewestFirst].reverse()
  let totalRem = 0
  for (let i = 1; i < revRem.length; i += 1) {
    // remaining decreasing == consumption — flip the sign.
    const delta = (revRem[i - 1] ?? 0) - (revRem[i] ?? 0)
    if (delta > 0) totalRem += delta
  }
  return totalRem
}

/** Fraction of the current UTC calendar month that has elapsed. */
function monthElapsedFraction(nowMs: number): number {
  const d = new Date(nowMs)
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  return (nowMs - start) / (end - start)
}

function parseSettingNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}
