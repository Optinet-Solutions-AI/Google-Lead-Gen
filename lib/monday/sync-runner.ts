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

type MondayItemWithUpdates = MondayItem & { updates: MondayUpdate[] }
type ItemsPage = { cursor: string | null; items: MondayItemWithUpdates[] }

const ITEM_FIELDS_WITH_UPDATES = `
  ${ITEM_FIELDS}
  updates(limit: ${UPDATES_PER_ITEM}) {
    ${UPDATE_FIELDS}
  }
`

async function fetchFirstPage(boardId: string): Promise<ItemsPage> {
  const data = await mondayGQL<{ boards: Array<{ items_page: ItemsPage }> }>(
    `query ($id: [ID!], $limit: Int!) {
      boards(ids: $id) {
        items_page(limit: $limit) {
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
  pages: number
  items: number
  updates: number
  ms: number
  error?: string
}

async function syncBoard(
  supabase: SupabaseClient,
  board: BoardConfig,
  onProgress?: (msg: string) => void,
): Promise<SyncBoardResult> {
  const startedAt = Date.now()
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
        `[${board.monday_board_name}] page ${pageNumber}: ${itemRows.length} items (+${updateRows.length} updates) — total items ${totalItems}`,
      )

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
      pages: pageNumber,
      items: totalItems,
      updates: totalUpdates,
      ms: Date.now() - startedAt,
    }
  } catch (err) {
    return {
      board: board.monday_board_name,
      board_id: board.monday_board_id,
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
 *  own 300s function budget (the combined sync was running out of time
 *  on the leads board and starving affiliates/not_relevant/email_undelivered).
 */
export async function runMondaySync(opts?: {
  supabase?: SupabaseClient
  onProgress?: (msg: string) => void
  boardKey?: BoardKey
}): Promise<SyncRunResult> {
  const supabase = opts?.supabase ?? defaultSupabase()
  const startedAt = Date.now()
  const results: SyncBoardResult[] = []
  const boards = opts?.boardKey
    ? BOARDS.filter(b => b.key === opts.boardKey)
    : BOARDS
  for (const board of boards) {
    const r = await syncBoard(supabase, board, opts?.onProgress)
    results.push(r)
  }
  return {
    ok: results.every(r => !r.error),
    ms: Date.now() - startedAt,
    results,
  }
}
