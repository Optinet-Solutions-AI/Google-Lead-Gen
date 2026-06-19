import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { parseFilters, parseSorts } from '@/lib/filters/serialize'
import { clampPageSize } from '@/lib/page-size'
import {
  DEFAULT_LEAD_PAGE_SIZE,
  queryLeads,
} from '@/app/(dashboard)/leads/_lib/query'

export const dynamic = 'force-dynamic'

/**
 * JSON list of leads for the infinite-scroll loader on /leads.
 *
 * Mirrors the params the page already parses from search params so a
 * scroll fetch returns rows that match the current view exactly. The
 * client appends `rows` to its in-memory list and stops fetching
 * when `rows.length < size` (last page) or its accumulated count
 * reaches `total`.
 *
 * Auth gate matches the page itself — the dashboard layout already
 * blocks anonymous users, but the API route is also hit from cached
 * pages so we re-check here.
 */
export async function GET(req: NextRequest) {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const page = clampInt(sp.get('page'), 1, 1_000_000, 1)
  const size = clampPageSize(sp.get('size') ?? undefined, DEFAULT_LEAD_PAGE_SIZE)
  const sort = sp.get('sort') ?? 'overall_position'
  const order: 'asc' | 'desc' = sp.get('order') === 'asc' ? 'asc' : 'desc'
  const q = sp.get('q') ?? ''
  const countryCode = sp.get('country_code') ?? ''
  const resultType = sp.get('result_type') ?? ''
  const scrapeJobId = sp.get('scrape_job_id') ?? undefined
  const filters = parseFilters(sp.get('f') ?? undefined)
  const sorts = parseSorts(sp.get('s') ?? undefined)
  const includeNotRelevant = sp.get('show_hidden') === '1'

  try {
    const result = await queryLeads({
      page,
      size,
      sort,
      order,
      q,
      countryCode,
      resultType,
      ...(scrapeJobId ? { scrapeJobId } : {}),
      filters,
      sorts,
      includeNotRelevant,
    })
    return NextResponse.json(result, {
      headers: {
        // The dashboard fetches with cache:'no-store' anyway; belt-
        // and-suspenders against intermediate caches.
        'Cache-Control': 'private, no-cache, must-revalidate',
      },
    })
  } catch (err) {
    console.error('[api/leads]', err)
    return NextResponse.json({ error: 'Failed to load leads.' }, { status: 500 })
  }
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

