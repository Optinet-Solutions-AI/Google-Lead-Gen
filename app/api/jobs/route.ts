import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { parseFilters, parseSorts } from '@/lib/filters/serialize'
import { clampPageSize } from '@/lib/page-size'
import { queryJobs } from '@/app/(dashboard)/scrape/_lib/queries'

export const dynamic = 'force-dynamic'

const DEFAULT_PAGE_SIZE = 20

/**
 * JSON list of scrape-queue jobs for the infinite-scroll loader on
 * /scrape. Mirrors the search params the page already parses so a
 * scroll fetch returns rows that match the current view exactly.
 *
 * Auth gate matches the page itself — the dashboard layout already
 * blocks anonymous users, but the API route is also reachable directly
 * so we re-check here.
 */
export async function GET(req: NextRequest) {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const page = clampInt(sp.get('page'), 1, 1_000_000, 1)
  const size = clampPageSize(sp.get('size') ?? undefined, DEFAULT_PAGE_SIZE)
  const q = sp.get('q') ?? ''
  const filters = parseFilters(sp.get('f') ?? undefined)
  const sorts = parseSorts(sp.get('s') ?? undefined)
  // Mirror the /scrape page exactly: "Load more" and infinite scroll call
  // this with the current URL params verbatim, so the day and owner scope
  // have to resolve the same way or the extra pages would ignore them.
  const ownerParam = (sp.get('owner') ?? '').toLowerCase()
  const ownerScope = ownerParam === 'all' ? 'all' : ownerParam.includes('@') ? ownerParam : 'mine'
  const callerEmail = (user.email ?? '').toLowerCase() || null
  const restrictToOwnerEmail =
    ownerScope === 'mine' ? (callerEmail ?? undefined) : ownerScope === 'all' ? undefined : ownerScope

  const today = new Date().toISOString().slice(0, 10)
  const dayParam = sp.get('day') ?? ''
  const day = dayParam === 'all' ? 'all' : /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : today

  try {
    const result = await queryJobs({
      page,
      size,
      q,
      filters,
      sorts,
      ...(restrictToOwnerEmail ? { restrictToOwnerEmail } : {}),
      ...(day !== 'all' ? { onDay: day } : {}),
    })
    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'private, no-cache, must-revalidate',
      },
    })
  } catch (err) {
    console.error('[api/jobs]', err)
    return NextResponse.json({ error: 'Failed to load jobs.' }, { status: 500 })
  }
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

