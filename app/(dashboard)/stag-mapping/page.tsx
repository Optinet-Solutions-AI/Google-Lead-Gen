import { redirect } from 'next/navigation'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { loadStagMappingData, type MondayBoardFreshness } from './_lib/queries'
import { StagTable } from './_components/stag-table'
import { SyncControls } from './_components/sync-controls'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

function clampDays(raw: string | string[] | undefined, fallback: number): number {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, 1), 365)
}

export default async function StagMappingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?from=/stag-mapping')

  const svc = createServiceClient()
  const { data: isAdmin } = await svc.rpc('is_admin', { p_user_id: user.id })

  const sp = await searchParams
  const lookbackDays = clampDays(sp.days, 90)
  const data = await loadStagMappingData({ lookbackDays })

  const oldest = data.freshness.reduce<MondayBoardFreshness | null>(
    (worst, b) =>
      worst === null || (b.ageMinutes ?? Infinity) > (worst.ageMinutes ?? Infinity) ? b : worst,
    null,
  )

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            S-tag mapping
          </h1>
          <p className="mt-0.5 max-w-3xl text-[12px] text-[color:var(--color-text-secondary)]">
            Websites sharing the same S-tag belong to the same operator. This
            page groups every S-tag we&apos;ve extracted in the last{' '}
            <strong>{data.lookbackDays} days</strong>, deduplicates the mirror
            domains, and marks whether the S-tag is already recorded on Monday
            (change window via the <code>?days=</code> URL param).
          </p>
        </div>
        {isAdmin && <SyncControls />}
      </header>

      <FreshnessBanner freshness={data.freshness} oldest={oldest} />

      <SummarySection summary={data.summary} lookbackDays={data.lookbackDays} />

      <StagTable groups={data.groups} truncated={data.truncated} />

      <FreshnessDetail freshness={data.freshness} />
    </div>
  )
}

/* ================================================================= */

function FreshnessBanner({
  freshness,
  oldest,
}: {
  freshness: MondayBoardFreshness[]
  oldest: MondayBoardFreshness | null
}) {
  if (!oldest) {
    return (
      <section className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-[12px] text-amber-900">
        <strong>Monday mirror is empty.</strong> Trigger a sync to populate.
      </section>
    )
  }
  const worstAge = oldest.ageMinutes ?? 0
  const anyStale = freshness.some(b => b.isStale)
  if (anyStale) {
    return (
      <section className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-[12px] text-red-900">
        <strong>Monday mirror is stale.</strong> Oldest board (
        <em>{oldest.label}</em>) last synced{' '}
        <strong>{fmtDuration(worstAge)}</strong> ago. Trigger a sync (admins) to
        refresh S-tag matches.
      </section>
    )
  }
  return (
    <section className="rounded-md border border-emerald-300 bg-emerald-50 px-4 py-3 text-[12px] text-emerald-900">
      <strong>Monday mirror is fresh.</strong> Every board synced within the
      last {fmtDuration(worstAge)}. S-tag → Monday matches reflect the current
      state.
    </section>
  )
}

function SummarySection({
  summary,
  lookbackDays,
}: {
  summary: {
    totalUniqueTags: number
    mappedCount: number
    unmappedCount: number
    mirrorGroups: number
    totalWebsites: number
    totalLeadsWithTags: number
  }
  lookbackDays: number
}) {
  const mappedPct =
    summary.totalUniqueTags > 0
      ? (summary.mappedCount / summary.totalUniqueTags) * 100
      : 0
  return (
    <section className="rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-bg-primary)] p-4">
      <header className="mb-3">
        <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          Summary · last {lookbackDays} days
        </h2>
        <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">
          Grouped by S-tag value. Same S-tag on multiple websites = same
          operator = counts as one row here even if 10 domains carry it.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
        <Stat label="Unique S-tags" value={summary.totalUniqueTags.toLocaleString()} tone="emphasis" />
        <Stat
          label="Mapped to Monday"
          value={summary.mappedCount.toLocaleString()}
          hint={`${mappedPct.toFixed(0)}% of the total`}
          tone={mappedPct >= 50 ? 'ok' : 'plain'}
        />
        <Stat
          label="Not on Monday"
          value={summary.unmappedCount.toLocaleString()}
          hint="Pitch opportunities"
          tone={summary.unmappedCount > 0 ? 'warn' : 'plain'}
        />
        <Stat
          label="Mirror groups"
          value={summary.mirrorGroups.toLocaleString()}
          hint="S-tags on 2+ domains"
          tone={summary.mirrorGroups > 0 ? 'emphasis' : 'plain'}
        />
        <Stat
          label="Distinct websites"
          value={summary.totalWebsites.toLocaleString()}
          hint="With any S-tag extracted"
        />
        <Stat
          label="Leads with S-tags"
          value={summary.totalLeadsWithTags.toLocaleString()}
        />
      </div>
    </section>
  )
}

function FreshnessDetail({ freshness }: { freshness: MondayBoardFreshness[] }) {
  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
      <header className="mb-3">
        <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          Monday mirror status
        </h2>
        <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">
          Age of the most-recent <code>synced_at</code> per board. Nightly cron
          runs incremental syncs; use the <em>Sync now</em> button for on-demand
          refreshes.
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead className="bg-[color:var(--color-bg-secondary)] text-left text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
            <tr>
              <th className="px-3 py-1.5">Board</th>
              <th className="px-3 py-1.5 text-right">Items mirrored</th>
              <th className="px-3 py-1.5">Last synced</th>
              <th className="px-3 py-1.5">Age</th>
            </tr>
          </thead>
          <tbody>
            {freshness.map(b => (
              <tr key={b.key} className="border-b border-[color:var(--color-border)] last:border-b-0">
                <td className="px-3 py-1.5 font-medium text-[color:var(--color-text-primary)]">
                  {b.label}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums">{b.itemCount.toLocaleString()}</td>
                <td className="px-3 py-1.5 text-[color:var(--color-text-secondary)]">
                  {b.lastSyncedAt ? new Date(b.lastSyncedAt).toLocaleString() : 'never'}
                </td>
                <td className="px-3 py-1.5">
                  {b.ageMinutes === null ? (
                    <span className="text-[color:var(--color-text-secondary)]">—</span>
                  ) : (
                    <span
                      className={[
                        'rounded-full px-2 py-0.5 text-[10px] font-medium',
                        b.isStale
                          ? 'bg-red-100 text-red-800'
                          : b.ageMinutes > 6 * 60
                            ? 'bg-amber-100 text-amber-900'
                            : 'bg-emerald-100 text-emerald-800',
                      ].join(' ')}
                    >
                      {fmtDuration(b.ageMinutes)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

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

function fmtDuration(minutes: number): string {
  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${Math.round(minutes)} min`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes - h * 60)
  if (h < 24) return m === 0 ? `${h}h` : `${h}h ${m}m`
  const d = Math.floor(h / 24)
  const rh = h - d * 24
  return rh === 0 ? `${d}d` : `${d}d ${rh}h`
}
