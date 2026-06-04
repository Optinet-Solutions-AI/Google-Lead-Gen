import { redirect } from 'next/navigation'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

// ---------------------------------------------------------------------------
// Shape returned by the get_ops_dashboard() RPC (see migration
// 20260604130000_ops_dashboard_rpc.sql). All aggregation is done DB-side;
// this page only formats.
// ---------------------------------------------------------------------------
type Counts = Record<string, number>
type EngineRow = { engine: string; status: string; count: number }
type FailReason = { reason: string; count: number }
type WorkerRow = {
  worker_id: string
  kind: 'scrape' | 'enrichment'
  jobs_1h: number
  jobs_24h: number
  last_claim: string | null
}
type OpsData = {
  generated_at: string
  scrape: { by_status: Counts; by_engine: EngineRow[]; total_7d: number; total_24h: number }
  enrichment: {
    by_status: Counts
    fail_reasons: FailReason[]
    fail_rate_7d: number
    total_7d: number
    total_24h: number
  }
  checkpoints: {
    by_status: Counts
    by_reason: Counts
    by_resolution: Counts
    resolve_rate_7d: number
    median_resolve_seconds: number | null
    total_7d: number
  }
  workers: WorkerRow[]
}

// Status → colour intent. Keeps the badge palette consistent across sections.
const GOOD = new Set(['completed', 'resolved', 'running'])
const BAD = new Set(['failed', 'captcha', 'timed_out'])

function relTime(from: string, to: string): string {
  const ms = new Date(from).getTime() - new Date(to).getTime()
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 90) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 90) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
      <header className="mb-3">
        <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">{title}</h2>
        {hint ? (
          <p className="mt-1 max-w-3xl text-[11px] text-[color:var(--color-text-secondary)]">{hint}</p>
        ) : null}
      </header>
      {children}
    </section>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' | 'warn' }) {
  const color =
    tone === 'bad'
      ? 'text-[color:var(--color-danger,#dc2626)]'
      : tone === 'warn'
        ? 'text-[color:var(--color-warning,#d97706)]'
        : 'text-[color:var(--color-text-primary)]'
  return (
    <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-3 py-2">
      <div className={`text-[18px] font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-[color:var(--color-text-secondary)]">{label}</div>
    </div>
  )
}

// A row of status:count chips, coloured by intent.
function StatusChips({ counts }: { counts: Counts }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (entries.length === 0)
    return <p className="text-[11px] text-[color:var(--color-text-secondary)]">No jobs in window.</p>
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([status, count]) => {
        const tone = GOOD.has(status)
          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
          : BAD.has(status)
            ? 'bg-red-500/15 text-red-600 dark:text-red-400'
            : 'bg-[color:var(--color-accent)]/15 text-[color:var(--color-text-primary)]'
        return (
          <span
            key={status}
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${tone}`}
          >
            {status} <span className="font-semibold">{count}</span>
          </span>
        )
      })}
    </div>
  )
}

