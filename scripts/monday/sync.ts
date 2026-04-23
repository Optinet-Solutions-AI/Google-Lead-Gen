/**
 * Fetches all items + updates from 4 Monday boards and upserts them
 * into the Supabase replica tables created by
 * supabase/migrations/20260423120000_monday_replica_tables.sql.
 *
 * Idempotent: re-running on conflicting monday_item_id / monday_update_id
 * updates the row in place.
 *
 * Run:  npm run monday:sync
 *
 * Prereqs:
 *   - .env.local has MONDAY_API_TOKEN, NEXT_PUBLIC_SUPABASE_URL,
 *     SUPABASE_SERVICE_ROLE_KEY
 *   - The migration has been applied (Supabase Dashboard or CLI).
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { BOARDS, type BoardConfig } from '@/lib/monday/board-registry'
import { mondayGQL, sleep, ITEM_FIELDS, UPDATE_FIELDS } from '@/lib/monday/graphql'
import {
  mapItemToRow,
  mapUpdateToRow,
  type MondayItem,
  type MondayUpdate,
} from '@/lib/monday/row-mapping'

loadEnv({ path: join(process.cwd(), '.env.local') })

// Page sizes — keep under 5M complexity budget per query.
// With 25 items/page and 100 updates/item + column_values, stays well within.
const ITEMS_PER_PAGE = 25
const UPDATES_PER_ITEM = 100
const BATCH_UPSERT_SIZE = 200
const SLEEP_BETWEEN_REQUESTS_MS = 700

// sync fetches updates inline with each item; the webhook path does
// not, so extend the shared MondayItem type locally.
type MondayItemWithUpdates = MondayItem & { updates: MondayUpdate[] }

type ItemsPage = {
  cursor: string | null
  items: MondayItemWithUpdates[]
}

// Compose the fields string with updates nested inline (sync only).
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

async function syncBoard(supabase: SupabaseClient, board: BoardConfig): Promise<void> {
  console.log(`\n[${board.monday_board_name}] syncing from board ${board.monday_board_id}`)
  let pageNumber = 0
  let totalItems = 0
  let totalUpdates = 0

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
    console.log(
      `  page ${pageNumber}: ${itemRows.length} items (+${updateRows.length} updates) — total items ${totalItems}`,
    )

    if (!page.cursor) break
    await sleep(SLEEP_BETWEEN_REQUESTS_MS)
    page = await fetchNextPage(page.cursor)
  }

  console.log(
    `[${board.monday_board_name}] done — ${totalItems} items, ${totalUpdates} updates synced`,
  )
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')

  const supabase = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const startedAt = Date.now()
  for (const board of BOARDS) {
    await syncBoard(supabase, board)
  }
  const elapsed = Math.round((Date.now() - startedAt) / 1000)
  console.log(`\n✓ All boards synced in ${elapsed}s`)
}

main().catch(err => {
  console.error('\n✗ Sync failed:')
  console.error(err)
  process.exit(1)
})
