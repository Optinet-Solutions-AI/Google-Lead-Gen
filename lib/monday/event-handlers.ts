import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { boardByMondayId, type BoardConfig } from './board-registry'
import { mondayGQL, ITEM_FIELDS, UPDATE_FIELDS } from './graphql'
import {
  mapItemToRow,
  mapUpdateToRow,
  type MondayItem,
  type MondayUpdate,
} from './row-mapping'

/**
 * Monday webhook event payload shapes. Documented at:
 *   https://developer.monday.com/api-reference/reference/webhooks
 *
 * Fields vary per event type; we only pick the ones we care about.
 */
export type MondayWebhookEvent = {
  type: string
  boardId?: number | string
  pulseId?: number | string
  itemId?: number | string
  updateId?: number | string
  [key: string]: unknown
}

export type HandlerResult = {
  status: 'ok' | 'ignored' | 'error'
  message: string
  event_type?: string
  board?: string
}

/**
 * Dispatches a Monday webhook event to the correct handler.
 *
 * Events for boards that aren't in our registry are ignored (returns
 * ok with a reason so we don't 500 Monday's retries).
 */
export async function handleEvent(event: MondayWebhookEvent): Promise<HandlerResult> {
  const board = boardByMondayId(event.boardId)
  if (!board) {
    return {
      status: 'ignored',
      message: `board ${event.boardId} not tracked`,
      event_type: event.type,
    }
  }

  // IMPORTANT: the event type you SUBSCRIBE to in create_webhook
  // (e.g. "change_column_value") is NOT the type string Monday puts in the
  // delivered payload (e.g. "update_column_value"). We match BOTH so the
  // handler is correct regardless of which one shows up. All item-mutation
  // events route to handleItemChanged, which re-fetches the full item and
  // upserts — so we don't need per-column granularity.
  switch (event.type) {
    // Item created / changed.
    case 'create_item':
    case 'create_pulse':
    case 'create_subitem':
    case 'change_column_value':
    case 'change_specific_column_value':
    case 'update_column_value':
    case 'change_name':
    case 'update_name':
    case 'change_status_column_value':
      return await handleItemChanged(event, board)

    // Item removed.
    case 'item_deleted':
    case 'delete_pulse':
    case 'item_archived':
    case 'archive_pulse':
      return await handleItemRemoved(event, board)

    // Update (post/comment) created or edited.
    case 'create_update':
    case 'edit_update':
      return await handleUpdateChanged(event, board)

    // Update deleted.
    case 'delete_update':
      return await handleUpdateDeleted(event, board)

    default:
      // Log so any still-unmapped delivered type surfaces in Vercel logs
      // instead of silently 200-ignoring (which is how the original
      // change_column_value/update_column_value mismatch hid for so long).
      console.log('[monday-webhook] ignored unhandled event type:', event.type)
      return {
        status: 'ignored',
        message: `unhandled event type: ${event.type}`,
        event_type: event.type,
        board: board.key,
      }
  }
}

// ---------------------------------------------------------------------------
// Item handlers
// ---------------------------------------------------------------------------

async function fetchItemById(itemId: string): Promise<MondayItem | null> {
  const data = await mondayGQL<{ items: MondayItem[] }>(
    `query ($id: [ID!]) {
      items(ids: $id) {
        ${ITEM_FIELDS}
      }
    }`,
    { id: [itemId] },
  )
  return data.items[0] ?? null
}

async function handleItemChanged(
  event: MondayWebhookEvent,
  board: BoardConfig,
): Promise<HandlerResult> {
  // Delivered payloads use pulseId for changes but itemId for some
  // delete/archive events — accept either.
  const itemId = event.pulseId ?? event.itemId
  if (itemId == null) {
    return { status: 'error', message: 'pulseId/itemId missing', event_type: event.type, board: board.key }
  }

  const item = await fetchItemById(String(itemId))
  if (!item) {
    return {
      status: 'ignored',
      message: `item ${itemId} not found (may already be deleted)`,
      event_type: event.type,
      board: board.key,
    }
  }

  const supabase = createServiceClient()
  const row = mapItemToRow(item, board)
  const { error } = await supabase
    .from(board.items_table)
    .upsert(row, { onConflict: 'monday_item_id' })

  if (error) {
    return {
      status: 'error',
      message: `upsert failed: ${error.message}`,
      event_type: event.type,
      board: board.key,
    }
  }

  return {
    status: 'ok',
    message: `upserted item ${item.id}`,
    event_type: event.type,
    board: board.key,
  }
}

async function handleItemRemoved(
  event: MondayWebhookEvent,
  board: BoardConfig,
): Promise<HandlerResult> {
  const itemId = event.pulseId ?? event.itemId
  if (itemId == null) {
    return { status: 'error', message: 'pulseId/itemId missing', event_type: event.type, board: board.key }
  }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from(board.items_table)
    .delete()
    .eq('monday_item_id', String(itemId))

  if (error) {
    return {
      status: 'error',
      message: `delete failed: ${error.message}`,
      event_type: event.type,
      board: board.key,
    }
  }

  // Also clear its updates — FK is loose (no DB-level constraint),
  // so do it explicitly here.
  await supabase
    .from(board.updates_table)
    .delete()
    .eq('monday_item_id', String(itemId))

  return {
    status: 'ok',
    message: `deleted item ${itemId}`,
    event_type: event.type,
    board: board.key,
  }
}

// ---------------------------------------------------------------------------
// Update handlers
// ---------------------------------------------------------------------------

async function fetchUpdateById(updateId: string): Promise<MondayUpdate | null> {
  const data = await mondayGQL<{ updates: MondayUpdate[] }>(
    `query ($id: [ID!]) {
      updates(ids: $id) {
        ${UPDATE_FIELDS}
      }
    }`,
    { id: [updateId] },
  )
  return data.updates[0] ?? null
}

async function handleUpdateChanged(
  event: MondayWebhookEvent,
  board: BoardConfig,
): Promise<HandlerResult> {
  if (event.updateId == null || event.pulseId == null) {
    return {
      status: 'error',
      message: 'updateId or pulseId missing',
      event_type: event.type,
      board: board.key,
    }
  }

  const update = await fetchUpdateById(String(event.updateId))
  if (!update) {
    return {
      status: 'ignored',
      message: `update ${event.updateId} not found`,
      event_type: event.type,
      board: board.key,
    }
  }

  const supabase = createServiceClient()
  const row = mapUpdateToRow(update, String(event.pulseId))
  const { error } = await supabase
    .from(board.updates_table)
    .upsert(row, { onConflict: 'monday_update_id' })

  if (error) {
    return {
      status: 'error',
      message: `upsert failed: ${error.message}`,
      event_type: event.type,
      board: board.key,
    }
  }

  return {
    status: 'ok',
    message: `upserted update ${update.id}`,
    event_type: event.type,
    board: board.key,
  }
}

async function handleUpdateDeleted(
  event: MondayWebhookEvent,
  board: BoardConfig,
): Promise<HandlerResult> {
  if (event.updateId == null) {
    return {
      status: 'error',
      message: 'updateId missing',
      event_type: event.type,
      board: board.key,
    }
  }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from(board.updates_table)
    .delete()
    .eq('monday_update_id', String(event.updateId))

  if (error) {
    return {
      status: 'error',
      message: `delete failed: ${error.message}`,
      event_type: event.type,
      board: board.key,
    }
  }

  return {
    status: 'ok',
    message: `deleted update ${event.updateId}`,
    event_type: event.type,
    board: board.key,
  }
}
