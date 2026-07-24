import Link from 'next/link'
import { parseDateRange } from '../_lib/date-range'
import { DateRangeToggle } from '../_components/dashboards/date-range-toggle'
import { DashboardSection } from '../_components/dashboards/dashboard-section'
import { StatCard } from '../_components/dashboards/stat-card'
import { TrendChart } from '../_components/dashboards/trend-chart'
import { HeatMap, bucketToHeatmap } from '../_components/dashboards/heat-map'
import { Leaderboard } from '../_components/dashboards/leaderboard'
import { bucketByDayInWindow, bucketByHourInDay } from '../_lib/bucket-timestamps'
import {
  loadMondayAnalyticsData,
  loadStagMatchStats,
  type BoardSnapshot,
} from '../_lib/monday-dashboard-queries'
import { loadMondayPushSummary } from '../_lib/monday-push-queries'
import { PushAnalyticsSection } from './_components/push-analytics-section'
import { PushDetailSheet } from './_components/push-detail-sheet'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

/**
 * Monday Analytics — aggregated view over every mirrored board. Item
 * counts, sync freshness, mirror trend, per-board leaderboard, and
 * the S-tag → Monday match ratio for the selected window.
 *
 * Raw item list lives at /monday/leads and /monday/updates; this is
 * the "how healthy is the mirror + who has the biggest footprint"
 * view.
 */
export default async function MondayDashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const range = parseDateRange(sp.range)
  const [ana, matchStats, pushSummary] = await Promise.all([
    loadMondayAnalyticsData(range),
    loadStagMatchStats(range),
    loadMondayPushSummary(range),
  ])

  const totalItemsAllBoards = ana.boards.reduce((s, b) => s + b.totalItems, 0)
  const totalWindowItems = ana.boards.reduce((s, b) => s + b.itemsInWindow, 0)
  const staleBoards = ana.boards.filter(b => b.isStale).length
  const oldestAge = ana.boards.reduce<number | null>(
    (m, b) =>
      b.ageMinutes === null ? m : m === null || b.ageMinutes > m ? b.ageMinutes : m,
    null,
  )

  // Trend x-axis: hourly for Today, daily otherwise.
  const syncTrend =
    range.key === 'today'
      ? bucketByHourInDay(ana.syncedTimestamps, range.since)
      : bucketByDayInWindow(ana.syncedTimestamps, range.since, range.until)
  const syncHeatmap = bucketToHeatmap(ana.syncedTimestamps)

  const boardActivityRows = ana.boardActivityLeader.map(r => ({
    key: r.label,
    label: r.label,
    value: r.value,
  }))

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            Monday Analytics
          </h1>
          <p className="mt-0.5 max-w-3xl text-[12px] text-[color:var(--color-text-secondary)]">
            Aggregated view over the mirrored Monday.com boards. Raw item
            list lives at{' '}
            <Link
              href="/monday/leads"
              className="text-[color:var(--color-accent)] hover:underline"
            >
              Monday Data
            </Link>
            .
          </p>
        </div>
        <DateRangeToggle basePath="/monday-dashboard" active={range.key} />
      </header>

      <DashboardSection
        title={`Today's snapshot · ${range.label}`}
        hint="Click any card for the underlying rows or board detail."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Total items mirrored"
            value={totalItemsAllBoards}
            tone="emphasis"
            hint={`across ${ana.boards.length} boards`}
            drilldown={{
              title: 'Item counts by board',
              subtitle: `${ana.boards.length} boards · ${totalItemsAllBoards.toLocaleString()} rows`,
              body: <BoardBreakdownList boards={ana.boards} />,
            }}
          />
          <StatCard
            label={`Items synced · ${range.label}`}
            value={totalWindowItems}
            hint="synced_at falls inside the window"
            tone={totalWindowItems > 0 ? 'ok' : 'plain'}
          />
          <StatCard
            label="Boards stale (>24h)"
            value={staleBoards}
            tone={staleBoards > 0 ? 'warn' : 'ok'}
            hint={oldestAge !== null ? `oldest ${fmtAge(oldestAge)}` : ''}
            drilldown={{
              title: 'Board freshness detail',
              subtitle: `Boards last synced by our cron`,
              body: <BoardBreakdownList boards={ana.boards} showFreshness />,
            }}
          />
          <StatCard
            label="S-tag → Monday match"
            value={`${matchStats.matchPct}%`}
            hint={`${matchStats.matchedTags.toLocaleString()} of ${matchStats.totalTags.toLocaleString()}`}
            tone={matchStats.matchPct >= 50 ? 'ok' : 'warn'}
          />
        </div>
      </DashboardSection>

      <DashboardSection
        title={`Pushed to Monday · ${range.label}`}
        hint="Leads sent from this tool via the Push to Monday button. Click any number to see the actual leads and export as CSV."
      >
        <PushAnalyticsSection
          summary={pushSummary}
          rangeLabel={range.label}
          rangeKey={range.key}
        />
      </DashboardSection>

      <DashboardSection
        title={`Sync trend · ${range.label}`}
        hint="Items whose synced_at falls in the bucket. Solid line = total across all boards."
      >
        <TrendChart points={syncTrend} />
      </DashboardSection>

      <DashboardSection
        title="Day × hour sync heatmap"
        hint="Darker = more items mirrored at that day-of-week / hour-of-day (UTC). Spot when the nightly cron runs vs when Monday-side edits land."
      >
        <HeatMap data={syncHeatmap} />
      </DashboardSection>

      <div className="grid gap-4 lg:grid-cols-2">
        <DashboardSection title="Top boards · sync activity">
          <Leaderboard rows={boardActivityRows} valueLabel="Items synced" />
        </DashboardSection>
        <DashboardSection title="S-tag match ratio">
          <MatchRatioPanel matchStats={matchStats} />
        </DashboardSection>
      </div>

      <PushDetailSheet range={range.key} />
    </div>
  )
}

