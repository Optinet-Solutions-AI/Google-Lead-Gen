import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Rows that can be cloned by a re-run path. All clone helpers work off
 * these three keys — everything else on the queue row is copy-through.
 */
export type ClonableRow = {
  keyword: string
  country_code: string
  search_engine: string | null
}

const ACTIVE_STATUSES = ['pending', 'running', 'needs_human'] as const

/**
 * Filter out rows whose (keyword, country_code, search_engine) triple
 * already has an in-flight sibling in scrape_queue (status ∈ pending /
 * running / needs_human). Prevents the duplicate-clone explosion that
 * multiple retry passes caused on 2026-07-20.
 *
 * Returns the safe-to-clone subset + a count of what was skipped, plus
 * human-readable skipped-keys so the caller can surface them.
 *
 * Terminal statuses (completed / captcha / failed / cancelled) do NOT
 * count as in-flight — a fresh retry is fine when nothing is actively
 * working on the same keyword.
 */
export async function filterOutInFlight<T extends ClonableRow>(
  svc: SupabaseClient,
  rows: T[],
): Promise<{ safe: T[]; skipped: T[]; skippedKeys: string[] }> {
  if (rows.length === 0) return { safe: [], skipped: [], skippedKeys: [] }

  const normalizeEngine = (e: string | null) => e ?? 'google'
  const rowKey = (r: ClonableRow) =>
    `${r.keyword}|${r.country_code}|${normalizeEngine(r.search_engine)}`

  // Batch by unique keyword — Supabase JS doesn't support IN over
  // composite keys, and querying by keyword alone is precise enough
  // (we filter the results locally by the full triple).
  const uniqueKeywords = Array.from(new Set(rows.map(r => r.keyword)))
  const inFlight = new Set<string>()

  const BATCH = 100
  for (let i = 0; i < uniqueKeywords.length; i += BATCH) {
    const chunk = uniqueKeywords.slice(i, i + BATCH)
    const { data, error } = await svc
      .from('scrape_queue')
      .select('keyword, country_code, search_engine')
      .in('keyword', chunk)
      .in('status', ACTIVE_STATUSES as unknown as string[])
      .is('parent_scrape_job_id', null)
    if (error) throw error
    for (const r of ((data ?? []) as ClonableRow[])) {
      inFlight.add(rowKey(r))
    }
  }

  const safe: T[] = []
  const skipped: T[] = []
  for (const r of rows) {
    if (inFlight.has(rowKey(r))) skipped.push(r)
    else safe.push(r)
  }

  const skippedKeys = Array.from(
    new Set(
      skipped.map(r => `"${r.keyword}" (${r.country_code}, ${normalizeEngine(r.search_engine)})`),
    ),
  )

  return { safe, skipped, skippedKeys }
}