export default async function AdminOpsPage() {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?from=/admin/ops')

  const svc = createServiceClient()
  const { data: callerIsAdmin } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (!callerIsAdmin) redirect('/')

  const { data, error } = await svc.rpc('get_ops_dashboard')

  // The RPC is deployed via the manual SQL-editor migration flow. If it
  // hasn't been applied yet, render a clear instruction instead of a 500.
  if (error || !data) {
    return (
      <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
        <header>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">Ops</h1>
        </header>
        <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
          <p className="text-[12px] text-[color:var(--color-text-primary)]">
            The <code>get_ops_dashboard()</code> function isn&apos;t available yet. Apply migration{' '}
            <code>20260604130000_ops_dashboard_rpc.sql</code> in the Supabase SQL editor, then reload.
          </p>
          {error ? (
            <p className="mt-2 text-[11px] text-[color:var(--color-text-secondary)]">{error.message}</p>
          ) : null}
        </section>
      </div>
    )
  }

  const ops = data as OpsData
  const now = ops.generated_at

  // Pivot scrape by_engine into engine → {status: count}.
  const engineMap = new Map<string, Counts>()
  for (const r of ops.scrape.by_engine) {
    const m = engineMap.get(r.engine) ?? {}
    m[r.status] = r.count
    engineMap.set(r.engine, m)
  }

  const enr = ops.enrichment
  const ck = ops.checkpoints
  const failTone = enr.fail_rate_7d >= 25 ? 'bad' : enr.fail_rate_7d >= 10 ? 'warn' : 'good'
  const resolveTone = ck.resolve_rate_7d < 25 ? 'bad' : ck.resolve_rate_7d < 60 ? 'warn' : 'good'

  // Workers idle for >2h (or 0 jobs in the last hour despite recent history)
  // are the silent-death signal — surface them, don't bury them.
  const STALE_MS = 2 * 60 * 60 * 1000
  const workers = [...ops.workers].sort((a, b) => {
    const at = a.last_claim ? new Date(a.last_claim).getTime() : 0
    const bt = b.last_claim ? new Date(b.last_claim).getTime() : 0
    return at - bt // stalest first
  })

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">Ops</h1>
        <p className="mt-0.5 max-w-3xl text-[12px] text-[color:var(--color-text-secondary)]">
          Queue health, enrichment failures, captcha-checkpoint resolution, and per-worker
          liveness. Breakdowns cover the last 7 days; worker liveness the last 30. Snapshot at{' '}
          {new Date(now).toISOString().replace('T', ' ').slice(0, 19)} UTC — reload to refresh.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Scrape jobs · 24h" value={String(ops.scrape.total_24h)} />
        <Stat label="Scrape jobs · 7d" value={String(ops.scrape.total_7d)} />
        <Stat label="Enrich jobs · 24h" value={String(enr.total_24h)} />
        <Stat label="Enrich fail rate · 7d" value={`${enr.fail_rate_7d}%`} tone={failTone} />
        <Stat label="Checkpoint resolve · 7d" value={`${ck.resolve_rate_7d}%`} tone={resolveTone} />
        <Stat
          label="Median resolve"
          value={ck.median_resolve_seconds != null ? `${Math.round(ck.median_resolve_seconds / 60)}m` : '—'}
        />
      </div>

      <Card title="Worker liveness" hint="Per worker that has claimed a job in the last 30 days. Stalest first — a worker with an old last-claim and 0 recent jobs is the silent-death tell.">
        {workers.length === 0 ? (
          <p className="text-[11px] text-[color:var(--color-text-secondary)]">No worker activity recorded.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                  <th className="py-1 pr-4 font-semibold">Worker</th>
                  <th className="py-1 pr-4 font-semibold">Kind</th>
                  <th className="py-1 pr-4 font-semibold tabular-nums">Jobs 1h</th>
                  <th className="py-1 pr-4 font-semibold tabular-nums">Jobs 24h</th>
                  <th className="py-1 pr-4 font-semibold">Last claim</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[color:var(--color-border)]">
                {workers.map((w) => {
                  const lastMs = w.last_claim ? new Date(now).getTime() - new Date(w.last_claim).getTime() : Infinity
                  const stale = lastMs > STALE_MS
                  return (
                    <tr key={`${w.kind}:${w.worker_id}`} className={stale ? 'text-red-600 dark:text-red-400' : ''}>
                      <td className="py-1.5 pr-4 font-medium">{w.worker_id}</td>
                      <td className="py-1.5 pr-4 text-[color:var(--color-text-secondary)]">{w.kind}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{w.jobs_1h}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{w.jobs_24h}</td>
                      <td className="py-1.5 pr-4 tabular-nums">
                        {w.last_claim ? relTime(now, w.last_claim) : '—'}
                        {stale ? <span className="ml-1.5 font-semibold">⚠ stale</span> : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Scrape queue · by status (7d)">
          <StatusChips counts={ops.scrape.by_status} />
          <div className="mt-3 space-y-1.5">
            {[...engineMap.entries()]
              .sort((a, b) => {
                const sum = (m: Counts) => Object.values(m).reduce((x, y) => x + y, 0)
                return sum(b[1]) - sum(a[1])
              })
              .map(([engine, m]) => (
                <div key={engine} className="flex items-center gap-2">
                  <span className="w-20 shrink-0 text-[11px] font-medium text-[color:var(--color-text-secondary)]">
                    {engine}
                  </span>
                  <StatusChips counts={m} />
                </div>
              ))}
          </div>
        </Card>

        <Card title="Enrichment queue · by status (7d)">
          <StatusChips counts={enr.by_status} />
          <p className="mt-3 text-[11px] text-[color:var(--color-text-secondary)]">
            Failure rate (of completed+failed): <span className="font-semibold tabular-nums">{enr.fail_rate_7d}%</span>
          </p>
        </Card>
      </div>

      <Card title="Top enrichment failure reasons (7d)" hint="Grouped by the first 80 chars of the error message. A single dominant row usually means an application bug, not infra capacity.">
        {enr.fail_reasons.length === 0 ? (
          <p className="text-[11px] text-[color:var(--color-text-secondary)]">No enrichment failures in window.</p>
        ) : (
          <ul className="space-y-1">
            {enr.fail_reasons.map((f, i) => (
              <li key={i} className="flex items-baseline gap-3 text-[12px]">
                <span className="w-12 shrink-0 text-right font-semibold tabular-nums text-red-600 dark:text-red-400">
                  {f.count}
                </span>
                <code className="min-w-0 break-words text-[11px] text-[color:var(--color-text-primary)]">{f.reason}</code>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Captcha checkpoints (7d)" hint="Resolution of captcha / login walls parked for the operator. A low resolve rate means walls are timing out unhandled — expand auto-solve coverage or staff the noVNC portal.">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              Status
            </h3>
            <StatusChips counts={ck.by_status} />
          </div>
          <div>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              Reason
            </h3>
            <StatusChips counts={ck.by_reason} />
          </div>
          <div>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              Resolved by
            </h3>
            <StatusChips counts={ck.by_resolution} />
          </div>
        </div>
        <p className="mt-3 text-[11px] text-[color:var(--color-text-secondary)]">
          Resolve rate <span className="font-semibold tabular-nums">{ck.resolve_rate_7d}%</span> · median resolve{' '}
          <span className="font-semibold tabular-nums">
            {ck.median_resolve_seconds != null ? `${Math.round(ck.median_resolve_seconds)}s` : '—'}
          </span>{' '}
          · {ck.total_7d} total
        </p>
      </Card>
    </div>
  )
}
