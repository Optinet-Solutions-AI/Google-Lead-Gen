import { Cpu, Loader2 } from 'lucide-react'
import { AutoRefresh } from '../scrape/_components/auto-refresh'
import {
  loadDashboardData,
  type WorkerSlot,
} from '../_lib/dashboard-queries'
import { parseDateRange } from '../_lib/date-range'
import { DateRangeToggle } from '../_components/dashboards/date-range-toggle'
import { PlaceholderPanel } from '../_components/dashboards/dashboard-section'

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
  const data = await loadDashboardData()

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

      <PlaceholderPanel
        title={`Bot activity heatmap · ${range.label}`}
        phase={3}
        note="Per-bot busy-vs-idle over the selected window — spot bots that are hammered vs bots that never claim, split by scrape / enrichment."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <PlaceholderPanel
          title="Captcha win rate per bot"
          phase={3}
          note="For each bot: how often 2Captcha auto-solves vs escalates to a human, so we spot bots stuck on a bad session."
        />
        <PlaceholderPanel
          title="Per-bot claim history"
          phase={3}
          note="Recent jobs claimed by each bot — quickly answer 'is this bot alive right now?' and 'what was it last doing?'"
        />
      </div>

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
