// NOTE: do NOT add `import 'server-only'` here. This module is also
// loaded by the Node CLI script (scripts/monday/sync.ts), and the
// `server-only` package throws unconditionally in plain Node contexts.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { BOARDS, type BoardConfig, type BoardKey } from '@/lib/monday/board-registry'
import { mondayGQL, sleep, ITEM_FIELDS, UPDATE_FIELDS } from '@/lib/monday/graphql'
import {
  mapItemToRow,
  mapUpdateToRow,
  type MondayItem,
  type MondayUpdate,
} from '@/lib/monday/row-mapping'

const ITEMS_PER_PAGE = 25
const UPDATES_PER_ITEM = 100
const BATCH_UPSERT_SIZE = 200
const SLEEP_BETWEEN_REQUESTS_MS = 700

// Incremental sync re-pulls only items updated since the newest one already
// in the replica. The overlap margin re-fetches a slice on either side of the
// boundary so an item updated mid-run (or with slight clock skew) can't slip
// through the crack between two runs. Re-upserting a few rows is idempotent.
const HIGH_WATER_OVERLAP_MS = 60 * 60 * 1000 // 1 hour

type MondayItemWithUpdates = MondayItem & { updates: MondayUpdate[] }
type ItemsPage = { cursor: string | null; items: MondayItemWithUpdates[] }

const ITEM_FIELDS_WITH_UPDATES = `
  ${ITEM_FIELDS}
  updates(limit: ${UPDATES_PER_ITEM}) {
    ${UPDATE_FIELDS}
  }
`

// Always order newest-updated first. For a full sync this is harmless; for an
// incremental sync it's what lets us stop early at the high-water mark. The
// "__last_updated__" system column is confirmed working on this account
// (API 2025-07). The cursor returned by an ordered items_page carries the
// ordering forward, so next_items_page needs no query_params of its own.
const ITEMS_ORDER_BY = `query_params: { order_by: [{ column_id: "__last_updated__", direction: desc }] }`

async function fetchFirstPage(boardId: string): Promise<ItemsPage> {
  const data = await mondayGQL<{ boards: Array<{ items_page: ItemsPage }> }>(
    `query ($id: [ID!], $limit: Int!) {
      boards(ids: $id) {
        items_page(limit: $limit, ${ITEMS_ORDER_BY}) {
          cursor
          items { ${ITEM_FIELDS_WITH_UPDATES} }
        }
      }
    }`,
    { id: [boardId], limit: ITEMS_PER_PAGE },
  )
  const page = data.boards[0]?.items_page
  if (!page) throw new Error(`board ${boardId} returned no items_page`)
  return page
}

async function fetchNextPage(cursor: string): Promise<ItemsPage> {
  const data = await mondayGQL<{ next_items_page: ItemsPage }>(
    `query ($cursor: String!, $limit: Int!) {
      next_items_page(cursor: $cursor, limit: $limit) {
        cursor
        items { ${ITEM_FIELDS_WITH_UPDATES} }
      }
    }`,
    { cursor, limit: ITEMS_PER_PAGE },
  )
  return data.next_items_page
}

async function upsertBatch(
  supabase: SupabaseClient,
  table: string,
  rows: Record<string, unknown>[],
  conflict: string,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH_UPSERT_SIZE) {
    const batch = rows.slice(i, i + BATCH_UPSERT_SIZE)
    const { error } = await supabase.from(table).upsert(batch, { onConflict: conflict })
    if (error) {
      throw new Error(
        `upsert to ${table} failed: ${error.message} (details: ${JSON.stringify(
          error.details ?? {},
        )})`,
      )
    }
  }
}

export type SyncBoardResult = {
  board: string
  board_id: string
  mode: 'full' | 'incremental'
  pages: number
  items: number
  updates: number
  ms: number
  error?: string
}

/**
 * Newest item already in the replica, as epoch ms, minus the overlap margin.
 * This is the incremental high-water mark — items updated after it are the
 * only ones we need to re-pull. Returns null when the table is empty (or the
 * timestamp is unreadable), signalling a full backfill.
 */
