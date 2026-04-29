import { LEADS_COLUMNS } from '@/lib/filters/columns-leads'
import { parseFilters, parseSorts } from '@/lib/filters/serialize'
import type { ColumnDef } from '@/lib/filters/types'
import { Pagination } from '../monday/_components/pagination'
import { AdvancedFilters } from '../_components/advanced-filters'
import { LeadsTable } from './_components/leads-table'
import {
  DEFAULT_LEAD_PAGE_SIZE,
  LEAD_PAGE_SIZES,
  listCountryFilters,
  queryLeads,
} from './_lib/query'

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

  const [{ rows, total }, countries] = await Promise.all([
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
    }),
    listCountryFilters(),
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
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Search results
        </h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
          Every row scraped into <code>google_lead_gen_table</code>.
          {' '}
          <span className="text-[color:var(--color-text-primary)]">{total.toLocaleString()}</span> total.
        </p>
      </header>

      <AdvancedFilters columns={columns} preserve={['country_code', 'result_type']} />

      <LeadsTable rows={rows} />

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
