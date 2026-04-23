/**
 * Maps Monday GraphQL response objects into Supabase row payloads.
 * Shared between the bulk sync script and the webhook handler so both
 * use identical column logic.
 */

import type { BoardConfig } from './board-registry'

export type MondayColumnValue = {
  id: string
  type: string
  text: string | null
  value: string | null
}

export type MondayItem = {
  id: string
  name: string
  created_at: string | null
  updated_at: string | null
  group: { id: string; title: string } | null
  column_values: MondayColumnValue[]
  subitems: Array<{ id: string }> | null
}

export type MondayUpdate = {
  id: string
  body: string | null
  text_body: string | null
  created_at: string | null
  creator: { id: string; name: string; email: string | null } | null
}

export function mapItemToRow(item: MondayItem, board: BoardConfig): Record<string, unknown> {
  const row: Record<string, unknown> = {
    monday_item_id: item.id,
    name: item.name,
    group_title: item.group?.title ?? null,
    subitems_count: item.subitems?.length ?? 0,
    raw_column_values: item.column_values,
    monday_created_at: item.created_at,
    monday_updated_at: item.updated_at,
    synced_at: new Date().toISOString(),
  }

  // Initialize all mapped columns to null so the upsert payload is
  // consistent across items (keeps Postgres happy about missing columns).
  for (const sqlCol of Object.values(board.column_map)) {
    row[sqlCol] = null
  }

  // Fill from Monday column_values using the display text.
  for (const cv of item.column_values) {
    const sqlCol = board.column_map[cv.id]
    if (sqlCol) {
      row[sqlCol] = cv.text ?? null
    }
  }

  return row
}

export function mapUpdateToRow(
  update: MondayUpdate,
  mondayItemId: string,
): Record<string, unknown> {
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
