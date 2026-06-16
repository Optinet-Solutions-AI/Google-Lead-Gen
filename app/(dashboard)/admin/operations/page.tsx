import { redirect } from 'next/navigation'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { BYTES_PER_GB, loadOperationsData } from './_lib/queries'
import { CostRow } from './_components/cost-row'

export const dynamic = 'force-dynamic'

export default async function OperationsPage() {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?from=/admin/operations')

  const svc = createServiceClient()
  const { data: isAdmin } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (!isAdmin) redirect('/')

  const data = await loadOperationsData()
  const latest = data.latest

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Operations
        </h1>
        <p className="mt-0.5 max-w-3xl text-[12px] text-[color:var(--color-text-secondary)]">
          Live view of bandwidth consumption + estimated operational cost.
          Read-only against active scrapes — opening this page never touches
          the queue.
        </p>
      </header>

      {/* ---------- Bandwidth status ---------- */}
      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <header className="mb-3">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Proxy bandwidth
          </h2>
          <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">
            EnigmaProxy residential plan, polled by{' '}
            <code>/api/proxy/bandwidth/refresh</code>.
          </p>
        </header>

        {latest === null ? (
          <p className="text-[12px] text-[color:var(--color-text-secondary)]">
            No snapshot recorded yet — wait for the next cron tick (or hit{' '}
            <code>/api/proxy/bandwidth/refresh</code> with the CRON_SECRET).
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Stat
              label="Used (latest snapshot)"
              value={fmtGB(latest.used_bytes)}
              hint={`Plan limit: ${fmtGB(latest.limit_bytes)}`}
            />
            <Stat
              label="Remaining"
              value={fmtGB(latest.remaining_bytes)}
              hint={fmtDateTime(latest.captured_at)}
              tone={latest.is_low ? 'warn' : 'ok'}
            />
            <Stat
              label="This calendar month so far"
              value={fmtGB(data.monthToDateBytes)}
              hint="Sum of positive consumption deltas this UTC month"
            />
          </div>
        )}

        <h3 className="mt-4 mb-2 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Burn rate
        </h3>
        <ul className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] divide-y divide-[color:var(--color-border)]">
          {data.burns.map(b => (
            <li
              key={b.label}
              className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-[12px]"
            >
              <span className="font-medium text-[color:var(--color-text-primary)]">
                {b.label}
                {b.partial && (
                  <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-normal text-amber-800">
                    partial window
                  </span>
                )}
              </span>
              <span className="font-mono text-[color:var(--color-text-secondary)]">
                {fmtGB(b.consumedBytes)} consumed ·{' '}
                <span className="text-[color:var(--color-text-primary)]">
                  {(b.bytesPerHour / BYTES_PER_GB).toFixed(2)} GB/hr
                </span>
                {b.label === 'Last 24h' && b.bytesPerHour > 0 && (
                  <>
                    {' '}
                    · projects to{' '}
                    {((b.bytesPerHour * 24 * 30) / BYTES_PER_GB).toFixed(0)} GB / 30d
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------- Cost ---------- */}
      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <header className="mb-3">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Estimated cost
          </h2>
          <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">
            Rates are admin-editable below. The projection multiplies the
            last-24h burn rate by 30 days, so spiky periods will inflate it —
            adjust your expectations during heavy backfills.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Stat
            label="Bandwidth cost · month-to-date"
            value={fmtUsd(data.monthToDateBandwidthCostUsd)}
            hint={`${fmtGB(data.monthToDateBytes)} × $${data.costPerGbUsd.toFixed(2)} /GB`}
          />
          <Stat
            label="Bandwidth cost · projected 30-day"
            value={fmtUsd(data.monthProjectedBandwidthCostUsd)}
            hint="Last-24h burn × 30 days"
            tone={data.monthProjectedBandwidthCostUsd > 1000 ? 'warn' : 'ok'}
          />
          <Stat
            label="Fixed monthly costs"
            value={fmtUsd(data.fixedMonthlyTotalUsd)}
            hint="Sum of subscriptions below"
          />
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Stat
            label="Total OpEx · month-to-date"
            value={fmtUsd(data.monthToDateOpExUsd)}
            hint="Bandwidth so far + fixed costs pro-rated by month elapsed"
            tone="emphasis"
          />
          <Stat
            label="Total OpEx · projected 30-day"
            value={fmtUsd(data.monthProjectedOpExUsd)}
            hint="Projected bandwidth + full fixed"
            tone="emphasis"
          />
        </div>
      </section>

      {/* ---------- Rate config ---------- */}
      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <header className="mb-3">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Cost rates
          </h2>
          <p className="mt-1 max-w-2xl text-[11px] text-[color:var(--color-text-secondary)]">
            Edit the bandwidth rate and any of the fixed monthly subscriptions.
            Changes are stored in <code>system_settings</code> and take effect
            on the next page load. The activity log records every edit.
          </p>
        </header>

        <ul className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]">
          <CostRow
            settingKey="proxy_bandwidth_cost_usd_per_gb"
            label="EnigmaProxy — variable bandwidth rate"
            hint="Charged per GB of residential traffic consumed."
            current={data.costPerGbUsd}
            unit="/ GB"
          />
          {data.fixedCosts.map(c => (
            <CostRow
              key={c.key}
              settingKey={c.key}
              label={c.label}
              current={c.amountUsd}
              unit="/ mo"
            />
          ))}
        </ul>
      </section>

      {/* ---------- Recent snapshots ---------- */}
      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <header className="mb-3">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            Recent snapshots (last 7 days)
          </h2>
          <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">
            Newest first. A drop in remaining = consumption; an increase = plan
            top-up.
          </p>
        </header>
        {data.recentSnapshots.length === 0 ? (
          <p className="text-[12px] text-[color:var(--color-text-secondary)]">No snapshots yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead className="bg-[color:var(--color-bg-secondary)] text-left text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                <tr>
                  <th className="px-3 py-1.5">When</th>
                  <th className="px-3 py-1.5 text-right">Used</th>
                  <th className="px-3 py-1.5 text-right">Remaining</th>
                  <th className="px-3 py-1.5 text-right">Plan limit</th>
                  <th className="px-3 py-1.5">Low?</th>
                </tr>
              </thead>
              <tbody>
                {data.recentSnapshots.slice(0, 50).map((s, i) => (
                  <tr
                    key={`${s.captured_at}-${i}`}
                    className="border-b border-[color:var(--color-border)] last:border-b-0"
                  >
                    <td className="px-3 py-1.5 text-[color:var(--color-text-secondary)]">
                      {fmtDateTime(s.captured_at)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">{fmtGB(s.used_bytes)}</td>
                    <td className="px-3 py-1.5 text-right font-mono">
                      {fmtGB(s.remaining_bytes)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">{fmtGB(s.limit_bytes)}</td>
                    <td className="px-3 py-1.5">
                      {s.is_low ? (
                        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-800">
                          LOW
                        </span>
                      ) : (
                        <span className="text-[color:var(--color-text-secondary)]">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone = 'plain',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'plain' | 'ok' | 'warn' | 'emphasis'
}) {
  const ring =
    tone === 'warn'
      ? 'border-amber-300 bg-amber-50'
      : tone === 'ok'
        ? 'border-emerald-300 bg-emerald-50'
        : tone === 'emphasis'
          ? 'border-[color:var(--color-accent)] bg-[color:var(--color-bg-secondary)]'
          : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]'
  return (
    <div className={['rounded-md border px-3 py-2', ring].join(' ')}>
      <div className="text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        {label}
      </div>
      <div className="mt-1 text-[18px] font-semibold text-[color:var(--color-text-primary)]">
        {value}
      </div>
      {hint && (
        <div className="mt-0.5 text-[10px] text-[color:var(--color-text-secondary)]">
          {hint}
        </div>
      )}
    </div>
  )
}

function fmtGB(bytes: number): string {
  return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`
}

function fmtUsd(usd: number): string {
  return `$${usd.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
