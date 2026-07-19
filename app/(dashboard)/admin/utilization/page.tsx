import { redirect } from 'next/navigation'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { loadUtilizationData } from './_lib/queries'
import type { UtilizationData } from './_lib/queries'
import { AutoRefresh } from './_components/auto-refresh'

export const dynamic = 'force-dynamic'

export default async function UtilizationPage() {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?from=/admin/utilization')

  const svc = createServiceClient()
  const { data: isAdmin } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (!isAdmin) redirect('/')

  const data = await loadUtilizationData()

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            Fleet utilization
          </h1>
          <p className="mt-0.5 max-w-3xl text-[12px] text-[color:var(--color-text-secondary)]">
            Live view of scraper-fleet capacity, throughput, country mix, and
            per-user cap adherence. Numbers are read from{' '}
            <code>scrape_queue</code> and <code>active_profile_locks</code>{' '}
            on every load — this page never touches the queue.
          </p>
        </div>
        <AutoRefresh generatedAt={data.generatedAt} />
      </header>

      <FleetCapacitySection data={data} />
      <DailyVolumeSection data={data} />
      <CountryMixSection data={data} />
      <UserCapSection data={data} />
    </div>
  )
}

/* ================================================================= */
/*  Section: Fleet capacity + live locks                             */
/* ================================================================= */

