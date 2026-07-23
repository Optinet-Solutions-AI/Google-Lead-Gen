import Link from 'next/link'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  Database,
  Gauge,
  ListChecks,
  Loader2,
  Search,
  TrendingUp,
} from 'lucide-react'
import { AutoRefresh } from './scrape/_components/auto-refresh'
import { formatGb } from '@/lib/proxy-bandwidth'
import {
  loadDashboardData,
  type DashboardData,
  type Kpi,
  type ScrapeStats,
  type EnrichStats,
  type ProfileWarning,
  type ProxyBandwidth,
  type RecentBatch,
  type ActivityRow,
} from './_lib/dashboard-queries'
import { parseDateRange } from './_lib/date-range'
import { DateRangeToggle } from './_components/dashboards/date-range-toggle'
import { DashboardSection } from './_components/dashboards/dashboard-section'
import { StatCard } from './_components/dashboards/stat-card'
import { TrendChart } from './_components/dashboards/trend-chart'
import { HeatMap, bucketToHeatmap } from './_components/dashboards/heat-map'
import { Leaderboard } from './_components/dashboards/leaderboard'
import { loadSystemDashboardData } from './_lib/system-dashboard-queries'
import { bucketByDayInWindow, bucketByHourInDay } from './_lib/bucket-timestamps'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

