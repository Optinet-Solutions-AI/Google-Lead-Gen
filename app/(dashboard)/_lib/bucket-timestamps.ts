import type { TrendPoint } from '../_components/dashboards/trend-chart'

/**
 * Turn a list of ISO timestamps into daily trend points spanning
 * [since, until] with zero-fill on days that had no activity. The
 * consistent x-axis is what makes the chart readable when a
 * long-window query happens to have gaps.
 *
 * `secondaryTimestamps` (optional) lets us plot a "successful"
 * subset as a dashed line on top of the total — used everywhere
 * we want a success-rate visual on the trend.
 */
export function bucketByDayInWindow(
  timestamps: string[],
  since: string,
  until: string,
  secondaryTimestamps?: string[],
): TrendPoint[] {
  const start = utcDayStart(new Date(since))
  const end = utcDayStart(new Date(until))
  const days: TrendPoint[] = []
  const counts = countByDay(timestamps)
  const secCounts = secondaryTimestamps ? countByDay(secondaryTimestamps) : null

  const oneDay = 24 * 60 * 60 * 1000
  for (let t = start.getTime(); t <= end.getTime(); t += oneDay) {
    const d = new Date(t)
    const key = utcDayKey(d)
    const point: TrendPoint = {
      label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
      value: counts.get(key) ?? 0,
    }
    if (secCounts) point.value2 = secCounts.get(key) ?? 0
    days.push(point)
  }
  return days
}

/**
 * Same buckets by day but for an HOUR-of-day trend within a single
 * day (used on "Today" range so the trend still has 24 x points).
 */
export function bucketByHourInDay(
  timestamps: string[],
  since: string,
  secondaryTimestamps?: string[],
): TrendPoint[] {
  const startHour = new Date(since).getUTCHours()
  const counts = countByHour(timestamps)
  const secCounts = secondaryTimestamps ? countByHour(secondaryTimestamps) : null
  const points: TrendPoint[] = []
  for (let h = 0; h < 24; h++) {
    const point: TrendPoint = {
      label: `${String(h).padStart(2, '0')}:00`,
      value: counts.get(h) ?? 0,
    }
    if (secCounts) point.value2 = secCounts.get(h) ?? 0
    // Only include hours >= start-hour on "Today" so we don't fill
    // the tail with zero hours that haven't happened yet.
    if (h >= startHour || startHour === 0) {
      points.push(point)
    }
  }
  return points.length > 0 ? points : [{ label: '00:00', value: 0 }]
}

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
function utcDayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
}
function countByDay(timestamps: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const iso of timestamps) {
    if (!iso) continue
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) continue
    const k = utcDayKey(d)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}
function countByHour(timestamps: string[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const iso of timestamps) {
    if (!iso) continue
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) continue
    const h = d.getUTCHours()
    m.set(h, (m.get(h) ?? 0) + 1)
  }
  return m
}
