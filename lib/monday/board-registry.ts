/**
 * Single source of truth for the 4 Monday boards we replicate.
 * Used by both the bulk sync script and the real-time webhook handler,
 * so adding a board / column change is a one-file edit.
 */

export type BoardKey =
  | 'leads'
  | 'affiliates'
  | 'not_relevant_leads'
  | 'email_undelivered_leads'

export type BoardConfig = {
  key: BoardKey
  monday_board_id: string
  monday_board_name: string
  items_table: string
  updates_table: string
  /** Maps Monday column id → SQL column name on the items table. */
  column_map: Record<string, string>
}

export const BOARDS: readonly BoardConfig[] = [
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
] as const

/** Look up a board by its Monday board ID (string). */
export function boardByMondayId(boardId: string | number | undefined): BoardConfig | undefined {
  if (boardId == null) return undefined
  const id = String(boardId)
  return BOARDS.find(b => b.monday_board_id === id)
}

/** List of all event types we want to subscribe to per board. */
export const WEBHOOK_EVENT_TYPES = [
  'create_item',
  'change_column_value',
  'change_name',
  'item_deleted',
  'item_archived',
  'create_update',
  'edit_update',
  'delete_update',
] as const

export type MondayWebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number]
