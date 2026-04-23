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

  switch (event.type) {
    case 'create_item':
    case 'change_column_value':
    case 'change_name':
    case 'change_status_column_value':
      return await handleItemChanged(event, board)

    case 'item_deleted':
    case 'item_archived':
      return await handleItemRemoved(event, board)

    case 'create_update':
    case 'edit_update':
      return await handleUpdateChanged(event, board)

    case 'delete_update':
      return await handleUpdateDeleted(event, board)

    default:
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
  if (event.pulseId == null) {
    return { status: 'error', message: 'pulseId missing', event_type: event.type, board: board.key }
  }

  const item = await fetchItemById(String(event.pulseId))
  if (!item) {
    return {
      status: 'ignored',
      message: `item ${event.pulseId} not found (may already be deleted)`,
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
  if (event.pulseId == null) {
    return { status: 'error', message: 'pulseId missing', event_type: event.type, board: board.key }
  }

  const supabase = createServiceClient()
  const { error } = await supabase
    .from(board.items_table)
    .delete()
    .eq('monday_item_id', String(event.pulseId))

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
    .eq('monday_item_id', String(event.pulseId))

  return {
    status: 'ok',
    message: `deleted item ${event.pulseId}`,
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
