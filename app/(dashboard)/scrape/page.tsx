import { JOBS_COLUMNS } from '@/lib/filters/columns-jobs'
import { parseFilters, parseSorts } from '@/lib/filters/serialize'
import type { ColumnDef } from '@/lib/filters/types'
import { clampPageSize } from '@/lib/page-size'
import { applyShadowFilter, getShadowContext } from '@/lib/shadow-filter'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { getUserPreferences } from '@/lib/user-preferences'
import { createServiceClient } from '@/lib/supabase/service'
import { AdvancedFilters } from '../_components/advanced-filters'
import { Pagination } from '../monday/_components/pagination'
import { AutoRefresh } from './_components/auto-refresh'
import { JobsCardList, JobsTable } from './_components/jobs-table'
import { ScopeBar, type ScopeUser } from './_components/scope-bar'
import { CreateScrapeFab, CreateScrapeHeaderButton } from './_components/create-scrape-button'
import { EmptyDay } from './_components/empty-day'
import { getFleetQueueSnapshot, listActiveProfiles, queryJobs } from './_lib/queries'

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

  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const callerEmail = (user?.email ?? '').toLowerCase() || null

  // Day scope. Default today (UTC) so the list opens on what is happening
  // now; ?day=all widens it, ?day=YYYY-MM-DD picks a past day.
  const today = new Date().toISOString().slice(0, 10)
  const dayParam = typeof sp.day === 'string' ? sp.day : ''
  // A search is a lookup across everything, so it widens the day scope on its
  // own — otherwise searching on a quiet day returns nothing and looks
  // broken. An explicitly chosen day still wins.
  const day: string =
    dayParam === 'all' ? 'all'
      : /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam
      : q.trim().length > 0 ? 'all'
      : today

  // Owner scope. Default mine; 'all' drops the filter; anything else is a
  // specific person's email chosen from the picker.
  const ownerParam = typeof sp.owner === 'string' ? sp.owner.toLowerCase() : ''
  const ownerScope = ownerParam === 'all' ? 'all' : ownerParam.includes('@') ? ownerParam : 'mine'

  // Only filter to Mine when we have an email to filter by — anonymous
  // / missing-email accounts fall through to the everyone view so the page
  // isn't blank for them.
  const restrictToOwnerEmail =
    ownerScope === 'mine' ? (callerEmail ?? undefined) : ownerScope === 'all' ? undefined : ownerScope

  const [profiles, jobsResult, isAdmin, prefs, fleet, scopeUsers] = await Promise.all([
    listActiveProfiles(),
    queryJobs({
      page,
      size,
      q,
      filters,
      sorts,
      ...(restrictToOwnerEmail ? { restrictToOwnerEmail } : {}),
      ...(day !== 'all' ? { onDay: day } : {}),
    }),
    (async () => {
      if (!user) return false
      const svc = createServiceClient()
      const { data } = await svc.rpc('is_admin', { p_user_id: user.id })
      return data === true
    })(),
    getUserPreferences(),
    getFleetQueueSnapshot(),
    // People who have queued a scrape, for the "someone else" picker. The
    // shadow filter applies so a non-shadow viewer never sees shadow owners.
    (async () => {
      const svc = createServiceClient()
      const ctx = await getShadowContext()
      const base = svc
        .from('scrape_queue')
        .select('created_by_email, created_by_display, created_by_username')
        .not('created_by_email', 'is', null)
        .order('created_at', { ascending: false })
        .limit(2000)
      const { data } = await (applyShadowFilter(base, ctx) as typeof base)
      const seen = new Map<string, ScopeUser>()
      for (const r of (data ?? []) as Array<{
        created_by_email: string | null
        created_by_display: string | null
        created_by_username: string | null
      }>) {
        const email = (r.created_by_email ?? '').toLowerCase()
        if (!email || seen.has(email)) continue
        seen.set(email, {
          email,
          label: r.created_by_display || r.created_by_username || email.split('@')[0] || email,
        })
      }
      return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label))
    })(),
  ])
  const { rows, total, searchNotes } = jobsResult

  // When the scope is empty we offer a jump to the last day with work rather
  // than rendering a blank page.
  let latestDay: string | null = null
  if (rows.length === 0) {
    const svc = createServiceClient()
    const ctx = await getShadowContext()
    let probe = svc
      .from('scrape_queue')
      .select('created_at')
      .is('parent_scrape_job_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
    if (restrictToOwnerEmail) probe = probe.eq('created_by_email', restrictToOwnerEmail)
    const { data: probeRows } = await (applyShadowFilter(probe, ctx) as typeof probe)
    const newest = ((probeRows ?? []) as Array<{ created_at: string }>)[0]?.created_at
    if (newest) latestDay = newest.slice(0, 10)
  }

  // Auto-refresh stays on while either the scrape itself OR a follow-on
  // enrichment chain is still in flight, so the badge can transition from
  // "enriching" to "completed" without a manual reload. It also stays on while a
  // Google batch's hidden background PPC sibling is still working, so the
  // "PPC scraping…" chip flips to "+N ads" on its own once the VM finishes.
  const hasActive = rows.some(
    j =>
      j.status === 'pending' ||
      j.status === 'running' ||
      (j.status === 'completed' &&
        j.with_enrichment &&
        j.enrichment_status !== 'complete') ||
      (j.ppc_status != null &&
        ['pending', 'running', 'captcha', 'paused'].includes(j.ppc_status)),
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
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            Scraping Batches
          </h1>
          {hasActive && (
            <p className="text-[11px] text-[color:var(--color-text-secondary)]">
              auto-refreshing every 5 s
            </p>
          )}
        </div>
        <CreateScrapeHeaderButton />
      </header>

      <ScopeBar today={today} day={day} owner={ownerScope} meEmail={callerEmail} users={scopeUsers} />

      <section className="flex flex-col gap-3">
        <AdvancedFilters columns={columns} />

        {q && searchNotes && searchNotes.length > 0 && (
          <p className="text-[11.5px] text-[color:var(--color-text-secondary)]">
            Search read: {searchNotes.join(' · ')}
          </p>
        )}

        {rows.length > 0 && (
        <p className="text-[11.5px] text-[color:var(--color-text-secondary)]">
          {total.toLocaleString()} {total === 1 ? 'batch' : 'batches'}
          {day !== 'all' && ` on ${day === today ? 'today' : day}`}
          {ownerScope === 'mine' ? ', queued by me' : ownerScope === 'all' ? ', queued by anyone' : ''}
          {hasAnyFilter && ' · extra filters applied'}
        </p>
        )}

        {rows.length === 0 ? (
          <EmptyDay
            day={day}
            today={today}
            ownerScope={ownerScope}
            latestDay={latestDay}
            params={new URLSearchParams(
              Object.entries(sp).flatMap(([k, v]) =>
                typeof v === 'string' ? [[k, v] as [string, string]] : [],
              ),
            ).toString()}
          />
        ) : (
          <>
            <JobsTable
              jobs={rows}
              isAdmin={isAdmin}
              pageInfo={{ page, size, total }}
              infiniteScrollEnabled={prefs.infiniteScrollEnabled}
              pendingPositions={fleet.positionsByJobId}
            />
            <JobsCardList
              jobs={rows}
              pendingPositions={fleet.positionsByJobId}
              pageInfo={{ page, size, total }}
            />
          </>
        )}
      </section>

      {/* Desktop pages via the chevrons; phones and tablets use the card
          list's own "Load more" instead, so this would be a second,
          contradictory control there. */}
      <div className="hidden lg:block">
        <Pagination page={page} size={size} total={total} pageSizeOptions={PAGE_SIZES} />
      </div>

      <CreateScrapeFab />

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

