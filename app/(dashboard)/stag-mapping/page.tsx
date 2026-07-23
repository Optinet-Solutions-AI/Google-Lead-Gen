import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { loadStagMappingData, type MondayBoardFreshness } from './_lib/queries'
import { StagTable } from './_components/stag-table'
import { SyncControls } from './_components/sync-controls'
import { DashboardSection } from '../_components/dashboards/dashboard-section'
import { TrendChart, type TrendPoint } from '../_components/dashboards/trend-chart'
import { HeatMap, bucketToHeatmap, type HeatCell } from '../_components/dashboards/heat-map'
import { Leaderboard } from '../_components/dashboards/leaderboard'
import { bucketByDayInWindow } from '../_lib/bucket-timestamps'
import type { StagGroup } from './_lib/queries'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

function parseLookback(
  raw: string | string[] | undefined,
  fallback: number,
): number | null {
  if (typeof raw !== 'string') return fallback
  if (raw.toLowerCase() === 'all') return null
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
  const lookbackDays = parseLookback(sp.days, 90)
  const data = await loadStagMappingData({ lookbackDays })
  // Read optional filter shortcut from URL — the summary boxes below
  // link here with e.g. ?filter=mapped so operators can drill straight
  // from the top-of-page counters into the filtered table below.
  const initialFilter =
    typeof sp.filter === 'string' && ['all', 'mapped', 'unmapped', 'mirror'].includes(sp.filter)
      ? (sp.filter as 'all' | 'mapped' | 'unmapped' | 'mirror')
      : 'all'

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
            page groups every S-tag we&apos;ve extracted{' '}
            {data.lookbackDays === null ? (
              <strong>across all time</strong>
            ) : (
              <>
                in the last <strong>{data.lookbackDays} days</strong>
              </>
            )}
            , deduplicates the mirror domains, and marks whether the S-tag is
            already recorded on Monday.
          </p>
          <div className="mt-2 inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-0.5 text-[11px]">
            {[
              { key: '30', label: '30 days' },
              { key: '90', label: '90 days' },
              { key: '180', label: '180 days' },
              { key: 'all', label: 'All time' },
            ].map(opt => {
              const isActive =
                (opt.key === 'all' && data.lookbackDays === null) ||
                (opt.key !== 'all' && String(data.lookbackDays) === opt.key)
              return (
                <Link
                  key={opt.key}
                  href={`/stag-mapping?days=${opt.key}`}
                  className={[
                    'rounded-sm px-2 py-1 font-medium transition-colors',
                    isActive
                      ? 'bg-[color:var(--color-accent)]/15 text-[color:var(--color-text-primary)]'
                      : 'text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]',
                  ].join(' ')}
                >
                  {opt.label}
                </Link>
              )
            })}
          </div>
        </div>
        {isAdmin && <SyncControls />}
      </header>

      <FreshnessBanner freshness={data.freshness} oldest={oldest} />

      <SummarySection
        summary={data.summary}
        lookbackDays={data.lookbackDays}
        lookbackParam={typeof sp.days === 'string' ? sp.days : ''}
      />

      <div id="stag-table">
        <StagTable
          groups={data.groups}
          truncated={data.truncated}
          initialFilter={initialFilter}
        />
      </div>

      <AnalyticsSections
        groups={data.groups}
        lookbackDays={data.lookbackDays}
        nowIso={new Date().toISOString()}
      />

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
  lookbackParam,
}: {
  summary: {
    totalUniqueTags: number
    mappedCount: number
    unmappedCount: number
    mirrorGroups: number
    totalWebsites: number
    totalLeadsWithTags: number
  }
  lookbackDays: number | null
  /** The raw `?days=` value on the URL so drill-down links preserve it. */
  lookbackParam: string
}) {
  const mappedPct =
    summary.totalUniqueTags > 0
      ? (summary.mappedCount / summary.totalUniqueTags) * 100
      : 0
  // Every drill-down link routes back to this same page with a filter
  // shortcut + preserved window + a #stag-table anchor so the table
  // scrolls into view. StagTable reads `initialFilter` from the URL.
  const drillHref = (filter: 'all' | 'mapped' | 'unmapped' | 'mirror') => {
    const params = new URLSearchParams()
    if (lookbackParam) params.set('days', lookbackParam)
    if (filter !== 'all') params.set('filter', filter)
    const qs = params.toString()
    return `/stag-mapping${qs ? `?${qs}` : ''}#stag-table`
  }
  return (
    <section className="rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-bg-primary)] p-4">
      <header className="mb-3">
        <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          Summary · {lookbackDays === null ? 'all time' : `last ${lookbackDays} days`}
        </h2>
        <p className="mt-1 text-[11px] text-[color:var(--color-text-secondary)]">
          Grouped by S-tag value. Same S-tag on multiple websites = same
          operator = counts as one row here even if 10 domains carry it.
          Click a card to jump to the filtered table below.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
        <Stat
          label="Unique S-tags"
          value={summary.totalUniqueTags.toLocaleString()}
          tone="emphasis"
          href={drillHref('all')}
        />
        <Stat
          label="Mapped to Monday"
          value={summary.mappedCount.toLocaleString()}
          hint={`${mappedPct.toFixed(0)}% of the total`}
          tone={mappedPct >= 50 ? 'ok' : 'plain'}
          href={drillHref('mapped')}
        />
        <Stat
          label="Not on Monday"
          value={summary.unmappedCount.toLocaleString()}
          hint="Pitch opportunities"
          tone={summary.unmappedCount > 0 ? 'warn' : 'plain'}
          href={drillHref('unmapped')}
        />
        <Stat
          label="Mirror groups"
          value={summary.mirrorGroups.toLocaleString()}
          hint="S-tags on 2+ domains"
          tone={summary.mirrorGroups > 0 ? 'emphasis' : 'plain'}
          href={drillHref('mirror')}
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
  href,
}: {
  label: string
  value: string
  hint?: string
  tone?: StatTone
  /** When set, the card renders as a clickable Link that drills into
   *  the table below (filter shortcut + #stag-table anchor). */
  href?: string
}) {
  const ring =
    tone === 'warn'
      ? 'border-amber-300 bg-amber-50'
      : tone === 'ok'
        ? 'border-emerald-300 bg-emerald-50'
        : tone === 'emphasis'
          ? 'border-[color:var(--color-accent)] bg-[color:var(--color-bg-secondary)]'
          : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]'
  const body = (
    <>
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
    </>
  )
  if (href) {
    return (
      <Link
        href={href}
        className={[
          'block rounded-md border px-3 py-2 text-left transition-colors hover:brightness-95',
          ring,
        ].join(' ')}
        title="Jump to the table below with this filter applied"
      >
        {body}
      </Link>
    )
  }
  return <div className={['rounded-md border px-3 py-2', ring].join(' ')}>{body}</div>
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

