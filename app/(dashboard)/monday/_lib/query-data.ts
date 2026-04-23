import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import type { TableConfig } from './tables'

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
