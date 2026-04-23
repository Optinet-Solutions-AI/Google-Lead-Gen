import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { getBoardBySlug, type TableConfig } from './tables'

export type DataQueryResult = {
  rows: Array<Record<string, unknown>>
  total: number
}

export type DataQueryOptions = {
  page: number
  size: number
  /** SQL column name to sort by, or `null` to use the table's default sort. */
  sort: string | null
  order: 'asc' | 'desc'
  /** Free-text global search. Empty string / null disables search. */
  q: string | null
}

/**
 * Sanitizes a user-provided search term for PostgREST's `or` filter.
 * Removes characters that collide with the filter DSL.
 */
function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,()*]/g, '').trim()
}

/** Runs the query and returns the current page + total count. */
export async function queryTable(
  config: TableConfig,
  options: DataQueryOptions,
): Promise<DataQueryResult> {
  const supabase = createServiceClient()
  const sort = options.sort ?? config.defaultSort.column
  const order = options.sort == null ? config.defaultSort.order : options.order

  let query = supabase
    .from(config.sqlTable)
    .select('*', { count: 'exact' })
    .order(sort, { ascending: order === 'asc', nullsFirst: false })

  const q = options.q ? sanitizeSearchTerm(options.q) : ''
  if (q.length > 0 && config.searchColumns.length > 0) {
    const filter = config.searchColumns
      .map(col => `${col}.ilike.%${q}%`)
      .join(',')
    query = query.or(filter)
  }

  const from = Math.max(0, (options.page - 1) * options.size)
  const to = from + options.size - 1
  query = query.range(from, to)

  const { data, count, error } = await query
  if (error) {
    throw new Error(
      `Supabase query on ${config.sqlTable} failed: ${error.message} (${JSON.stringify(
        error.details ?? {},
      )})`,
    )
  }
  return { rows: (data ?? []) as Array<Record<string, unknown>>, total: count ?? 0 }
}

export type ItemWithUpdates = {
  item: Record<string, unknown> | null
  updates: Array<Record<string, unknown>>
}

/**
 * Fetches the item matching `mondayItemId` plus every update linked to
 * that item (ordered newest first, capped at 200). Used by the
 * right-side drawer that opens when the user clicks a row in an items
 * table.
 */
export async function queryItemWithUpdates(
  boardSlug: string,
  mondayItemId: string,
): Promise<ItemWithUpdates> {
  const board = getBoardBySlug(boardSlug)
  if (!board) return { item: null, updates: [] }

  const supabase = createServiceClient()

  const [itemRes, updatesRes] = await Promise.all([
    supabase
      .from(board.items.sqlTable)
      .select('*')
      .eq('monday_item_id', mondayItemId)
      .maybeSingle(),
    supabase
      .from(board.updates.sqlTable)
      .select('*')
      .eq('monday_item_id', mondayItemId)
      .order('monday_created_at', { ascending: false, nullsFirst: false })
      .limit(200),
  ])

  if (itemRes.error) {
    throw new Error(`Fetching item ${mondayItemId}: ${itemRes.error.message}`)
  }
  if (updatesRes.error) {
    throw new Error(`Fetching updates for ${mondayItemId}: ${updatesRes.error.message}`)
  }

  return {
    item: (itemRes.data ?? null) as Record<string, unknown> | null,
    updates: (updatesRes.data ?? []) as Array<Record<string, unknown>>,
  }
}
