import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { BOARDS } from '@/lib/monday/board-registry'
import type { DateRange } from './date-range'

/**
 * Queries for the Phase 4 Monday Analytics dashboard. Aggregates
 * across every mirrored board (BOARDS from board-registry.ts). Each
 * board's items_table has a synced_at column (when we last mirrored)
 * plus board-specific columns; we only touch the shared ones (id,
 * synced_at) so this stays board-schema-agnostic.
 */

const PER_BOARD_ROW_CAP = 3000

export type BoardSnapshot = {
  key: string
  label: string
  itemsTable: string
  totalItems: number
  itemsInWindow: number
  latestSyncedAt: string | null
  ageMinutes: number | null
  isStale: boolean
}

export type MondayAnalyticsData = {
  boards: BoardSnapshot[]
  /** Every synced_at timestamp across all boards in the window,
   *  bucketable into a trend + heatmap. */
  syncedTimestamps: string[]
  /** Per-board mirror-sync activity for the leaderboard. */
  boardActivityLeader: Array<{ label: string; value: number }>
}

export async function loadMondayAnalyticsData(range: DateRange): Promise<MondayAnalyticsData> {
  const svc = createServiceClient()
  const now = Date.now()

  const boards: BoardSnapshot[] = []
  const allSynced: string[] = []
  const boardActivityMap = new Map<string, number>()

  for (const b of BOARDS) {
    const [{ count: totalItems }, { data: inWindow }, { data: latest }] = await Promise.all([
      svc.from(b.items_table).select('id', { count: 'exact', head: true }),
      svc
        .from(b.items_table)
        .select('id, synced_at')
        .gte('synced_at', range.since)
        .lte('synced_at', range.until)
        .limit(PER_BOARD_ROW_CAP),
      svc.from(b.items_table).select('synced_at').order('synced_at', { ascending: false }).limit(1),
    ])
    const windowRows = (inWindow ?? []) as Array<{ synced_at: string | null }>
    const itemsInWindow = windowRows.length
    for (const r of windowRows) if (r.synced_at) allSynced.push(r.synced_at)
    boardActivityMap.set(b.monday_board_name, itemsInWindow)

    const latestSyncedAt =
      latest && latest.length > 0 && (latest[0] as { synced_at: string | null }).synced_at
        ? (latest[0] as { synced_at: string }).synced_at
        : null
    const ageMinutes = latestSyncedAt
      ? Math.round((now - new Date(latestSyncedAt).getTime()) / 60_000)
      : null
    const isStale = ageMinutes === null || ageMinutes > 24 * 60

    boards.push({
      key: b.key,
      label: b.monday_board_name,
      itemsTable: b.items_table,
      totalItems: totalItems ?? 0,
      itemsInWindow,
      latestSyncedAt,
      ageMinutes,
      isStale,
    })
  }

  const boardActivityLeader = Array.from(boardActivityMap.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([label, value]) => ({ label, value }))

  return { boards, syncedTimestamps: allSynced, boardActivityLeader }
}

/**
 * S-tag match ratio: over the window's s_tags_table rows, what
 * fraction map to a Monday item? Kept in the Monday dashboard because
 * it's the primary "how many affiliates are we already tracking vs
 * missing" answer.
 */
export type StagMatchStats = {
  totalTags: number
  matchedTags: number
  unmatchedTags: number
  matchPct: number
}

export async function loadStagMatchStats(range: DateRange): Promise<StagMatchStats> {
  const svc = createServiceClient()
  const { data } = await svc
    .from('s_tags_table')
    .select('id, is_existing_on_monday')
    .gte('created_at', range.since)
    .lte('created_at', range.until)
    .not('s_tag', 'is', null)
    .limit(20000)
  const rows = (data ?? []) as Array<{ is_existing_on_monday: boolean | null }>
  const totalTags = rows.length
  const matchedTags = rows.filter(r => !!r.is_existing_on_monday).length
  const unmatchedTags = totalTags - matchedTags
  const matchPct = totalTags > 0 ? Math.round((matchedTags / totalTags) * 100) : 0
  return { totalTags, matchedTags, unmatchedTags, matchPct }
}
