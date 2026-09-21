import Link from 'next/link'
import { Search, Sparkles } from 'lucide-react'
import { AffiliateList } from './_components/affiliate-list'
import {
  FILTERS,
  loadRecencyBands,
  loadSummary,
  queryAffiliates,
  type AffiliateFilter,
} from './_lib/query'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>

/** Request time, taken once (keeps the page component pure). */
function requestNowMs(): number {
  return Date.now()
}

const PAGE_SIZE = 100

/**
 * /affiliates — what the AI analysis found.
 *
 * The pipeline trims a scrape down to the websites that are not already on
 * Monday and not marked not-relevant, judges which are affiliates, and pulls
 * out every brand CTA link with where it really lands. This is where that
 * output is read, and where the manual S-tag walk gets its worklist.
 */
export default async function AffiliatesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams
  const filter: AffiliateFilter =
    FILTERS.some(f => f.key === sp.filter) ? (sp.filter as AffiliateFilter) : 'affiliates'
  const q = typeof sp.q === 'string' ? sp.q.trim() : ''
  const nowMs = requestNowMs()

  const [summary, bands, { rows, total }] = await Promise.all([
    loadSummary(),
    loadRecencyBands(),
    queryAffiliates({ filter, q, country: '', page: 1, size: PAGE_SIZE }),
  ])

  const active = FILTERS.find(f => f.key === filter)

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="inline-flex items-center gap-2 text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            <Sparkles className="h-4 w-4 text-[color:var(--color-text-secondary)]" />
            Affiliates found by AI
          </h1>
          <p className="mt-0.5 max-w-3xl text-[12px] text-[color:var(--color-text-secondary)]">
            Websites that survived the Monday and not-relevant trim, then were opened and judged. Each row shows how
            many brands the site promotes and how many outbound CTA links it has, which is the worklist for the
            browser S-tag pass.
          </p>
        </div>
      </header>

      {/* Summary */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="Screened" value={summary.screened} hint="Websites the cheap triage has looked at" />
        <Stat label="Opened" value={summary.audited} hint="Websites actually fetched and judged" />
        <Stat label="Affiliates" value={summary.affiliates} tone="emerald" hint="Confirmed affiliate websites" />
        <Stat label="CTA links" value={summary.ctaLinks} hint="Outbound brand links extracted and resolved" />
        <Stat label="Promotes ours" value={summary.roosterSites} tone="emerald" hint="Sites promoting a Rooster brand" />
        <Stat label="S-tag queue" value={summary.stagPending} tone="amber" hint="Affiliates whose CTA links still need walking" />
      </div>

      {/* Filters + search */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <nav className="no-scrollbar -mx-1 flex gap-1.5 overflow-x-auto px-1">
          {FILTERS.map(f => {
            const isActive = f.key === filter
            const params = new URLSearchParams()
            params.set('filter', f.key)
            if (q) params.set('q', q)
            return (
              <Link
                key={f.key}
                href={`/affiliates?${params.toString()}`}
                title={f.hint}
                className={[
                  'whitespace-nowrap rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors',
                  isActive
                    ? 'bg-[color:var(--color-accent)] text-[color:var(--color-text-primary)]'
                    : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-accent-hover)] hover:text-[color:var(--color-text-primary)]',
                ].join(' ')}
              >
                {f.label}
              </Link>
            )
          })}
        </nav>

        <form method="get" action="/affiliates" className="relative w-full lg:w-72">
          <input type="hidden" name="filter" value={filter} />
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--color-text-secondary)]" />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Filter by domain…"
            className="w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] py-1.5 pl-8 pr-3 text-[13px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          />
        </form>
      </div>

      {active && (
        <p className="-mt-1 text-[11.5px] text-[color:var(--color-text-secondary)]">
          {active.hint}
          {q && ` · filtered to domains containing “${q}”`}
        </p>
      )}

      <AffiliateList rows={rows} total={total} bands={bands} nowMs={nowMs} />
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: number
  hint: string
  tone?: 'emerald' | 'amber'
}) {
  const valueCls =
    tone === 'emerald' ? 'text-emerald-700' : tone === 'amber' ? 'text-amber-800' : 'text-[color:var(--color-text-primary)]'
  return (
    <div
      title={hint}
      className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-2"
    >
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">
        {label}
      </div>
      <div className={`mt-0.5 text-[18px] font-semibold tabular-nums ${valueCls}`}>{value.toLocaleString()}</div>
    </div>
  )
}
