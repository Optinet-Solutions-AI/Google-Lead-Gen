import Link from 'next/link'
import { Cpu, Loader2 } from 'lucide-react'
import { AutoRefresh } from '../scrape/_components/auto-refresh'
import {
  loadDashboardData,
  type WorkerSlot,
} from '../_lib/dashboard-queries'
import { parseDateRange } from '../_lib/date-range'
import { DateRangeToggle } from '../_components/dashboards/date-range-toggle'
import { DashboardSection } from '../_components/dashboards/dashboard-section'
import { StatCard } from '../_components/dashboards/stat-card'
import { HeatMap } from '../_components/dashboards/heat-map'
import { Leaderboard } from '../_components/dashboards/leaderboard'
import { loadOperationsData, type PerBotStats } from '../_lib/operations-dashboard-queries'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

/**
 * Operations Dashboard — the fleet's live worker/bot status. Lifted
 * from the old Overview page in the dashboards refactor. Phase 1
 * ships the current-state card grid; Phase 3 adds the per-bot
 * activity heatmap, claim history, captcha win rate, and admin
 * restart controls.
 */
export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams
  const range = parseDateRange(sp.range)
  const [data, ops] = await Promise.all([
    loadDashboardData(),
    loadOperationsData(range),
  ])

  const totalClaims = ops.perBot.reduce((s, b) => s + b.claimsTotal, 0)
  const totalSuccess = ops.perBot.reduce((s, b) => s + b.claimsCompleted, 0)
  const totalCaptchaSolvedAuto = ops.perBot.reduce((s, b) => s + b.captchaAutoSolved, 0)
  const totalCaptchaSolvedHuman = ops.perBot.reduce((s, b) => s + b.captchaHumanSolved, 0)
  const totalCaptchaTimedOut = ops.perBot.reduce((s, b) => s + b.captchaTimedOut, 0)
  const successPct = totalClaims > 0 ? Math.round((totalSuccess / totalClaims) * 100) : 0
  const totalCheckpoints = totalCaptchaSolvedAuto + totalCaptchaSolvedHuman + totalCaptchaTimedOut
  const autoSolvePct =
    totalCheckpoints > 0 ? Math.round((totalCaptchaSolvedAuto / totalCheckpoints) * 100) : 0

  const perBotClaimsLeader = ops.perBot
    .filter(b => b.claimsTotal > 0)
    .sort((a, b) => b.claimsTotal - a.claimsTotal)
    .slice(0, 12)
    .map(b => ({
      key: b.workerId,
      label: b.label,
      value: b.claimsTotal,
      secondary: `${b.successPct}% success · ${b.claimsCompleted} done`,
    }))
  const perBotCaptchaLeader = ops.perBot
    .filter(b => b.captchaAutoSolved + b.captchaHumanSolved + b.captchaTimedOut > 0)
    .sort(
      (a, b) =>
        b.captchaAutoSolved + b.captchaHumanSolved + b.captchaTimedOut -
        (a.captchaAutoSolved + a.captchaHumanSolved + a.captchaTimedOut),
    )
    .slice(0, 12)
    .map(b => ({
      key: `${b.workerId}-captcha`,
      label: b.label,
      value: b.captchaAutoSolved + b.captchaHumanSolved + b.captchaTimedOut,
      secondary: `${b.autoSolvePct}% auto-solved · ${b.captchaTimedOut} timed out`,
    }))

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            Operations
          </h1>
          <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
            Live status of every scraper + enrichment bot in the fleet. Cards
            refresh every 5 s while there&apos;s active work.
          </p>
        </div>
        <DateRangeToggle basePath="/operations" active={range.key} />
      </header>

      <Workers workers={data.workers} />

      <DashboardSection
        title={`Fleet performance · ${range.label}`}
        hint="Click any card for the underlying rows."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Total claims"
            value={totalClaims}
            tone="emphasis"
            hint={`across ${ops.perBot.length} bots`}
            drilldown={{
              title: 'Recent claims across the fleet',
              subtitle: `${range.label} · ${totalClaims.toLocaleString()} total`,
              body: <ClaimsList rows={ops.recentClaims} />,
            }}
          />
          <StatCard
            label="Successful"
            value={totalSuccess}
            hint={`${successPct}% of claims`}
            tone={successPct >= 60 ? 'ok' : successPct >= 30 ? 'plain' : 'warn'}
          />
          <StatCard
            label="Captchas auto-solved"
            value={totalCaptchaSolvedAuto}
            hint={`${autoSolvePct}% of captchas hit`}
            tone={autoSolvePct >= 50 ? 'ok' : 'plain'}
          />
          <StatCard
            label="Captchas human-solved"
            value={totalCaptchaSolvedHuman}
            hint={`${totalCaptchaTimedOut} timed out`}
            tone={totalCaptchaTimedOut > totalCaptchaSolvedHuman ? 'warn' : 'plain'}
          />
        </div>
      </DashboardSection>

      <DashboardSection
        title={`Fleet activity heatmap · ${range.label}`}
        hint="Darker = more claims at that day-of-week / hour-of-day (UTC). Spot when the fleet is hammered vs idle."
      >
        <HeatMap data={ops.activityHeatmap} />
      </DashboardSection>

      <div className="grid gap-4 lg:grid-cols-2">
        <DashboardSection title="Top bots · by claim volume">
          <Leaderboard rows={perBotClaimsLeader} valueLabel="Claims" />
        </DashboardSection>
        <DashboardSection title="Top bots · by captchas hit">
          <Leaderboard rows={perBotCaptchaLeader} valueLabel="Captchas" />
        </DashboardSection>
      </div>

      <DashboardSection
        title="Per-bot detail"
        hint="All bots in the fleet — includes idle bots with 0 claims in the window so you can spot which ones haven't been picking up work."
      >
        <PerBotTable bots={ops.perBot} />
      </DashboardSection>

      <AutoRefresh enabled={data.hasActiveWork} />
    </div>
  )
}

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
        {workers.map(w => (
          <WorkerCard key={w.worker_id} worker={w} />
        ))}
      </div>
    </section>
  )
}

