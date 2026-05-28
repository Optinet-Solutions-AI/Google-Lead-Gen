import { createClient } from '@supabase/supabase-js'
import { BOARDS } from '@/lib/monday/board-registry'

export const dynamic = 'force-dynamic'

const STALE_THRESHOLD_HOURS = 24

/**
 * Health endpoint for the Monday replica sync. Reports max(synced_at)
 * for each of the 4 board tables so a scheduled remote agent (or any
 * monitor) can detect when a per-board cron has stopped landing rows.
 *
 * Public (no bearer) — returns only timestamps + counts, no item data.
 * Used by the 2026-05-31 verification routine that confirms the
 * per-board cron split (commit 2bf5593) actually held.
 */
export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return Response.json(
      { error: 'Supabase env not set on server' },
      { status: 500 },
    )
  }
  const svc = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const now = Date.now()
  const boards = await Promise.all(
    BOARDS.map(async board => {
      const { data, error } = await svc
        .from(board.items_table)
        .select('synced_at')
        .order('synced_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) {
        return {
          key: board.key,
          table: board.items_table,
          newest_synced_at: null,
          age_hours: null,
          stale: true,
          error: error.message,
        }
      }
      const newest = data?.synced_at ?? null
      const ageHours = newest
        ? (now - new Date(newest).getTime()) / 36e5
        : null
      return {
        key: board.key,
        table: board.items_table,
        newest_synced_at: newest,
        age_hours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
        stale: ageHours == null ? true : ageHours > STALE_THRESHOLD_HOURS,
      }
    }),
  )

  const staleCount = boards.filter(b => b.stale).length
  return Response.json({
    checked_at: new Date(now).toISOString(),
    stale_threshold_hours: STALE_THRESHOLD_HOURS,
    stale_count: staleCount,
    all_fresh: staleCount === 0,
    boards,
  })
}
