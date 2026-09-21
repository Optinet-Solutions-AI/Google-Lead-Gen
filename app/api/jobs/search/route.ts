import type { NextRequest } from 'next/server'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { queryJobs } from '@/app/(dashboard)/scrape/_lib/queries'

export const dynamic = 'force-dynamic'

/**
 * Advanced search over scrape batches.
 *
 * Deliberately separate from /api/jobs: this takes its OWN filters and
 * ignores the list's day/owner scope entirely, because a search that is
 * silently narrowed by whatever the page happens to be showing is the
 * confusing behaviour we are replacing.
 *
 * Ranking and fuzzy matching live in search_scrape_jobs(); this route just
 * authenticates, applies shadow isolation, and hydrates the rows.
 */
export async function POST(req: NextRequest) {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'Not signed in.' }, { status: 401 })

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: 'Bad JSON body.' }, { status: 400 })
  }

  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  const arr = (v: unknown) =>
    Array.isArray(v) && v.length > 0 ? v.filter((x): x is string => typeof x === 'string') : null
  const day = (v: unknown) => {
    const s = str(v)
    return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
  }
  const num = (v: unknown, dflt: number, max: number) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : dflt
  }

  const limit = num(body.limit, 50, 200)
  const offset = num(body.offset, 0, 100_000)

  const svc = createServiceClient()
  const { data, error } = await svc.rpc('search_scrape_jobs', {
    p_query: str(body.query) ?? '',
    p_countries: arr(body.countries),
    p_engines: arr(body.engines),
    p_statuses: arr(body.statuses),
    p_sources: arr(body.sources),
    p_owners: arr(body.owners)?.map(o => o.toLowerCase()) ?? null,
    p_from: day(body.from),
    p_to: day(body.to),
    p_enrichment: str(body.enrichment),
    p_limit: limit,
    p_offset: offset,
  })
  if (error) {
    console.error('[api/jobs/search]', error)
    return Response.json({ error: 'Search failed.' }, { status: 500 })
  }

  const hits = (data ?? []) as Array<{ job_id: string; score: number; reasons: string[] | null; total_count: number }>
  if (hits.length === 0) return Response.json({ rows: [], total: 0 })

  const ids = hits.map(h => h.job_id)

  // Reuse queryJobs purely to hydrate: it already folds in the PPC sibling,
  // enrichment, kick and social detail, and applies shadow isolation. The
  // ranking stays with the SQL function.
  const { rows } = await queryJobs({ page: 1, size: ids.length, restrictToIds: ids })

  const byId = new Map(rows.map(r => [r.id, r]))
  const meta = new Map(hits.map(h => [h.job_id, h]))
  const ordered = ids
    .map(id => byId.get(id))
    .filter(r => Boolean(r))
    .map(r => ({
      ...r!,
      matchScore: meta.get(r!.id)?.score ?? 0,
      matchReasons: meta.get(r!.id)?.reasons ?? [],
    }))

  return Response.json({ rows: ordered, total: hits[0]?.total_count ?? ordered.length })
}