function BoardBreakdownList({
  boards,
  showFreshness = false,
}: {
  boards: BoardSnapshot[]
  showFreshness?: boolean
}) {
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr className="border-b border-[color:var(--color-border)] text-left text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          <th className="py-1.5">Board</th>
          <th className="py-1.5 text-right">Total items</th>
          <th className="py-1.5 text-right">In window</th>
          {showFreshness && <th className="py-1.5">Last synced</th>}
          {showFreshness && <th className="py-1.5">Age</th>}
        </tr>
      </thead>
      <tbody>
        {boards.map(b => (
          <tr key={b.key} className="border-b border-[color:var(--color-border)]/60 last:border-b-0">
            <td className="py-1.5 font-medium text-[color:var(--color-text-primary)]">
              {b.label}
              <div className="text-[10px] text-[color:var(--color-text-secondary)]">{b.itemsTable}</div>
            </td>
            <td className="py-1.5 text-right font-mono tabular-nums">{b.totalItems.toLocaleString()}</td>
            <td className="py-1.5 text-right font-mono tabular-nums">{b.itemsInWindow.toLocaleString()}</td>
            {showFreshness && (
              <td className="py-1.5 text-[11px] text-[color:var(--color-text-secondary)]">
                {b.latestSyncedAt ? new Date(b.latestSyncedAt).toLocaleString() : 'never'}
              </td>
            )}
            {showFreshness && (
              <td className="py-1.5">
                <span
                  className={[
                    'rounded-full px-2 py-0.5 text-[10px] font-medium',
                    b.isStale
                      ? 'bg-red-100 text-red-800'
                      : (b.ageMinutes ?? 0) > 6 * 60
                        ? 'bg-amber-100 text-amber-900'
                        : 'bg-emerald-100 text-emerald-800',
                  ].join(' ')}
                >
                  {b.ageMinutes === null ? '—' : fmtAge(b.ageMinutes)}
                </span>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function MatchRatioPanel({
  matchStats,
}: {
  matchStats: { matchedTags: number; unmatchedTags: number; totalTags: number; matchPct: number }
}) {
  const { matchedTags, unmatchedTags, totalTags, matchPct } = matchStats
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] text-[color:var(--color-text-secondary)]">
        Over{' '}
        <strong className="text-[color:var(--color-text-primary)]">
          {totalTags.toLocaleString()}
        </strong>{' '}
        S-tags extracted in this window,{' '}
        <strong className="text-emerald-700">{matchedTags.toLocaleString()}</strong> match a Monday
        item (<strong>{matchPct}%</strong>). The other{' '}
        <strong className="text-amber-700">{unmatchedTags.toLocaleString()}</strong> are pitch
        opportunities we don&apos;t have on Monday yet.
      </p>
      <div className="h-3 w-full overflow-hidden rounded-full bg-amber-100">
        <div
          className="h-full rounded-l-full bg-emerald-500"
          style={{ width: `${matchPct}%` }}
          title={`${matchedTags.toLocaleString()} matched`}
        />
      </div>
      <p className="text-[11px] text-[color:var(--color-text-secondary)]">
        Deeper drill-down (per-brand, per-user, per-country match rates) lives on the{' '}
        <Link
          href="/stag-mapping"
          className="text-[color:var(--color-accent)] hover:underline"
        >
          S-tag Mapping page
        </Link>
        .
      </p>
    </div>
  )
}

function fmtAge(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`
  const h = Math.floor(minutes / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}