/* =================================================================
 * Phase 5 analytics sections — derived entirely from the groups the
 * existing query already loads. No extra Supabase round-trip.
 * ================================================================= */
function AnalyticsSections({
  groups,
  lookbackDays,
  nowIso,
}: {
  groups: StagGroup[]
  lookbackDays: number | null
  /** ISO timestamp captured by the (server) parent — passed in as a
   *  stable prop so the purity linter is happy. */
  nowIso: string
}) {
  // Flatten every lead's timestamp into a stream so we can trend +
  // heatmap by lead-creation, not just by first-tag-seen.
  const leadTimestamps: string[] = []
  const mondayMappedTimestamps: string[] = []
  for (const g of groups) {
    for (const lead of g.leads) {
      leadTimestamps.push(lead.createdAt)
      if (g.isOnMonday) mondayMappedTimestamps.push(lead.createdAt)
    }
  }

  // Window bounds for the trend. Use the first-seen from the earliest
  // group and the current time — matches the "over the last N days"
  // header. For all-time, use the earliest timestamp we found.
  const nowMs = new Date(nowIso).getTime()
  const oldest =
    groups.length > 0
      ? groups.reduce<string>(
          (o, g) => (g.firstSeen < o ? g.firstSeen : o),
          groups[0]!.firstSeen,
        )
      : nowIso
  const windowStart =
    lookbackDays === null
      ? oldest
      : new Date(nowMs - lookbackDays * 24 * 60 * 60 * 1000).toISOString()

  const trendPoints: TrendPoint[] = bucketByDayInWindow(
    leadTimestamps,
    windowStart,
    nowIso,
    mondayMappedTimestamps,
  )
  const heatCells: HeatCell[] = bucketToHeatmap(leadTimestamps)

  // Per-brand leaderboard — brand null groups roll up as "(unbranded)".
  const brandMap = new Map<string, number>()
  for (const g of groups) {
    const brand = g.brand?.trim() || '(unbranded)'
    brandMap.set(brand, (brandMap.get(brand) ?? 0) + g.leadCount)
  }
  const brandRows = Array.from(brandMap.entries())
    .sort(([, a], [, b]) => b - a)
    .slice(0, 15)
    .map(([label, value]) => ({ key: label, label, value }))

  // Mirror-group leaderboard — S-tags carried on 2+ domains, ranked
  // by domain count.
  const mirrorRows = groups
    .filter(g => g.domainCount >= 2)
    .sort((a, b) => b.domainCount - a.domainCount || b.leadCount - a.leadCount)
    .slice(0, 15)
    .map(g => ({
      key: g.sTag,
      label: g.sTag,
      value: g.domainCount,
      secondary: `${g.leadCount} lead${g.leadCount === 1 ? '' : 's'} · ${g.domains.slice(0, 3).join(', ')}${g.domains.length > 3 ? '…' : ''}`,
    }))

  return (
    <>
      <DashboardSection
        title={`Extraction trend · ${lookbackDays === null ? 'all time' : `last ${lookbackDays} days`}`}
        hint="Solid = all S-tag-carrying leads in the window. Dashed = subset already mapped to Monday."
      >
        <TrendChart points={trendPoints} />
      </DashboardSection>

      <DashboardSection
        title="Day × hour extraction heatmap"
        hint="Darker = more S-tag-carrying leads at that day-of-week / hour-of-day (UTC)."
      >
        <HeatMap data={heatCells} />
      </DashboardSection>

      <div className="grid gap-4 lg:grid-cols-2">
        <DashboardSection title="Top brands · by lead volume">
          <Leaderboard rows={brandRows} valueLabel="Leads" />
        </DashboardSection>
        <DashboardSection title="Top mirror groups · S-tags on 2+ domains">
          <Leaderboard rows={mirrorRows} valueLabel="Domains" />
        </DashboardSection>
      </div>
    </>
  )
}
