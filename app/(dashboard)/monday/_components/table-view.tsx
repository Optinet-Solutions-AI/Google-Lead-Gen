import Link from 'next/link'
import { notFound } from 'next/navigation'
import { clampPageSize } from '@/lib/page-size'
import {
  DEFAULT_PAGE_SIZE,
  getBoardBySlug,
  getTableConfig,
  type TableKind,
} from '../_lib/tables'
import { countTable, queryItemWithUpdates, queryTable } from '../_lib/query-data'
import { DataTable } from './data-table'
import { ItemDrawer } from './item-drawer'
import { Pagination } from './pagination'
import { SearchBar } from './search-bar'
import { SyncNowButton } from './sync-now-button'
import { TableKindTabs } from './table-kind-tabs'
import { TableNav } from './table-nav'

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
  const size = clampPageSize(sp.size, DEFAULT_PAGE_SIZE)
  const sort = typeof sp.sort === 'string' ? sp.sort : null
  const order: 'asc' | 'desc' = sp.order === 'asc' ? 'asc' : 'desc'
  const q = typeof sp.q === 'string' ? sp.q : null
  const selectedItemId =
    kind === 'items' && typeof sp.item === 'string' && sp.item.length > 0
      ? sp.item
      : ''

  // Search-first (2026-09-17): a board can hold tens of thousands of rows and
  // nobody browses them page by page. With no search term we fetch the count
  // only and prompt for one. `?all=1` still opens the full paged table.
  const term = (q ?? '').trim()
  const showAll = sp.all === '1'
  const listing = term.length > 0 || showAll

  const [tableData, drawerData] = await Promise.all([
    listing
      ? queryTable(config, { page, size, sort, order, q })
      : countTable(config).then(total => ({ rows: [] as Array<Record<string, unknown>>, total })),
    selectedItemId
      ? queryItemWithUpdates(boardSlug, selectedItemId)
      : Promise.resolve({ item: null, updates: [] }),
  ])

  const { rows, total } = tableData
  const board = getBoardBySlug(boardSlug)
  const searchableColumns = config.columns
    .filter(c => config.searchColumns.includes(c.key))
    .map(c => c.label)

  return (
    <section className="flex min-w-0 flex-col">
      <header className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            {config.label}
          </h1>
          <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
            {listing ? (
              <>
                {total.toLocaleString()} matching row{total === 1 ? '' : 's'}
                {term ? <> for &ldquo;{term}&rdquo;</> : null}
              </>
            ) : (
              <>{total.toLocaleString()} row{total === 1 ? '' : 's'} on this board</>
            )}{' '}
            · webhook keeps this in sync; press the button if you need to force a full re-sync.
          </p>
        </div>
        <SyncNowButton />
      </header>

      <div className="mb-3">
        <TableNav />
      </div>

      <TableKindTabs boardSlug={boardSlug} active={kind} />

      <div className="flex items-center justify-between gap-3 py-3">
        <SearchBar />
      </div>

      {listing ? (
        <>
          {/* No overflow-hidden here: it would establish a sticky-containing
           *  block and trap the DataTable's per-cell sticky <th> inside this
           *  wrapper instead of letting it pin to the viewport. */}
          <div className="min-w-0 rounded-md md:rounded-md">
            <DataTable
              config={config}
              rows={rows}
              {...(selectedItemId ? { selectedItemId } : {})}
            />
          </div>

          <Pagination page={page} size={size} total={total} />
        </>
      ) : (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-secondary)]/40 px-4 py-10 text-center">
          <p className="text-[13px] font-medium text-[color:var(--color-text-primary)]">
            Search this board to see matching rows
          </p>
          <p className="max-w-md text-[12px] text-[color:var(--color-text-secondary)]">
            {total.toLocaleString()} rows are too many to scroll. Type part of a{' '}
            {searchableColumns.length > 0 ? searchableColumns.slice(0, 4).join(', ').toLowerCase() : 'value'} and matches
            appear as you search, anywhere in the field.
          </p>
          <Link
            href={`/monday/${boardSlug}${kind === 'updates' ? '/updates' : ''}?all=1`}
            className="mt-1 text-[12px] text-[color:var(--color-text-secondary)] underline hover:text-[color:var(--color-text-primary)]"
          >
            Show all rows anyway
          </Link>
        </div>
      )}

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