async function getHighWaterMark(
  supabase: SupabaseClient,
  board: BoardConfig,
): Promise<number | null> {
  const { data, error } = await supabase
    .from(board.items_table)
    .select('monday_updated_at')
    .not('monday_updated_at', 'is', null)
    .order('monday_updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error || !data) return null
  const raw = (data as { monday_updated_at: string | null }).monday_updated_at
  const t = raw ? Date.parse(raw) : NaN
  return Number.isFinite(t) ? t - HIGH_WATER_OVERLAP_MS : null
}

async function syncBoard(
  supabase: SupabaseClient,
  board: BoardConfig,
  opts?: { since?: number | undefined; onProgress?: ((msg: string) => void) | undefined },
): Promise<SyncBoardResult> {
  const startedAt = Date.now()
  const since = opts?.since
  const onProgress = opts?.onProgress
  const mode: 'full' | 'incremental' = since != null ? 'incremental' : 'full'
  let pageNumber = 0
  let totalItems = 0
  let totalUpdates = 0

  try {
    let page = await fetchFirstPage(board.monday_board_id)
    while (true) {
      pageNumber++
      const itemRows = page.items.map(item => mapItemToRow(item, board))
      const updateRows: Record<string, unknown>[] = []
      for (const item of page.items) {
        for (const upd of item.updates ?? []) {
          updateRows.push(mapUpdateToRow(upd, item.id))
        }
      }

      await upsertBatch(supabase, board.items_table, itemRows, 'monday_item_id')
      if (updateRows.length > 0) {
        await upsertBatch(supabase, board.updates_table, updateRows, 'monday_update_id')
      }

      totalItems += itemRows.length
      totalUpdates += updateRows.length
      onProgress?.(
        `[${board.monday_board_name}] ${mode} page ${pageNumber}: ${itemRows.length} items (+${updateRows.length} updates) — total items ${totalItems}`,
      )

      // Incremental early-stop: pages arrive newest-updated first, so once a
      // page reaches an item at/older than the high-water mark, every
      // remaining page is older still — all changes are covered. We process
      // the whole boundary page (idempotent) before stopping.
      if (since != null) {
        const crossedBoundary = page.items.some(it => {
          const t = it.updated_at ? Date.parse(it.updated_at) : NaN
          return Number.isFinite(t) && t <= since
        })
        if (crossedBoundary) break
      }

      // Only `null`/`undefined` signals "no more pages". An empty
      // string is a valid (if unusual) cursor — treating it as
      // terminal silently truncates the sync mid-stream.
      if (page.cursor == null) break
      await sleep(SLEEP_BETWEEN_REQUESTS_MS)
      page = await fetchNextPage(page.cursor)
    }

    return {
      board: board.monday_board_name,
      board_id: board.monday_board_id,
      mode,
      pages: pageNumber,
      items: totalItems,
      updates: totalUpdates,
      ms: Date.now() - startedAt,
    }
  } catch (err) {
    return {
      board: board.monday_board_name,
      board_id: board.monday_board_id,
      mode,
      pages: pageNumber,
      items: totalItems,
      updates: totalUpdates,
      ms: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export type SyncRunResult = {
  ok: boolean
  ms: number
  results: SyncBoardResult[]
}

function defaultSupabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

/** Re-sync one or all Monday boards. Continues past per-board failures
 *  so a single bad board doesn't take down the rest of the run.
 *
 *  Pass `boardKey` to sync a single board — used by Vercel crons that
 *  split the four boards across separate invocations so each gets its
 *  own 300s function budget.
 *
 *  Incremental by default: only items updated since the newest one already
 *  in the replica are re-pulled (see getHighWaterMark / the newest-first
 *  early-stop in syncBoard). This is what keeps the leads board inside the
 *  300s budget. An empty replica table falls back to a full backfill.
 *
 *  Pass `full: true` for a complete re-pull — used by a weekly self-heal
 *  cron to catch drift an updated_at-incremental can't see (new entries in
 *  the Updates feed that don't bump the item's updated_at). Real-time
 *  webhooks cover those between full runs.
 */
export async function runMondaySync(opts?: {
  supabase?: SupabaseClient
  onProgress?: (msg: string) => void
  boardKey?: BoardKey
  full?: boolean
}): Promise<SyncRunResult> {
  const supabase = opts?.supabase ?? defaultSupabase()
  const startedAt = Date.now()
  const results: SyncBoardResult[] = []
  const boards = opts?.boardKey
    ? BOARDS.filter(b => b.key === opts.boardKey)
    : BOARDS
  for (const board of boards) {
    // null high-water mark (empty table) → full backfill regardless of flag.
    const since = opts?.full ? undefined : (await getHighWaterMark(supabase, board)) ?? undefined
    const r = await syncBoard(supabase, board, { since, onProgress: opts?.onProgress })
    results.push(r)
  }
  return {
    ok: results.every(r => !r.error),
    ms: Date.now() - startedAt,
    results,
  }
}