function FleetCapacitySection({ data }: { data: UtilizationData }) {
  const { fleet, jobs } = data
  const utilTone: StatTone =
    fleet.utilizationPct >= 80 ? 'warn' : fleet.utilizationPct >= 40 ? 'emphasis' : 'ok'

  return (
    <section className="rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-bg-primary)] p-4">
      <header className="mb-3">
        <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          Fleet capacity &amp; live workers
        </h2>
        <p className="mt-1 max-w-3xl text-[11px] text-[color:var(--color-text-secondary)]">
          Fleet shape is fixed at <strong>{fleet.vmCount} VMs</strong> ×{' '}
          <strong>{fleet.workersPerVm} workers each</strong>. Per-country
          concurrency is capped at{' '}
          <strong>{fleet.maxPerCountry}</strong> (edit{' '}
          <code>max_concurrent_per_country</code> in system settings).
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
        <Stat
          label="Slots in use right now"
          value={`${fleet.slotsInUse} / ${fleet.totalSlots}`}
          hint={`${fleet.utilizationPct.toFixed(1)}% utilization`}
          tone={utilTone}
        />
        <Stat
          label="Pending (ready)"
          value={fleet.pendingReady.toLocaleString()}
          hint={
            fleet.scheduledLater > 0
              ? `+${fleet.scheduledLater.toLocaleString()} scheduled for later`
              : 'Rows waiting for a free slot'
          }
          tone={fleet.pendingReady > 20 ? 'warn' : fleet.pendingReady > 0 ? 'emphasis' : 'plain'}
        />
        <Stat
          label="Started (last 24h)"
          value={jobs.startedLast24h.toLocaleString()}
          hint={`${jobs.completedLast24h.toLocaleString()} completed`}
        />
        <Stat
          label="Avg job duration"
          value={jobs.avgDurationSec !== null ? fmtDuration(jobs.avgDurationSec) : '—'}
          hint={jobs.maxDurationSec !== null ? `max observed: ${fmtDuration(jobs.maxDurationSec)}` : 'No completed jobs in last 24h'}
        />
        <Stat
          label="Theoretical throughput"
          value={
            jobs.theoreticalJobsPerHourFleet > 0
              ? `${jobs.theoreticalJobsPerHourFleet.toLocaleString()} /hr`
              : '—'
          }
          hint={
            jobs.theoreticalJobsPerHourPerVm > 0
              ? `~${jobs.theoreticalJobsPerHourPerVm}/hr per VM at current avg duration`
              : 'Need job durations to compute'
          }
        />
      </div>

      <h3 className="mt-4 mb-2 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        Active locks
      </h3>
      {fleet.activeLocks.length === 0 ? (
        <p className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-3 py-2 text-[12px] text-[color:var(--color-text-secondary)]">
          No active locks. Fleet is idle.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[11px]">
            <thead className="bg-[color:var(--color-bg-secondary)] text-left text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              <tr>
                <th className="px-3 py-1.5">Country</th>
                <th className="px-3 py-1.5">Job kind</th>
                <th className="px-3 py-1.5 text-right">Age (min)</th>
              </tr>
            </thead>
            <tbody>
              {fleet.activeLocks.map((l, i) => (
                <tr key={i} className="border-b border-[color:var(--color-border)] last:border-b-0">
                  <td className="px-3 py-1.5 font-mono">{l.country_code}</td>
                  <td className="px-3 py-1.5 text-[color:var(--color-text-secondary)]">{l.job_kind ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{l.ageMinutes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/* ================================================================= */
/*  Section: Daily volume (last 14d bar chart)                        */
/* ================================================================= */

function DailyVolumeSection({ data }: { data: UtilizationData }) {
  const { daily } = data
  const max = Math.max(1, ...daily.days14.map(d => d.count))
  const peak = daily.peakDay

  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
      <header className="mb-3">
        <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          Daily volume (last 14 days)
        </h2>
        <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">
          One bar per UTC day. Height is number of <code>scrape_queue</code> rows
          created that day.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Stat label="Total (14d)" value={daily.total14d.toLocaleString()} />
        <Stat label="Average per day" value={daily.avgPerDay.toFixed(1)} />
        {peak && peak.count > 0 ? (
          <Stat
            label="Peak day"
            value={peak.count.toLocaleString()}
            hint={fmtDate(peak.dateIso)}
            tone="emphasis"
          />
        ) : (
          <Stat label="Peak day" value="—" />
        )}
      </div>

      <div className="mt-4 flex items-end gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3" style={{ height: 140 }}>
        {daily.days14.map(d => {
          const h = (d.count / max) * 100
          const isPeak = peak !== null && d.dateIso === peak.dateIso && d.count > 0
          return (
            <div key={d.dateIso} className="group relative flex flex-1 flex-col items-center justify-end">
              <div
                className={
                  'w-full rounded-sm ' +
                  (isPeak
                    ? 'bg-[color:var(--color-accent)]'
                    : d.count > 0
                      ? 'bg-[color:var(--color-accent-hover)] opacity-70'
                      : 'bg-[color:var(--color-border)]')
                }
                style={{ height: `${Math.max(h, d.count > 0 ? 4 : 2)}%` }}
              />
              <span
                className={
                  'pointer-events-none absolute -top-5 rounded bg-black/80 px-1 py-0.5 text-[9px] text-white opacity-0 shadow group-hover:opacity-100 ' +
                  'transition-opacity tabular-nums'
                }
              >
                {fmtDate(d.dateIso)}: {d.count}
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-[color:var(--color-text-secondary)]">
        <span>{fmtDate(daily.days14[0]?.dateIso ?? '')}</span>
        <span>Today</span>
      </div>
    </section>
  )
}

/* ================================================================= */
/*  Section: Country distribution                                    */
/* ================================================================= */

function CountryMixSection({ data }: { data: UtilizationData }) {
  const { countries } = data
  const max = Math.max(1, ...countries.breakdown.map(c => c.count))

  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
      <header className="mb-3">
        <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          Country distribution (last 14d)
        </h2>
        <p className="mt-1 max-w-3xl text-[11px] text-[color:var(--color-text-secondary)]">
          Countries the fleet is actually being pointed at. Empty rows are
          country profiles that exist but weren&apos;t used in this window.
        </p>
      </header>

      {countries.breakdown.length === 0 ? (
        <p className="text-[12px] text-[color:var(--color-text-secondary)]">
          No scrapes in the last 14 days.
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]">
          {countries.breakdown.map(c => (
            <li key={c.country_code} className="grid grid-cols-[3rem_1fr_5rem_4rem] items-center gap-3 px-3 py-1.5 text-[12px]">
              <span className="font-mono font-medium text-[color:var(--color-text-primary)]">{c.country_code}</span>
              <div className="relative h-3 rounded bg-[color:var(--color-bg-primary)] ring-1 ring-inset ring-[color:var(--color-border)]">
                <div
                  className="absolute inset-y-0 left-0 rounded bg-[color:var(--color-accent-hover)]"
                  style={{ width: `${(c.count / max) * 100}%` }}
                />
              </div>
              <span className="text-right font-mono tabular-nums text-[color:var(--color-text-primary)]">{c.count.toLocaleString()}</span>
              <span className="text-right font-mono tabular-nums text-[color:var(--color-text-secondary)]">{c.pct.toFixed(1)}%</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* ================================================================= */
/*  Section: Per-user cap adherence                                  */
/* ================================================================= */

function UserCapSection({ data }: { data: UtilizationData }) {
  const { users } = data
  const cap = users.dailyCap

  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
      <header className="mb-3">
        <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          Per-user cap adherence (last 7 days)
        </h2>
        <p className="mt-1 max-w-3xl text-[11px] text-[color:var(--color-text-secondary)]">
          Cap is currently <strong>{cap === null ? 'disabled' : `${cap} scrapes / UTC day`}</strong>.
          One &quot;scrape&quot; = one <code>scrape_queue</code> row (one keyword × engine).
          &quot;BYPASS&quot; users are exempt via <code>user_profiles.bypass_scrape_cap</code>.
        </p>
      </header>

      {users.rollup7d.length === 0 ? (
        <p className="text-[12px] text-[color:var(--color-text-secondary)]">
          No scrapes submitted by any user in the last 7 days.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[11px]">
            <thead className="bg-[color:var(--color-bg-secondary)] text-left text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              <tr>
                <th className="px-3 py-1.5">User</th>
                <th className="px-3 py-1.5 text-right">Total 7d</th>
                <th className="px-3 py-1.5 text-right">Peak day</th>
                {(users.rollup7d[0]?.byDay ?? []).map(d => (
                  <th key={d.dateIso} className="px-2 py-1.5 text-right font-mono text-[9px] uppercase">
                    {fmtDateShort(d.dateIso)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.rollup7d.map(u => (
                <tr key={u.email} className="border-b border-[color:var(--color-border)] last:border-b-0">
                  <td className="px-3 py-1.5">
                    <span className="font-medium text-[color:var(--color-text-primary)]">{u.email}</span>
                    {u.bypass ? (
                      <span className="ml-2 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-800">
                        BYPASS
                      </span>
                    ) : u.isAdmin ? (
                      <span className="ml-2 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-700">
                        admin
                      </span>
                    ) : null}
                    {u.hitCap && (
                      <span className="ml-2 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-800">
                        HIT CAP
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums font-semibold">{u.total7d.toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[color:var(--color-text-secondary)]">{u.peak.toLocaleString()}</td>
                  {u.byDay.map(d => (
                    <td
                      key={d.dateIso}
                      className={
                        'px-2 py-1.5 text-right font-mono tabular-nums ' +
                        (d.overCap ? 'bg-amber-50 font-semibold text-amber-800' : d.count > 0 ? 'text-[color:var(--color-text-primary)]' : 'text-[color:var(--color-text-secondary)]')
                      }
                      title={d.overCap ? `≥ ${cap} — hit the daily cap` : undefined}
                    >
                      {d.count > 0 ? d.count : '·'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/* ================================================================= */
/*  Shared bits                                                       */
/* ================================================================= */

type StatTone = 'plain' | 'ok' | 'warn' | 'emphasis'

function Stat({
  label,
  value,
  hint,
  tone = 'plain',
}: {
  label: string
  value: string
  hint?: string
  tone?: StatTone
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

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}m ${s}s`
}

function fmtDate(iso: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

function fmtDateShort(iso: string): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
  } catch {
    return iso
  }
}
