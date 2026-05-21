import Link from 'next/link'
import { JOBS_COLUMNS } from '@/lib/filters/columns-jobs'
import { parseFilters, parseSorts } from '@/lib/filters/serialize'
import type { ColumnDef } from '@/lib/filters/types'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { AdvancedFilters } from '../_components/advanced-filters'
import { Pagination } from '../monday/_components/pagination'
import { AutoRefresh } from './_components/auto-refresh'
import { EnqueueForm } from './_components/enqueue-form'
import { JobsCardList, JobsTable } from './_components/jobs-table'
import { KanbanBoard } from './_components/kanban-board'
import {
  listActiveProfiles,
  queryBoardData,
  queryJobs,
} from './_lib/queries'

type SearchParams = Record<string, string | string[] | undefined>

// 0 is the "All" sentinel — see ALL_ROWS in monday/_components/pagination.tsx.
// queryJobs substitutes a soft cap so a multi-thousand-job table doesn't lock
// up the browser.
const PAGE_SIZES = [20, 50, 100, 0] as const
const DEFAULT_PAGE_SIZE = 20

export const dynamic = 'force-dynamic'

export default async function ScrapePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const sp = await searchParams

  const page = clampInt(sp.page, 1, 1_000_000, 1)
  const size = clampEnum(sp.size, PAGE_SIZES, DEFAULT_PAGE_SIZE)
  const q = typeof sp.q === 'string' ? sp.q : ''
  const filters = parseFilters(sp.f)
  const sorts = parseSorts(sp.s)
  const hasAnyFilter = q.length > 0 || filters.length > 0 || sorts.length > 0
  // ?view=board | table. Default to Board so the operator landing on
  // /scrape sees the live Kanban first. Table is one click away.
  const view: 'board' | 'table' =
    typeof sp.view === 'string' && sp.view === 'table' ? 'table' : 'board'

  const [profiles, jobsResult, boardData, isAdmin] = await Promise.all([
    listActiveProfiles(),
    view === 'table'
      ? queryJobs({ page, size, q, filters, sorts })
      : Promise.resolve({ rows: [], total: 0 } as Awaited<ReturnType<typeof queryJobs>>),
    view === 'board'
      ? queryBoardData({ q, filters, sorts })
      : Promise.resolve(null),
    (async () => {
      const supabase = await createServerClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) return false
      const svc = createServiceClient()
      const { data } = await svc.rpc('is_admin', { p_user_id: user.id })
      return data === true
    })(),
  ])
  const { rows, total } = jobsResult

  // Auto-refresh stays on while either the scrape itself OR a follow-on
  // enrichment chain is still in flight, so the badge can transition from
  // "enriching" to "completed" without a manual reload.
  const hasActiveTable = rows.some(
    j =>
      j.status === 'pending' ||
      j.status === 'running' ||
      (j.status === 'completed' &&
        j.with_enrichment &&
        j.enrichment_status !== 'complete'),
  )
  // Board: refresh whenever something is moving — pending, next, running,
  // or recent terminal transitions (so the Completed/Failed columns stay
  // current while operators watch the board).
  const hasActiveBoard = Boolean(
    boardData &&
      (boardData.totals.pending > 0 ||
        boardData.totals.next_in_queue > 0 ||
        boardData.totals.running > 0 ||
        boardData.totals.running_enrichment > 0),
  )
  const hasActive = view === 'board' ? hasActiveBoard : hasActiveTable

  // Inject the live country list into the column registry so the dropdown
  // in the filter popover shows a useful set instead of an empty list.
  const columns: ReadonlyArray<ColumnDef> = JOBS_COLUMNS.map(c =>
    c.key === 'country_code'
      ? {
          ...c,
          options: profiles.map(p => ({
            value: p.country_code,
            label: `${p.country_name} (${p.country_code})`,
          })),
        }
      : c,
  )

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header>
        <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
          Scrape
        </h1>
        <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
          Queue a keyword for a country. A VM worker picks it up within ~5 seconds and
          the results land in the Lead Generator table once complete.
        </p>
      </header>

      <EnqueueForm profiles={profiles} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            {view === 'board'
              ? 'Pipeline board'
              : hasAnyFilter
                ? `${total.toLocaleString()} matching jobs`
                : 'Recent jobs'}
          </h2>
          <div className="flex items-center gap-3">
            <ViewToggle current={view} sp={sp} />
            {hasActive && (
              <p className="text-[11px] text-[color:var(--color-text-secondary)]">
                auto-refreshing every 5 s
              </p>
            )}
          </div>
        </div>

        <AdvancedFilters columns={columns} />

        {view === 'board' && boardData ? (
          <KanbanBoard data={boardData} />
        ) : (
          <>
            <JobsTable jobs={rows} isAdmin={isAdmin} />
            <JobsCardList jobs={rows} />
          </>
        )}
      </section>

      {view === 'table' && (
        <Pagination page={page} size={size} total={total} pageSizeOptions={PAGE_SIZES} />
      )}

      <AutoRefresh enabled={hasActive} />
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

/**
 * Two-button segmented toggle for switching between the Kanban board
 * (default) and the existing table view. Preserves all other query
 * params (filters, sorts, search) so flipping views doesn't reset state.
 */
function ViewToggle({
  current,
  sp,
}: {
  current: 'board' | 'table'
  sp: SearchParams
}) {
  const buildHref = (target: 'board' | 'table'): string => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(sp)) {
      if (k === 'view') continue
      if (typeof v === 'string') params.set(k, v)
      else if (Array.isArray(v)) for (const item of v) params.append(k, item)
    }
    // Board is the default — omit ?view= so the URL stays clean.
    if (target === 'table') params.set('view', 'table')
    const qs = params.toString()
    return qs ? `/scrape?${qs}` : '/scrape'
  }
  const opts = [
    { key: 'board' as const, label: 'Board' },
    { key: 'table' as const, label: 'Table' },
  ]
  return (
    <div className="inline-flex rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-0.5">
      {opts.map(opt => {
        const active = current === opt.key
        return (
          <Link
            key={opt.key}
            href={buildHref(opt.key)}
            className={[
              'rounded px-2.5 py-1 text-[11px] font-medium transition-colors',
              active
                ? 'bg-[color:var(--color-accent)]/20 text-[color:var(--color-text-primary)]'
                : 'text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]',
            ].join(' ')}
          >
            {opt.label}
          </Link>
        )
      })}
    </div>
  )
}
