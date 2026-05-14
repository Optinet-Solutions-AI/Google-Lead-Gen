import Link from 'next/link'
import { EyeOff, Eye } from 'lucide-react'
import { LEADS_COLUMNS } from '@/lib/filters/columns-leads'
import { parseFilters, parseSorts } from '@/lib/filters/serialize'
import type { ColumnDef } from '@/lib/filters/types'
import { createServiceClient } from '@/lib/supabase/service'
import { Pagination } from '../monday/_components/pagination'
import { AdvancedFilters } from '../_components/advanced-filters'
import { LeadsTable } from './_components/leads-table'
import {
  DEFAULT_LEAD_PAGE_SIZE,
  LEAD_PAGE_SIZES,
  listCountryFilters,
  queryLeads,
} from './_lib/query'

async function countNotRelevant(): Promise<number> {
  const svc = createServiceClient()
  const { count } = await svc
    .from('google_lead_gen_table')
    .select('id', { head: true, count: 'exact' })
    .eq('is_not_relevant', true)
  return count ?? 0
}

type SearchParams = Record<string, string | string[] | undefined>

export const dynamic = 'force-dynamic'

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams

  const page = clampInt(sp.page, 1, 1_000_000, 1)
  const size = clampEnum(sp.size, LEAD_PAGE_SIZES, DEFAULT_LEAD_PAGE_SIZE)
  const sort = typeof sp.sort === 'string' ? sp.sort : 'created_at'
  const order: 'asc' | 'desc' = sp.order === 'asc' ? 'asc' : 'desc'
  const q = typeof sp.q === 'string' ? sp.q : ''
  const countryCode = typeof sp.country_code === 'string' ? sp.country_code : ''
  const resultType = typeof sp.result_type === 'string' ? sp.result_type : ''
  const filters = parseFilters(sp.f)
  const sorts = parseSorts(sp.s)
  const showHidden = sp.show_hidden === '1'

  // Build the URL for the "Show/Hide not-relevant" toggle while preserving
  // the user's current filters, sort, q, country, etc. Page is intentionally
  // reset because the total-row count changes when hidden rows toggle.
  const toggleHref = (() => {
    const next = new URLSearchParams()
    for (const [k, v] of Object.entries(sp)) {
      if (k === 'show_hidden' || k === 'page') continue
      if (typeof v === 'string') next.set(k, v)
      else if (Array.isArray(v)) for (const item of v) next.append(k, item)
    }
    if (!showHidden) next.set('show_hidden', '1')
    const qs = next.toString()
    return qs ? `/leads?${qs}` : '/leads'
  })()

  const [{ rows, total }, countries, hiddenCount] = await Promise.all([
    queryLeads({
      page,
      size,
      sort,
      order,
      q,
      countryCode,
      resultType,
      filters,
      sorts,
      includeNotRelevant: showHidden,
    }),
    listCountryFilters(),
    countNotRelevant(),
  ])

  // Inject the live country list into the column registry so the dropdown
  // in the filter popover shows the same countries as the legacy filter.
  const columns: ReadonlyArray<ColumnDef> = LEADS_COLUMNS.map(c =>
    c.key === 'country_code'
      ? {
          ...c,
          options: countries.map(co => ({
            value: co.code,
            label: `${co.name} (${co.code})`,
          })),
        }
      : c,
  )

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            Search results
          </h1>
          <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
            Every row scraped into <code>google_lead_gen_table</code>.
            {' '}
            <span className="text-[color:var(--color-text-primary)]">{total.toLocaleString()}</span> total.
            {!showHidden && hiddenCount > 0 && (
              <span className="ml-1">
                · {hiddenCount.toLocaleString()} hidden as not relevant.
              </span>
            )}
          </p>
        </div>
        {hiddenCount > 0 && (
          <Link
            href={toggleHref}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
            title={
              showHidden
                ? 'Hide rows marked as not relevant'
                : 'Include rows marked as not relevant in the table below'
            }
          >
            {showHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {showHidden ? 'Hide not-relevant' : `Show not-relevant (${hiddenCount})`}
          </Link>
        )}
      </header>

      <AdvancedFilters columns={columns} preserve={['country_code', 'result_type', 'show_hidden']} />

      <LeadsTable rows={rows} pageInfo={{ page, size, total }} />

      <Pagination page={page} size={size} total={total} pageSizeOptions={LEAD_PAGE_SIZES} />
    </div>
  )
}

function clampInt(
  raw: string | string[] | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function clampEnum<T extends number>(
  raw: string | string[] | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  return (allowed as readonly number[]).includes(n) ? (n as T) : fallback
}
