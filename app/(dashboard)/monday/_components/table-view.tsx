import { notFound } from 'next/navigation'
import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  getBoardBySlug,
  getTableConfig,
  type TableKind,
} from '../_lib/tables'
import { queryItemWithUpdates, queryTable } from '../_lib/query-data'
import { DataTable } from './data-table'
import { ItemDrawer } from './item-drawer'
import { Pagination } from './pagination'
import { SearchBar } from './search-bar'
import { TableKindTabs } from './table-kind-tabs'

type SearchParams = Record<string, string | string[] | undefined>

type Props = {
  boardSlug: string
  kind: TableKind
  searchParams: Promise<SearchParams>
}

/**
 * Shared renderer for both the board items page and the board updates
 * page. Reads search params, validates the table, runs the query,
 * renders.
 *
 * When viewing an items table and `?item=<monday_item_id>` is set,
 * also fetches the item row + its updates and renders the ItemDrawer.
 */
export async function TableView({ boardSlug, kind, searchParams }: Props) {
  const config = getTableConfig(boardSlug, kind)
  if (!config) notFound()

  const sp = await searchParams
  const page = clampInt(sp.page, 1, 1_000_000, 1)
  const size = clampEnum(sp.size, PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE)
  const sort = typeof sp.sort === 'string' ? sp.sort : null
  const order: 'asc' | 'desc' = sp.order === 'asc' ? 'asc' : 'desc'
  const q = typeof sp.q === 'string' ? sp.q : null
  const selectedItemId =
    kind === 'items' && typeof sp.item === 'string' && sp.item.length > 0
      ? sp.item
      : ''

  const [tablePage, drawerData] = await Promise.all([
    queryTable(config, { page, size, sort, order, q }),
    selectedItemId
      ? queryItemWithUpdates(boardSlug, selectedItemId)
      : Promise.resolve({ item: null, updates: [] }),
  ])

  const { rows, total } = tablePage
  const board = getBoardBySlug(boardSlug)

  return (
    <section className="flex min-w-0 flex-col">
      <header className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            {config.label}
          </h1>
          <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
            {total.toLocaleString()} row{total === 1 ? '' : 's'}
          </p>
        </div>
      </header>

      <TableKindTabs boardSlug={boardSlug} active={kind} />

      <div className="flex items-center justify-between gap-3 py-3">
        <SearchBar />
      </div>

      <div className="min-w-0 overflow-hidden rounded-md md:rounded-md">
        <DataTable
          config={config}
          rows={rows}
          {...(selectedItemId ? { selectedItemId } : {})}
        />
      </div>

      <Pagination page={page} size={size} total={total} />

      {kind === 'items' && (
        <ItemDrawer
          itemId={selectedItemId}
          item={drawerData.item}
          updates={drawerData.updates}
          boardLabel={board?.label ?? config.label}
        />
      )}
    </section>
  )
}

function clampInt(
  raw: string | string[] | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function clampEnum<T extends number>(
  raw: string | string[] | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  return (allowed as readonly number[]).includes(n) ? (n as T) : fallback
}
