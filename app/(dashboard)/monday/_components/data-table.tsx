import type { TableConfig } from '../_lib/tables'
import { ClickableCard, ClickableRow } from './clickable-row'
import { ScrollSync } from './scroll-sync'
import { SortHeader } from './sort-header'

type Row = Record<string, unknown>

type Props = {
  config: TableConfig
  rows: Row[]
  /** When viewing an items table, the currently-selected monday_item_id. */
  selectedItemId?: string
}

/**
 * Server-side data table.
 *
 * Desktop: scrollable table with sortable headers.
 * Mobile: stacked cards (no horizontal scroll pain).
 */
export function DataTable({ config, rows, selectedItemId }: Props) {
  const rowsClickable = config.kind === 'items'
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-4 py-16 text-center">
        <p className="text-[14px] font-medium text-[color:var(--color-text-primary)]">
          No rows
        </p>
        <p className="mt-1 text-[12px] text-[color:var(--color-text-secondary)]">
          Nothing matches the current search or filter.
        </p>
      </div>
    )
  }

  return (
    <>
      {/* Desktop — table (with top mirror scrollbar + drag-to-pan) */}
      <ScrollSync className="hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] md:block">
        <table className="w-full border-collapse text-[11px]">
          {/* Sticky header — when the page scrolls vertically the
           *  column labels stay pinned to the viewport so users always
           *  know which column they're looking at. The bg + z-index
           *  prevent body cells from peeking through underneath. */}
          <thead className="sticky top-0 z-10 bg-[color:var(--color-bg-secondary)]">
            <tr>
              {config.columns.map(col => (
                <th
                  key={col.key}
                  scope="col"
                  className={[
                    'whitespace-nowrap border-b border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-3 py-2 text-left align-middle',
                    col.className ?? '',
                  ].join(' ')}
                >
                  <SortHeader
                    columnKey={col.key}
                    label={col.label}
                    sortable={col.sortable}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => {
              const mondayItemId = stringify(row.monday_item_id)
              const cells = config.columns.map(col => (
                <td
                  key={col.key}
                  className={[
                    'px-3 py-2 align-top text-[color:var(--color-text-primary)]',
                    col.className ?? '',
                  ].join(' ')}
                >
                  {renderCell(row[col.key], col.key)}
                </td>
              ))

              if (rowsClickable && mondayItemId) {
                return (
                  <ClickableRow
                    key={String(row.id ?? rowIdx)}
                    mondayItemId={mondayItemId}
                    isActive={selectedItemId === mondayItemId}
                  >
                    {cells}
                  </ClickableRow>
                )
              }

              return (
                <tr
                  key={String(row.id ?? rowIdx)}
                  className="border-b border-[color:var(--color-border)] transition-colors last:border-b-0 hover:bg-[color:var(--color-bg-secondary)]"
                >
                  {cells}
                </tr>
              )
            })}
          </tbody>
        </table>
      </ScrollSync>

      {/* Mobile — card list */}
      <div className="flex flex-col gap-2 md:hidden">
        {rows.map((row, rowIdx) => {
          const mondayItemId = stringify(row.monday_item_id)
          const heading = firstNonEmpty(row[config.mobileCard.heading]) ?? '—'
          const badge = config.mobileCard.badge
            ? firstNonEmpty(row[config.mobileCard.badge])
            : null
          const footer = config.mobileCard.footer
            ? firstNonEmpty(row[config.mobileCard.footer])
            : null

          const body = (
            <>
              <div className="mb-2 flex items-start justify-between gap-2">
                <p className="text-[14px] font-medium text-[color:var(--color-text-primary)]">
                  {heading}
                </p>
                {badge && (
                  <span className="shrink-0 rounded-full bg-[color:var(--color-bg-secondary)] px-2 py-0.5 text-[11px] text-[color:var(--color-text-primary)]">
                    {badge}
                  </span>
                )}
              </div>

              <dl className="space-y-1">
                {config.mobileCard.body.map(key => {
                  const value = firstNonEmpty(row[key])
                  if (!value) return null
                  const label = config.columns.find(c => c.key === key)?.label ?? key
                  return (
                    <div key={key} className="flex gap-2 text-[12px]">
                      <dt className="shrink-0 text-[color:var(--color-text-secondary)]">
                        {label}:
                      </dt>
                      <dd className="min-w-0 break-words text-[color:var(--color-text-primary)]">
                        {value}
                      </dd>
                    </div>
                  )
                })}
              </dl>

              {footer && (
                <p className="mt-2 text-[11px] text-[color:var(--color-text-secondary)]">
                  {footer}
                </p>
              )}
            </>
          )

          if (rowsClickable && mondayItemId) {
            return (
              <ClickableCard
                key={String(row.id ?? rowIdx)}
                mondayItemId={mondayItemId}
                isActive={selectedItemId === mondayItemId}
              >
                {body}
              </ClickableCard>
            )
          }

          return (
            <div
              key={String(row.id ?? rowIdx)}
              className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3"
            >
              {body}
            </div>
          )
        })}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Cell rendering helpers
// ---------------------------------------------------------------------------

function renderCell(value: unknown, key: string): React.ReactNode {
  const str = firstNonEmpty(value)
  if (!str) return <span className="text-[color:var(--color-text-secondary)]">—</span>

  if (isLikelyTimestamp(key, str)) {
    return formatTimestamp(str)
  }

  if (isLikelyUrl(str)) {
    return (
      <a
        href={prefixUrl(str)}
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold underline underline-offset-2 decoration-[color:var(--color-text-primary)]"
      >
        {truncate(str, 40)}
      </a>
    )
  }

  if (key === 'body_text' || key === 'body_html') {
    return <span className="block max-w-[60ch]">{truncate(str, 280)}</span>
  }

  return truncate(str, 120)
}

function stringify(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

function firstNonEmpty(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v.length === 0 ? null : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'object') return null
  return String(v)
}

function isLikelyUrl(str: string): boolean {
  return /^(https?:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,})/i.test(str) && !str.includes(' ')
}

function prefixUrl(str: string): string {
  return /^https?:\/\//i.test(str) ? str : `https://${str}`
}

function isLikelyTimestamp(key: string, str: string): boolean {
  if (key === 'date' && /^\d{4}-\d{2}-\d{2}/.test(str)) return true
  if (/_at$/.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(str)) return true
  return false
}

function formatTimestamp(str: string): string {
  try {
    const d = new Date(str)
    if (Number.isNaN(d.getTime())) return str
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return str
  }
}

function truncate(str: string, max: number): string {
  return str.length <= max ? str : str.slice(0, max - 1) + '…'
}
