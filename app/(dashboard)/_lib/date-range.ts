import 'server-only'

/**
 * Shared date-range parsing for all four dashboards. Every dashboard's
 * top-of-page DateRangeToggle passes its choice via `?range=` and the
 * server computes the actual since/until timestamps. Keeping this in
 * one place means every dashboard's "Today" starts at the same UTC
 * midnight, "Last 7 days" means the same rolling window everywhere,
 * etc.
 *
 * Rationale for UTC:
 *   The scrapes / captchas / activity_log rows are all stamped in UTC
 *   by Supabase. Rolling a per-viewer local-tz window here would drift
 *   day boundaries across users. UTC is unambiguous — the tradeoff is
 *   "Today" on the dashboard is midnight-to-now UTC, not midnight-to-
 *   now Manila time. Add a per-viewer TZ later if operators complain.
 */

export type DateRangeKey = 'today' | 'yesterday' | '7d' | '30d' | '90d'

export type DateRange = {
  key: DateRangeKey
  label: string
  /** ISO-8601 (UTC) inclusive start of window. */
  since: string
  /** ISO-8601 (UTC) exclusive end of window (= now for rolling ranges). */
  until: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Midnight-UTC of the day at offset `daysAgo` (0 = today, 1 = yesterday). */
function utcMidnight(daysAgo: number): Date {
  const now = new Date()
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - daysAgo,
    ),
  )
}

export function parseDateRange(raw: string | string[] | undefined): DateRange {
  const key: DateRangeKey =
    raw === 'yesterday' || raw === '7d' || raw === '30d' || raw === '90d' || raw === 'today'
      ? raw
      : 'today'
  const now = new Date()
  switch (key) {
    case 'yesterday': {
      const start = utcMidnight(1)
      const end = utcMidnight(0)
      return {
        key,
        label: 'Yesterday',
        since: start.toISOString(),
        until: end.toISOString(),
      }
    }
    case '7d': {
      return {
        key,
        label: 'Last 7 days',
        since: new Date(now.getTime() - 7 * DAY_MS).toISOString(),
        until: now.toISOString(),
      }
    }
    case '30d': {
      return {
        key,
        label: 'Last 30 days',
        since: new Date(now.getTime() - 30 * DAY_MS).toISOString(),
        until: now.toISOString(),
      }
    }
    case '90d': {
      return {
        key,
        label: 'Last 90 days',
        since: new Date(now.getTime() - 90 * DAY_MS).toISOString(),
        until: now.toISOString(),
      }
    }
    case 'today':
    default: {
      const start = utcMidnight(0)
      return {
        key: 'today',
        label: 'Today',
        since: start.toISOString(),
        until: now.toISOString(),
      }
    }
  }
}

/** Same list used to render the DateRangeToggle chips client-side. */
export const DATE_RANGE_OPTIONS: ReadonlyArray<{ key: DateRangeKey; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7d' },
  { key: '30d', label: 'Last 30d' },
  { key: '90d', label: 'Last 90d' },
]
