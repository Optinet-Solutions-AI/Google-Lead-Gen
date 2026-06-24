import { JOBS_COLUMNS } from '@/lib/filters/columns-jobs'
import { parseFilters, parseSorts } from '@/lib/filters/serialize'
import type { ColumnDef } from '@/lib/filters/types'
import { clampPageSize } from '@/lib/page-size'
import { getQuotaForCurrentUser } from '@/lib/scrape-quota'
import { applyShadowFilter, getShadowContext } from '@/lib/shadow-filter'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { getUserPreferences } from '@/lib/user-preferences'
import { createServiceClient } from '@/lib/supabase/service'
import { AdvancedFilters } from '../_components/advanced-filters'
import { Pagination } from '../monday/_components/pagination'
import { AutoRefresh } from './_components/auto-refresh'
import { EnqueueForm } from './_components/enqueue-form'
import { JobsCardList, JobsTable } from './_components/jobs-table'
import { OwnerScopeToggle } from './_components/owner-scope-toggle'
import { listActiveProfiles, queryJobs } from './_lib/queries'

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
  const size = clampPageSize(sp.size, DEFAULT_PAGE_SIZE)
  const q = typeof sp.q === 'string' ? sp.q : ''
  const filters = parseFilters(sp.f)
  const sorts = parseSorts(sp.s)
  const hasAnyFilter = q.length > 0 || filters.length > 0 || sorts.length > 0

  // Mine / All scope toggle. Default Mine — operators usually want
  // to see their own work first; ?owner=all opens the full view.
  const ownerScope: 'mine' | 'all' = sp.owner === 'all' ? 'all' : 'mine'
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const callerEmail = (user?.email ?? '').toLowerCase() || null

  // Only filter to Mine when we have an email to filter by — anonymous
  // / missing-email accounts fall through to the All view so the page
  // isn't blank for them.
  const restrictToOwnerEmail =
    ownerScope === 'mine' && callerEmail ? callerEmail : undefined

  const [profiles, jobsResult, isAdmin, prefs, quotaSnap, mineCount, allCount] = await Promise.all([
    listActiveProfiles(),
    queryJobs({
      page,
      size,
      q,
      filters,
      sorts,
      ...(restrictToOwnerEmail ? { restrictToOwnerEmail } : {}),
    }),
    (async () => {
      if (!user) return false
      const svc = createServiceClient()
      const { data } = await svc.rpc('is_admin', { p_user_id: user.id })
      return data === true
    })(),
    getUserPreferences(),
    getQuotaForCurrentUser(),
    // Independent counts for the toggle pills. Head-only queries; the
    // shadow filter still applies so the Mine / All numbers respect
    // shadow isolation. parent_scrape_job_id is null mirrors what
    // queryJobs filters out (kick phase-2 child jobs).
    (async () => {
      if (!callerEmail) return 0
      const svc = createServiceClient()
      const ctx = await getShadowContext()
      const base = svc
        .from('scrape_queue')
        .select('id', { count: 'exact', head: true })
        .is('parent_scrape_job_id', null)
        .eq('created_by_email', callerEmail)
      const { count } = await (applyShadowFilter(base, ctx) as typeof base)
      return count ?? 0
    })(),
    (async () => {
      const svc = createServiceClient()
      const ctx = await getShadowContext()
      const base = svc
        .from('scrape_queue')
        .select('id', { count: 'exact', head: true })
        .is('parent_scrape_job_id', null)
      const { count } = await (applyShadowFilter(base, ctx) as typeof base)
      return count ?? 0
    })(),
  ])
  // Pass through only non-exempt snapshots so the EnqueueForm
  // doesn't render the badge for admins or when caps are disabled.
  const quota =
    !quotaSnap.exempt && quotaSnap.cap !== null && quotaSnap.remaining !== null
      ? { cap: quotaSnap.cap, usedToday: quotaSnap.usedToday, remaining: quotaSnap.remaining }
      : null
  const { rows, total } = jobsResult

  // Auto-refresh stays on while either the scrape itself OR a follow-on
  // enrichment chain is still in flight, so the badge can transition from
  // "enriching" to "completed" without a manual reload.
  const hasActive = rows.some(
    j =>
      j.status === 'pending' ||
      j.status === 'running' ||
      (j.status === 'completed' &&
        j.with_enrichment &&
        j.enrichment_status !== 'complete'),
  )

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

      <EnqueueForm profiles={profiles} quota={quota} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-[13px] font-semibold text-[color:var(--color-text-primary)]">
              {hasAnyFilter
                ? `${total.toLocaleString()} matching jobs`
                : ownerScope === 'mine'
                  ? 'My recent jobs'
                  : 'Recent jobs'}
            </h2>
            <OwnerScopeToggle
              current={ownerScope}
              mineCount={mineCount}
              allCount={allCount}
            />
          </div>
          {hasActive && (
            <p className="text-[11px] text-[color:var(--color-text-secondary)]">
              auto-refreshing every 5 s
            </p>
          )}
        </div>

        <AdvancedFilters columns={columns} />

        <JobsTable
          jobs={rows}
          isAdmin={isAdmin}
          pageInfo={{ page, size, total }}
          infiniteScrollEnabled={prefs.infiniteScrollEnabled}
        />
        <JobsCardList jobs={rows} />
      </section>

      <Pagination page={page} size={size} total={total} pageSizeOptions={PAGE_SIZES} />

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

