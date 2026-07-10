import Link from 'next/link'
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  Cpu,
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
  type WorkerSlot,
} from './_lib/dashboard-queries'

export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const data = await loadDashboardData()

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Dashboard
        </h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
          Pipeline status, recent activity, and the numbers that matter for the last 7 days.
        </p>
      </header>

      {data.proxyBandwidth?.isLow && !data.proxyBandwidth.stale && (
        <ProxyBandwidthLowBanner bw={data.proxyBandwidth} />
      )}

      <KpiStrip data={data} />
      <ProxyBandwidthCard bw={data.proxyBandwidth} />
      <PipelineHealth data={data} />
      <Workers workers={data.workers} />

      <div className="grid gap-4 lg:grid-cols-2">
        <RecentBatches batches={data.recentBatches} />
        <RecentActivity activity={data.recentActivity} />
      </div>

      <AutoRefresh enabled={data.hasActiveWork} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

function Workers({ workers }: { workers: WorkerSlot[] }) {
  const busyCount = workers.filter(w => w.busy).length
  return (
    <section className="flex flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          <Cpu className="h-3 w-3" />
          Workers ({busyCount} of {workers.length} busy)
        </h2>
        <span className="text-[10px] text-[color:var(--color-text-secondary)]">
          refreshes every 5 s while there&apos;s active work
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {workers.map(w => <WorkerCard key={w.worker_id} worker={w} />)}
      </div>
    </section>
  )
}

function WorkerCard({ worker }: { worker: WorkerSlot }) {
  const { busy, current, kind, worker_id, port } = worker
  const kindCls = kind === 'scrape'
    ? 'bg-amber-100 text-amber-800'
    : 'bg-sky-100 text-sky-800'
  const stages = current?.process_stages ?? null

  return (
    <div
      className={[
        'flex flex-col gap-1.5 rounded-md border px-3 py-2 text-[12px]',
        busy
          ? 'border-emerald-300 bg-emerald-50/40'
          : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]/40',
      ].join(' ')}
    >
      <div className="flex items-center gap-2">
        <span className={['rounded-full px-2 py-0.5 text-[10px] font-medium', kindCls].join(' ')}>
          {kind}
        </span>
        <span className="font-mono text-[11px] text-[color:var(--color-text-primary)]">
          {worker_id}
        </span>
        <span className="text-[10px] text-[color:var(--color-text-secondary)]">port {port}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10px]">
          {busy ? (
            <>
              <Loader2 className="h-3 w-3 animate-spin text-emerald-600" />
              <span className="text-emerald-700">busy</span>
            </>
          ) : (
            <>
              <span className="inline-block h-2 w-2 rounded-full bg-[color:var(--color-text-secondary)]/50" />
              <span className="text-[color:var(--color-text-secondary)]">idle</span>
            </>
          )}
        </span>
      </div>

      {busy && current ? (
        <>
          <p className="truncate text-[11px] text-[color:var(--color-text-primary)]" title={current.keyword ?? current.url ?? ''}>
            {current.keyword ?? current.url ?? '—'}
          </p>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[color:var(--color-text-secondary)]">
            <span className="rounded-full bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5">
              {current.country_code}
            </span>
            {stages && stages.length > 0 && (
              <span className="rounded-full bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5">
                {stages.join(' + ')}
              </span>
            )}
            <span>{fmtElapsed(current.started_at)}</span>
          </div>
        </>
      ) : (
        <p className="text-[10px] text-[color:var(--color-text-secondary)]">vacant — waiting for work</p>
      )}
    </div>
  )
}

function fmtElapsed(iso: string | null): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (secs < 60) return `${secs}s elapsed`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return `${mins}m ${rem}s elapsed`
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