/**
 * System Overview — the top-of-tree dashboard operators land on. Live
 * pipeline health at the top (KPIs, proxy bandwidth, per-engine scrape
 * stats), recent batches + activity in the middle. The Trend / Heatmap
 * / Leaderboard sections at the bottom are Phase 2 — placeholders
 * showing where they'll go.
 *
 * Worker cards moved to /operations — that's the bots dashboard now.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const range = parseDateRange(sp.range)
  const [data, sys] = await Promise.all([
    loadDashboardData(),
    loadSystemDashboardData(range),
  ])

  // Trend x-axis: hourly for "Today", daily for everything else.
  // Both variants use the same TrendChart component.
  const successTimestamps = sys.scrapesCreated
    .filter(r => r.status === 'completed' && r.completed_at)
    .map(r => r.completed_at!)
  const allTimestamps = sys.scrapesCreated.map(r => r.created_at)
  const trendPoints =
    range.key === 'today'
      ? bucketByHourInDay(allTimestamps, range.since, successTimestamps)
      : bucketByDayInWindow(allTimestamps, range.since, range.until, successTimestamps)

  // Heatmap uses scrape-created timestamps across the entire window
  // (day-of-week × hour-of-day) so a 30d/90d view surfaces the real
  // "when do captchas cluster" pattern.
  const heatCells = bucketToHeatmap(allTimestamps)

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            System Overview
          </h1>
          <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
            Live pipeline health + recent activity. Live bots and per-slot
            status live on{' '}
            <Link
              href="/operations"
              className="text-[color:var(--color-accent)] hover:underline"
            >
              Operations
            </Link>
            .
          </p>
        </div>
        <DateRangeToggle basePath="/" active={range.key} />
      </header>

      {data.proxyBandwidth?.isLow && !data.proxyBandwidth.stale && (
        <ProxyBandwidthLowBanner bw={data.proxyBandwidth} />
      )}

      <KpiStrip data={data} />
      <ProxyBandwidthCard bw={data.proxyBandwidth} />
      <PipelineHealth data={data} />

      <div className="grid gap-4 lg:grid-cols-2">
        <RecentBatches batches={data.recentBatches} />
        <RecentActivity activity={data.recentActivity} />
      </div>

      <TodaysPerformance sys={sys} range={range} />

      <DashboardSection
        title={`Activity trend · ${range.label}`}
        hint="Solid = all scrapes queued in the window. Dashed = subset that completed successfully."
      >
        {sys.truncated && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-900">
            Fetched the newest 5,000 rows in this window — trend shape is
            accurate for recent activity but the older tail may be
            under-counted.
          </p>
        )}
        <TrendChart points={trendPoints} />
      </DashboardSection>

      <DashboardSection
        title="Day × hour heatmap"
        hint="Darker = more scrapes at that day-of-week / hour-of-day (UTC). Spot when captchas cluster, when the fleet idles."
      >
        <HeatMap data={heatCells} />
      </DashboardSection>

      <div className="grid gap-4 lg:grid-cols-2">
        <DashboardSection title="Top users · successful scrapes">
          <Leaderboard rows={leaderRowsWithPct(sys.leaderboards.byUser)} valueLabel="Success" />
        </DashboardSection>
        <DashboardSection title="Top search engines">
          <Leaderboard rows={leaderRowsWithPct(sys.leaderboards.byEngine)} valueLabel="Success" />
        </DashboardSection>
        <DashboardSection title="Top countries">
          <Leaderboard rows={leaderRowsWithPct(sys.leaderboards.byCountry)} valueLabel="Success" />
        </DashboardSection>
        <DashboardSection title="Top keywords">
          <Leaderboard rows={leaderRowsWithPct(sys.leaderboards.byKeyword)} valueLabel="Success" />
        </DashboardSection>
      </div>

      <AutoRefresh enabled={data.hasActiveWork} />
    </div>
  )
}

// Worker cards + per-slot rendering moved to app/(dashboard)/operations/page.tsx
// as part of the dashboards refactor.

// ---------------------------------------------------------------------------
// Today's Performance — the 4-stat header on System Overview.
// ---------------------------------------------------------------------------

function TodaysPerformance({
  sys,
  range,
}: {
  sys: Awaited<ReturnType<typeof loadSystemDashboardData>>
  range: ReturnType<typeof parseDateRange>
}) {
  const total = sys.scrapesCreated.length
  const successPct = total > 0 ? Math.round((sys.successCount / total) * 100) : 0
  return (
    <DashboardSection
      title={`Performance · ${range.label}`}
      hint="Click any card for the underlying rows."
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Scrapes queued"
          value={total}
          tone="emphasis"
          drilldown={{
            title: 'Scrapes queued in this window',
            subtitle: `${range.label} · ${total} rows`,
            body: <ScrapeRowsList rows={sys.scrapesCreated.slice(0, 100)} />,
          }}
        />
        <StatCard
          label="Successful"
          value={sys.successCount}
          hint={`${successPct}% of total`}
          tone={successPct >= 60 ? 'ok' : successPct >= 30 ? 'plain' : 'warn'}
          drilldown={{
            title: 'Successful scrapes',
            subtitle: `${range.label} · ${sys.successCount} completed`,
            body: <ScrapeRowsList rows={sys.scrapesCreated.filter(r => r.status === 'completed').slice(0, 100)} />,
          }}
        />
        <StatCard
          label="Failed / Captcha"
          value={sys.failedCount}
          tone={sys.failedCount > 0 ? 'warn' : 'plain'}
          drilldown={{
            title: 'Failed + captcha-stuck scrapes',
            subtitle: `${range.label} · ${sys.failedCount} rows`,
            body: <ScrapeRowsList rows={sys.scrapesCreated.filter(r => r.status === 'failed' || r.status === 'captcha').slice(0, 100)} />,
          }}
        />
        <StatCard
          label="Still open"
          value={sys.openCount}
          hint="pending + running"
          tone={sys.openCount > 0 ? 'emphasis' : 'plain'}
          drilldown={{
            title: 'Still-open scrapes',
            subtitle: `${range.label} · ${sys.openCount} in flight`,
            body: <ScrapeRowsList rows={sys.scrapesCreated.filter(r => r.status === 'pending' || r.status === 'running').slice(0, 100)} />,
          }}
        />
      </div>
    </DashboardSection>
  )
}

function ScrapeRowsList({ rows }: { rows: Array<{ id: string; keyword: string | null; country_code: string | null; search_engine: string | null; status: string; created_at: string; created_by_display: string | null }> }) {
  if (rows.length === 0) return <p className="text-[12px] text-[color:var(--color-text-secondary)]">No rows.</p>
  return (
    <ul className="flex flex-col gap-1 text-[12px]">
      {rows.map(r => (
        <li key={r.id}>
          <Link
            href={`/scrape/${r.id}`}
            className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1 hover:bg-[color:var(--color-bg-secondary)]"
          >
            <span className="font-mono text-[10px] text-[color:var(--color-text-secondary)]">
              {r.country_code}/{r.search_engine}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-[color:var(--color-text-primary)]">
              {r.keyword ?? '(no keyword)'}
            </span>
            <span className="text-[10px] text-[color:var(--color-text-secondary)]">
              {r.created_by_display ?? '—'}
            </span>
            <span className="text-[10px] text-[color:var(--color-text-secondary)]">
              {new Date(r.created_at).toLocaleString()}
            </span>
            <span className="rounded-full bg-[color:var(--color-bg-secondary)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-text-secondary)]">
              {r.status}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function leaderRowsWithPct(entries: Array<{ label: string; value: number }>) {
  const total = entries.reduce((s, e) => s + e.value, 0)
  return entries.map(e => ({
    key: e.label,
    label: e.label,
    value: e.value,
    secondary: total > 0 ? `${Math.round((e.value / total) * 100)}%` : '',
  }))
}

// ---------------------------------------------------------------------------
// Proxy bandwidth
// ---------------------------------------------------------------------------

function ProxyBandwidthLowBanner({ bw }: { bw: ProxyBandwidth }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-rose-50 px-3 py-2 text-[12px] text-rose-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-700" />
      <div className="flex-1">
        <p>
          <strong>Proxy bandwidth is low — {formatGb(bw.remainingBytes)} left</strong> of the{' '}
          {formatGb(bw.limitBytes)} plan.
        </p>
        <p className="mt-0.5 text-[11px] text-rose-800">
          Top up the proxy plan soon — scrapes start failing with
          &ldquo;proxy ran out of bandwidth&rdquo; once it hits zero.
        </p>
      </div>
    </div>
  )
}

function ProxyBandwidthCard({ bw }: { bw: ProxyBandwidth | null }) {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          <Gauge className="h-3 w-3" />
          Proxy bandwidth
        </h2>
        {bw && (
          <span className="text-[10px] text-[color:var(--color-text-secondary)]">
            {bw.stale ? 'last reading ' : 'updated '}
            {fmtRelative(bw.capturedAt)}
          </span>
        )}
      </div>

      {!bw ? (
        <p className="py-3 text-[12px] text-[color:var(--color-text-secondary)]">
          Not measured yet — usage is read from Enigma every 5 minutes.
          The first reading will appear shortly after deploy.
        </p>
      ) : (
        <BandwidthMeter bw={bw} />
      )}
    </section>
  )
}

function BandwidthMeter({ bw }: { bw: ProxyBandwidth }) {
  const limit = bw.limitBytes > 0 ? bw.limitBytes : 1
  const usedPct = Math.min(100, Math.max(0, (bw.usedBytes / limit) * 100))
  const barCls = bw.isLow
    ? 'bg-rose-500'
    : usedPct >= 80
      ? 'bg-amber-500'
      : 'bg-emerald-500'

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[20px] font-semibold leading-none text-[color:var(--color-text-primary)]">
          {formatGb(bw.remainingBytes)}{' '}
          <span className="text-[12px] font-normal text-[color:var(--color-text-secondary)]">
            of {formatGb(bw.limitBytes)} remaining
          </span>
        </p>
        {bw.isLow && (
          <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-800">
            <AlertTriangle className="h-3 w-3" />
            Low
          </span>
        )}
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-[color:var(--color-bg-secondary)]">
        <div
          className={['h-full rounded-full transition-all', barCls].join(' ')}
          style={{ width: `${usedPct}%` }}
        />
      </div>

      <p className="text-[11px] text-[color:var(--color-text-secondary)]">
        {formatGb(bw.usedBytes)} used ({Math.round(usedPct)}%)
        {bw.lowThresholdBytes > 0 && (
          <> · warns below {formatGb(bw.lowThresholdBytes)}</>
        )}
        {bw.stale && (
          <span className="text-amber-700">
            {' '}· reading is stale — the bandwidth poller may not be running
          </span>
        )}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

function KpiStrip({ data }: { data: DashboardData }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        label="Total leads"
        value={fmt(data.kpiLeads.total)}
        icon={<ListChecks className="h-4 w-4" />}
      />
      <KpiCardWithDelta
        label="New · last 7 days"
        kpi={data.kpiLeads}
        icon={<TrendingUp className="h-4 w-4" />}
      />
      <KpiCardWithDelta
        label="Affiliates · last 7 days"
        kpi={data.kpiAffiliates}
        icon={<Search className="h-4 w-4" />}
      />
      <KpiCardWithDelta
        label="Rooster matches · 7d"
        kpi={data.kpiRooster}
        icon={<CheckCircle2 className="h-4 w-4" />}
      />
    </div>
  )
}

function KpiCard({
  label,
  value,
  icon,
}: {
  label: string
  value: string
  icon: React.ReactNode
}) {
  return (
    <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        <span>{label}</span>
        <span className="text-[color:var(--color-text-secondary)]">{icon}</span>
      </div>
      <p className="mt-2 text-[24px] font-semibold leading-none text-[color:var(--color-text-primary)]">
        {value}
      </p>
    </div>
  )
}

function KpiCardWithDelta({
  label,
  kpi,
  icon,
}: {
  label: string
  kpi: Kpi
  icon: React.ReactNode
}) {
  const delta = kpi.delta
  const positive = delta > 0
  const negative = delta < 0
  return (
    <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        <span>{label}</span>
        <span className="text-[color:var(--color-text-secondary)]">{icon}</span>
      </div>
      <p className="mt-2 text-[24px] font-semibold leading-none text-[color:var(--color-text-primary)]">
        {fmt(kpi.current)}
      </p>
      <p
        className={[
          'mt-1.5 inline-flex items-center gap-0.5 text-[11px]',
          positive ? 'text-emerald-700' : negative ? 'text-rose-700' : 'text-[color:var(--color-text-secondary)]',
        ].join(' ')}
      >
        {positive && <ArrowUpRight className="h-3 w-3" />}
        {negative && <ArrowDownRight className="h-3 w-3" />}
        {delta === 0 ? '—' : `${positive ? '+' : ''}${fmt(delta)}`}
        {kpi.deltaPct !== null && delta !== 0 && (
          <span className="text-[color:var(--color-text-secondary)]"> ({positive ? '+' : ''}{kpi.deltaPct}%)</span>
        )}
        <span className="text-[color:var(--color-text-secondary)]"> vs prev 7d</span>
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pipeline health
// ---------------------------------------------------------------------------

function PipelineHealth({ data }: { data: DashboardData }) {
  return (
    <section className="flex flex-col gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <h2 className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        Pipeline health
      </h2>

      {data.profileWarnings.length > 0 && <ProfileWarningRow warnings={data.profileWarnings} />}
      <ScrapeQueueRow stats={data.scrape} />
      <EnrichmentQueueRow stats={data.enrich} />
    </section>
  )
}

function ProfileWarningRow({ warnings }: { warnings: ProfileWarning[] }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
      <div className="flex-1">
        <p>
          <strong>{warnings.length} country profile{warnings.length === 1 ? '' : 's'}</strong>{' '}
          require Google login but aren&apos;t signed in:{' '}
          <span className="font-medium">
            {warnings.map(w => `${w.country_name} (${w.country_code})`).join(', ')}
          </span>
        </p>
        <p className="mt-0.5 text-[11px] text-amber-800">
          PPC ads may not render reliably for those countries.{' '}
          <Link href="/profiles" className="underline underline-offset-2">
            Manage profiles →
          </Link>
        </p>
      </div>
    </div>
  )
}

function ScrapeQueueRow({ stats }: { stats: ScrapeStats }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[12px]">
      <Search className="h-4 w-4 text-[color:var(--color-text-secondary)]" />
      <span className="text-[color:var(--color-text-secondary)]">Scrape:</span>
      <Stat label="running" value={stats.running} cls="bg-amber-100 text-amber-800" />
      <Stat label="pending now" value={stats.pending} cls="bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-primary)]" />
      <Stat label="scheduled" value={stats.scheduled_future} cls="bg-sky-100 text-sky-800" icon={<CalendarClock className="h-3 w-3" />} />
      <Stat label="failed 24h" value={stats.failed_24h} cls="bg-rose-100 text-rose-800" />
      <Stat label="captcha 24h" value={stats.captcha_24h} cls="bg-orange-100 text-orange-800" />
      <Link
        href="/scrape"
        className="ml-auto text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
      >
        View all →
      </Link>
    </div>
  )
}

function EnrichmentQueueRow({ stats }: { stats: EnrichStats }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[12px]">
      <Database className="h-4 w-4 text-[color:var(--color-text-secondary)]" />
      <span className="text-[color:var(--color-text-secondary)]">Enrichment:</span>
      <Stat label="running" value={stats.running} cls="bg-amber-100 text-amber-800" />
      <Stat label="pending" value={stats.pending} cls="bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-primary)]" />
      <Stat label="failed 24h" value={stats.failed_24h} cls="bg-rose-100 text-rose-800" />
    </div>
  )
}

function Stat({
  label,
  value,
  cls,
  icon,
}: {
  label: string
  value: number
  cls: string
  icon?: React.ReactNode
}) {
  return (
    <span className={['inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium', cls].join(' ')}>
      {icon}
      <span>{fmt(value)}</span>
      <span className="opacity-75">{label}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Recent batches
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
  running: 'bg-amber-100 text-amber-800',
  completed: 'bg-emerald-100 text-emerald-800',
  failed: 'bg-rose-100 text-rose-800',
  captcha: 'bg-orange-100 text-orange-800',
}

const ENRICHMENT_LABELS: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Enrich pending', cls: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]' },
  affiliate_running: { label: 'Affiliate running', cls: 'bg-amber-100 text-amber-800' },
  all_running: { label: 'Stages running', cls: 'bg-sky-100 text-sky-800' },
  complete: { label: 'Enriched', cls: 'bg-emerald-100 text-emerald-800' },
  failed: { label: 'Enrich failed', cls: 'bg-rose-100 text-rose-800' },
}

function RecentBatches({ batches }: { batches: RecentBatch[] }) {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Recent batches
        </h2>
        <Link href="/scrape" className="text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]">
          View all →
        </Link>
      </div>
      {batches.length === 0 && (
        <p className="py-6 text-center text-[12px] text-[color:var(--color-text-secondary)]">
          No batches yet.
        </p>
      )}
      <ul className="flex flex-col">
        {batches.map(b => (
          <li key={b.id}>
            <Link
              href={`/scrape/${b.id}`}
              className="flex flex-wrap items-center gap-2 border-b border-[color:var(--color-border)] py-2 text-[12px] hover:bg-[color:var(--color-bg-secondary)] last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate font-medium text-[color:var(--color-text-primary)]" title={b.keyword}>
                {b.keyword}
              </span>
              <span className="text-[10px] text-[color:var(--color-text-secondary)]">{b.country_code}</span>
              <span className={['rounded-full px-2 py-0.5 text-[10px] font-medium', STATUS_STYLES[b.status] ?? ''].join(' ')}>
                {b.status === 'running' && <Loader2 className="mr-0.5 inline-block h-3 w-3 animate-spin" />}
                {b.status}
              </span>
              {b.with_enrichment && b.enrichment_status && (() => {
                const meta = ENRICHMENT_LABELS[b.enrichment_status]
                if (!meta) return null
                return (
                  <span className={['rounded-full px-2 py-0.5 text-[10px] font-medium', meta.cls].join(' ')}>
                    {meta.label}
                  </span>
                )
              })()}
              <span className="text-[10px] text-[color:var(--color-text-secondary)]">
                {fmtRelative(b.completed_at ?? b.scheduled_at ?? b.created_at)}
                {b.scheduled_at && !b.completed_at && b.status === 'pending' && (
                  <span> (scheduled)</span>
                )}
              </span>
              {totalResults(b.result_summary) !== null && (
                <span className="rounded-full bg-[color:var(--color-bg-secondary)] px-2 py-0.5 text-[10px] text-[color:var(--color-text-secondary)]">
                  {totalResults(b.result_summary)} results
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

const ACTION_STYLES: Record<string, string> = {
  scrape: 'bg-amber-100 text-amber-800',
  enrichment: 'bg-sky-100 text-sky-800',
  override: 'bg-rose-100 text-rose-800',
  brand: 'bg-purple-100 text-purple-800',
  schedule: 'bg-emerald-100 text-emerald-800',
  profile: 'bg-zinc-200 text-zinc-700',
  screenshot: 'bg-orange-100 text-orange-800',
}

function RecentActivity({ activity }: { activity: ActivityRow[] }) {
  return (
    <section className="flex flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Recent activity
        </h2>
        <Link href="/activity" className="text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]">
          View all →
        </Link>
      </div>
      {activity.length === 0 && (
        <p className="py-6 text-center text-[12px] text-[color:var(--color-text-secondary)]">
          No activity yet.
        </p>
      )}
      <ul className="flex flex-col">
        {activity.map(a => {
          const family = a.action.split('.')[0] ?? ''
          const cls = ACTION_STYLES[family] ?? 'bg-zinc-200 text-zinc-700'
          return (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-2 border-b border-[color:var(--color-border)] py-2 text-[12px] last:border-b-0"
            >
              <span className={['rounded-full px-2 py-0.5 text-[10px] font-medium', cls].join(' ')}>
                {a.action}
              </span>
              <span className="text-[color:var(--color-text-secondary)]">{a.user_email ?? 'system'}</span>
              {a.entity_type && a.entity_id && (
                <span className="text-[color:var(--color-text-secondary)]">
                  · {a.entity_type}:{a.entity_id.length > 16 ? a.entity_id.slice(0, 16) + '…' : a.entity_id}
                </span>
              )}
              <span className="ml-auto text-[10px] text-[color:var(--color-text-secondary)]">
                {fmtRelative(a.created_at)}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString()
}

function totalResults(summary: { total_results?: number } | null): number | null {
  if (!summary) return null
  const v = summary.total_results
  return typeof v === 'number' ? v : null
}

function fmtRelative(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const diff = Date.now() - t
  const future = diff < 0
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60_000)
  if (mins < 1) return future ? 'soon' : 'just now'
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return future ? `in ${hrs}h` : `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return future ? `in ${days}d` : `${days}d ago`
}
