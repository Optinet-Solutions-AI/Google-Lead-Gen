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
 *   - The migration above has been applied (via Supabase Dashboard
 *     SQL Editor or supabase CLI).
 */

import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { mondayGQL, sleep } from './client.js'

loadEnv({ path: join(process.cwd(), '.env.local') })

// ---------------------------------------------------------------------------
// Board configuration
// ---------------------------------------------------------------------------

type BoardKey = 'leads' | 'affiliates' | 'not_relevant_leads' | 'email_undelivered_leads'

type BoardConfig = {
  key: BoardKey
  monday_board_id: string
  monday_board_name: string
  items_table: string
  updates_table: string
  /** Maps Monday column id -> SQL column name on the items table. */
  column_map: Record<string, string>
}

const BOARDS: BoardConfig[] = [
  {
    key: 'leads',
    monday_board_id: '1236073873',
    monday_board_name: 'Leads',
    items_table: 'leads_table',
    updates_table: 'leads_updates_table',
    column_map: {
      text54: 'keywords',
      status: 'status',
      text82: 'comments',
      email: 'email',
      status_12: 'traffic_size',
      status_1: 'source',
      files: 'files',
      project_owner: 'owner',
      text0: 'geo',
      date: 'date',
      text1: 'website',
    },
  },
  {
    key: 'affiliates',
    monday_board_id: '1237788929',
    monday_board_name: 'Affiliates',
    items_table: 'affiliates_table',
    updates_table: 'affiliates_updates_table',
    column_map: {
      text54: 'keywords',
      text3: 'l7_sj_rs_lv_ro',
      text: 'rb_fp_su',
      text6__1: 'pm',
      text46__1: 'nd',
      text86: 'affiliate_name',
      status: 'status',
      text82: 'comments',
      email: 'email',
      status_12: 'traffic_size',
      status_1: 'source',
      files: 'files',
      text0: 'geo',
      project_owner: 'owner',
      date: 'date',
      text1: 'website',
    },
  },
  {
    key: 'not_relevant_leads',
    monday_board_id: '1237789472',
    monday_board_name: 'Not Relevant Leads',
    items_table: 'not_relevant_leads_table',
    updates_table: 'not_relevant_leads_updates_table',
    column_map: {
      text54: 'keywords',
      text3: 'affiliate_id',
      text86: 'affiliate_name',
      status: 'status',
      text82: 'comments',
      numbers0: 'google_page',
      email: 'email',
      status_12: 'traffic_size',
      status_1: 'source',
      files: 'files',
      text0: 'geo',
      project_owner: 'owner',
      date: 'date',
      text1: 'website',
    },
  },
  {
    key: 'email_undelivered_leads',
    monday_board_id: '1237006289',
    monday_board_name: 'Email Undelivered Leads',
    items_table: 'email_undelivered_leads_table',
    updates_table: 'email_undelivered_leads_updates_table',
    column_map: {
      long_text5: 'keywords',
      text3: 'affiliate_id',
      text86: 'affiliate_name',
      status: 'status',
      text82: 'comments',
      numbers0: 'google_page',
      email: 'email',
      status_12: 'traffic_size',
      status_1: 'source',
      files: 'files',
      text0: 'geo',
      project_owner: 'owner',
      date: 'date',
      text1: 'website',
    },
  },
]

// Page sizes — keep under 5M complexity budget per query.
// With 25 items/page and 100 updates/item + column_values, stays well within.
const ITEMS_PER_PAGE = 25
const UPDATES_PER_ITEM = 100
const BATCH_UPSERT_SIZE = 200
const SLEEP_BETWEEN_REQUESTS_MS = 700

// ---------------------------------------------------------------------------
// Types for GraphQL responses
// ---------------------------------------------------------------------------

type ColumnValue = {
  id: string
  type: string
  text: string | null
  value: string | null
}

type Update = {
  id: string
  body: string | null
  text_body: string | null
  created_at: string | null
  creator: { id: string; name: string; email: string | null } | null
}

type MondayItem = {
  id: string
  name: string
  created_at: string | null
  updated_at: string | null
  group: { id: string; title: string } | null
  column_values: ColumnValue[]
  subitems: Array<{ id: string }> | null
  updates: Update[]
}

type ItemsPage = {
  cursor: string | null
  items: MondayItem[]
}

// ---------------------------------------------------------------------------
// Query builders
// ---------------------------------------------------------------------------

const ITEM_FIELDS = `
  id
  name
  created_at
  updated_at
  group { id title }
  column_values { id type text value }
  subitems { id }
  updates(limit: ${UPDATES_PER_ITEM}) {
    id
    body
    text_body
    created_at
    creator { id name email }
  }
`

async function fetchFirstPage(boardId: string): Promise<ItemsPage> {
  const data = await mondayGQL<{ boards: Array<{ items_page: ItemsPage }> }>(
    `query ($id: [ID!], $limit: Int!) {
      boards(ids: $id) {
        items_page(limit: $limit) {
          cursor
          items { ${ITEM_FIELDS} }
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
        items { ${ITEM_FIELDS} }
      }
    }`,
    { cursor, limit: ITEMS_PER_PAGE },
  )
  return data.next_items_page
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function mapItemToRow(item: MondayItem, board: BoardConfig): Record<string, unknown> {
  const base: Record<string, unknown> = {
    monday_item_id: item.id,
    name: item.name,
    group_title: item.group?.title ?? null,
    subitems_count: item.subitems?.length ?? 0,
    raw_column_values: item.column_values,
    monday_created_at: item.created_at,
    monday_updated_at: item.updated_at,
    synced_at: new Date().toISOString(),
  }

  // Initialize all mapped columns to null so the upsert payload has them all
  for (const sqlCol of Object.values(board.column_map)) {
    base[sqlCol] = null
  }

  // Fill from Monday column_values (use `text` — the display string)
  for (const cv of item.column_values) {
    const sqlCol = board.column_map[cv.id]
    if (sqlCol) {
      base[sqlCol] = cv.text ?? null
    }
  }

  return base
}

function mapUpdateToRow(update: Update, mondayItemId: string): Record<string, unknown> {
  return {
    monday_update_id: update.id,
    monday_item_id: mondayItemId,
    body_html: update.body,
    body_text: update.text_body,
    creator_id: update.creator?.id ?? null,
    creator_name: update.creator?.name ?? null,
    creator_email: update.creator?.email ?? null,
    monday_created_at: update.created_at,
    synced_at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Supabase upserts — batched
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Per-board sync
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

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