function WorkerCard({ worker }: { worker: WorkerSlot }) {
  const { busy, current, kind, worker_id, label, port } = worker
  const kindCls =
    kind === 'scrape'
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
        <span
          className={['rounded-full px-2 py-0.5 text-[10px] font-medium', kindCls].join(' ')}
        >
          {kind}
        </span>
        <span
          className="text-[11px] font-medium text-[color:var(--color-text-primary)]"
          title={worker_id}
        >
          {label}
        </span>
        <span className="text-[10px] text-[color:var(--color-text-secondary)]">
          port {port}
        </span>
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
          <p
            className="truncate text-[11px] text-[color:var(--color-text-primary)]"
            title={current.keyword ?? current.url ?? ''}
          >
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
        <p className="text-[10px] text-[color:var(--color-text-secondary)]">
          vacant — waiting for work
        </p>
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

function ClaimsList({
  rows,
}: {
  rows: Array<{
    id: string
    keyword: string | null
    country_code: string | null
    search_engine: string | null
    status: string
    claimed_by: string | null
    started_at: string | null
    created_by_display: string | null
  }>
}) {
  if (rows.length === 0)
    return <p className="text-[12px] text-[color:var(--color-text-secondary)]">No claims.</p>
  return (
    <ul className="flex flex-col gap-1 text-[12px]">
      {rows.map(r => (
        <li key={r.id}>
          <Link
            href={`/scrape/${r.id}`}
            className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1 hover:bg-[color:var(--color-bg-secondary)]"
          >
            <span className="font-mono text-[10px] text-[color:var(--color-text-secondary)]">
              {r.claimed_by}
            </span>
            <span className="font-mono text-[10px] text-[color:var(--color-text-secondary)]">
              {r.country_code}/{r.search_engine}
            </span>
            <span className="min-w-0 flex-1 truncate font-medium text-[color:var(--color-text-primary)]">
              {r.keyword ?? '(no keyword)'}
            </span>
            <span className="text-[10px] text-[color:var(--color-text-secondary)]">
              {r.created_by_display ?? '—'}
            </span>
            <span className="rounded-full bg-[color:var(--color-bg-secondary)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-text-secondary)]">
              {r.status}
            </span>
            <span className="text-[10px] text-[color:var(--color-text-secondary)]">
              {r.started_at ? new Date(r.started_at).toLocaleString() : ''}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function PerBotTable({ bots }: { bots: PerBotStats[] }) {
  const sorted = [...bots].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'scrape' ? -1 : 1
    return b.claimsTotal - a.claimsTotal
  })
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-[color:var(--color-border)] text-left text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
            <th className="py-1.5">Bot</th>
            <th className="py-1.5">Kind</th>
            <th className="py-1.5 text-right">Claims</th>
            <th className="py-1.5 text-right">Done</th>
            <th className="py-1.5 text-right">Failed</th>
            <th className="py-1.5 text-right">Success %</th>
            <th className="py-1.5 text-right">Captcha auto</th>
            <th className="py-1.5 text-right">Captcha human</th>
            <th className="py-1.5 text-right">Captcha timeout</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(b => (
            <tr
              key={b.workerId}
              className="border-b border-[color:var(--color-border)]/60 last:border-b-0"
            >
              <td className="py-1.5 font-medium text-[color:var(--color-text-primary)]" title={b.workerId}>
                {b.label}
              </td>
              <td className="py-1.5 text-[10px] text-[color:var(--color-text-secondary)]">
                <span
                  className={[
                    'rounded-full px-2 py-0.5',
                    b.kind === 'scrape' ? 'bg-amber-100 text-amber-800' : 'bg-sky-100 text-sky-800',
                  ].join(' ')}
                >
                  {b.kind}
                </span>
              </td>
              <td className="py-1.5 text-right font-mono tabular-nums">{b.claimsTotal.toLocaleString()}</td>
              <td className="py-1.5 text-right font-mono tabular-nums text-emerald-700">{b.claimsCompleted.toLocaleString()}</td>
              <td className="py-1.5 text-right font-mono tabular-nums text-red-700">{b.claimsFailed.toLocaleString()}</td>
              <td className="py-1.5 text-right font-mono tabular-nums">
                {b.claimsTotal > 0 ? `${b.successPct}%` : '—'}
              </td>
              <td className="py-1.5 text-right font-mono tabular-nums text-indigo-700">{b.captchaAutoSolved.toLocaleString()}</td>
              <td className="py-1.5 text-right font-mono tabular-nums">{b.captchaHumanSolved.toLocaleString()}</td>
              <td className="py-1.5 text-right font-mono tabular-nums text-red-700">{b.captchaTimedOut.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
