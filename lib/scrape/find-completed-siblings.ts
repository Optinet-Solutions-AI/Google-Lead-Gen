import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ClonableRow } from './filter-in-flight'

/**
 * Duplicate-work guard. For each (keyword, country_code, search_engine)
 * triple in `rows`, find whether a PRIOR run already COMPLETED — at any
 * point in history (per the 2026-07-27 operator decision: "ever, but
 * show the date so the user can decide whether to re-run").
 *
 * This is the piece that was missing everywhere: every existing dedup
 * (filter-in-flight.ts, the _retry-* scripts) only checked in-flight
 * statuses, so a keyword that failed-then-succeeded kept getting
 * re-cloned, and manual re-runs of an already-completed keyword were
 * never flagged. See scripts/qa/_diagnose-dup-reruns.ts — 777 redundant
 * completions across 267 keyword groups before this landed.
 *
 * Returns a map keyed by the same rowKey filter-in-flight uses, so
 * callers can line results up against their input rows. Each entry
 * carries the most-recent completion's date + who ran it + how many
 * times it's completed, which is exactly what the "already done"
 * warning surfaces to the operator.
 */

export type CompletedSibling = {
  /** ISO timestamp of the most recent completed run. */
  latestCompletedAt: string
  /** created_by_display / username / email of that most recent run. */
  latestBy: string | null
  /** How many completed runs exist for this triple (all history). */
  completedCount: number
}

const normalizeEngine = (e: string | null) => e ?? 'google'
export const siblingRowKey = (r: ClonableRow) =>
  `${r.keyword}|${r.country_code}|${normalizeEngine(r.search_engine)}`

export async function findCompletedSiblings<T extends ClonableRow>(
  svc: SupabaseClient,
  rows: T[],
): Promise<Map<string, CompletedSibling>> {
  const result = new Map<string, CompletedSibling>()
  if (rows.length === 0) return result

  const uniqueKeywords = Array.from(new Set(rows.map(r => r.keyword)))
  const wanted = new Set(rows.map(siblingRowKey))

  const BATCH = 100
  for (let i = 0; i < uniqueKeywords.length; i += BATCH) {
    const chunk = uniqueKeywords.slice(i, i + BATCH)
    const { data, error } = await svc
      .from('scrape_queue')
      .select('keyword, country_code, search_engine, completed_at, created_by_display, created_by_username, created_by_email')
      .in('keyword', chunk)
      .eq('status', 'completed')
      .is('parent_scrape_job_id', null)
    if (error) throw error
    for (const r of ((data ?? []) as Array<{
      keyword: string
      country_code: string
      search_engine: string | null
      completed_at: string | null
      created_by_display: string | null
      created_by_username: string | null
      created_by_email: string | null
    }>)) {
      const key = siblingRowKey(r)
      if (!wanted.has(key)) continue
      const who = r.created_by_display || r.created_by_username || r.created_by_email || null
      const at = r.completed_at ?? ''
      const existing = result.get(key)
      if (!existing) {
        result.set(key, { latestCompletedAt: at, latestBy: who, completedCount: 1 })
      } else {
        existing.completedCount += 1
        if (at && at > existing.latestCompletedAt) {
          existing.latestCompletedAt = at
          existing.latestBy = who
        }
      }
    }
  }

  return result
}
