'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTransition } from 'react'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { PAGE_SIZE_OPTIONS as MONDAY_PAGE_SIZE_OPTIONS } from '../_lib/tables'

/** Sentinel value in the size dropdown that means "show every row".
 *  Backed by a soft cap in the per-page query helpers so a 50k-row
 *  table doesn't lock up the browser. */
export const ALL_ROWS = 0

type Props = {
  page: number
  size: number
  total: number
  /** Optional override — defaults to [10, 25, 50, 100] via Monday config. */
  pageSizeOptions?: readonly number[]
}

export function Pagination({ page, size, total, pageSizeOptions }: Props) {
  const sizeOptions = pageSizeOptions ?? MONDAY_PAGE_SIZE_OPTIONS
  const pathname = usePathname()
  const sp = useSearchParams()
  const router = useRouter()
  // Show a visible "Loading…" indicator while the next server render
  // is in flight — without this, picking "All" on a big table looks
  // dead for several seconds and operators retry-click the dropdown.
  const [isPending, startTransition] = useTransition()

  const showingAll = size === ALL_ROWS
  // When "All" is picked, every row is on a single page — collapse the
  // page math so the prev/next chevrons go disabled and we render
  // "All N rows" instead of "1-X of N".
  const totalPages = showingAll ? 1 : Math.max(1, Math.ceil(total / size))
  const fromRow = total === 0 ? 0 : showingAll ? 1 : (page - 1) * size + 1
  const toRow = showingAll ? total : Math.min(page * size, total)

  const hrefForPage = (target: number) => {
    const params = new URLSearchParams(sp.toString())
    if (target <= 1) params.delete('page')
    else params.set('page', String(target))
    const qs = params.toString()
    return qs ? `${pathname}?${qs}` : pathname
  }

  function onSizeChange(next: number) {
    const params = new URLSearchParams(sp.toString())
    params.set('size', String(next))
    params.delete('page')
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`, { scroll: false })
    })
  }

  function goToPage(target: number) {
    if (target < 1 || target > totalPages || target === page) return
    startTransition(() => {
      router.push(hrefForPage(target), { scroll: false })
    })
  }

  // Jump-to-page box. Lets you type a page number instead of clicking the
  // next chevron N times — the real ask behind "can I see all rows" (you
  // don't want every row, you want page 45 without 44 clicks). The input is
  // uncontrolled and keyed by `page` (below) so it remounts with the live
  // page after each navigation, which keeps it in sync without a setState
  // effect; we just read the typed value on Enter/blur and navigate.
  function jumpToPage(raw: string) {
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) return
    const target = Math.min(Math.max(n, 1), totalPages)
    goToPage(target)
  }

  const canPrev = page > 1
  const canNext = page < totalPages

  return (
    // pr-20: reserve ~80px on the right so the prev/next chevrons stay
    // clear of the floating QA-feedback widget (fixed bottom-20 right-4,
    // 48px square) — without it the > button is unclickable when the
    // pagination row lines up with the widget's viewport band.
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--color-border)] px-3 py-2 pr-20 text-[12px] text-[color:var(--color-text-secondary)]">
      <span className="inline-flex items-center gap-2">
        {total === 0
          ? 'No rows'
          : showingAll
            ? `All ${total.toLocaleString()} row${total === 1 ? '' : 's'}`
            : `${fromRow.toLocaleString()}–${toRow.toLocaleString()} of ${total.toLocaleString()}`}
        {isPending && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-accent)]/15 px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-text-primary)]"
            role="status"
            aria-live="polite"
          >
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading{showingAll ? ' all rows' : ''}…
          </span>
        )}
      </span>

      <div className="flex items-center gap-3">
        <label className="hidden items-center gap-1 md:flex">
          <span>Rows:</span>
          <select
            value={size}
            disabled={isPending}
            onChange={e => onSizeChange(Number(e.target.value))}
            className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-1 py-0.5 text-[12px] disabled:opacity-50"
          >
            {sizeOptions.map(opt => (
              <option key={opt} value={opt}>
                {opt === ALL_ROWS ? 'All' : opt}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous page"
            disabled={!canPrev || isPending}
            onClick={() => goToPage(page - 1)}
            className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-1 hover:bg-[color:var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[color:var(--color-bg-primary)]"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>

          {showingAll || totalPages <= 1 ? (
            <span className="px-2 text-[color:var(--color-text-primary)]">
              Page {page.toLocaleString()} / {totalPages.toLocaleString()}
            </span>
          ) : (
            <span className="flex items-center gap-1 px-2 text-[color:var(--color-text-primary)]">
              Page
              <input
                key={page}
                type="text"
                inputMode="numeric"
                aria-label="Go to page"
                defaultValue={String(page)}
                disabled={isPending}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    jumpToPage(e.currentTarget.value)
                  }
                }}
                onBlur={e => jumpToPage(e.currentTarget.value)}
                className="w-12 rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-1 py-0.5 text-center text-[12px] tabular-nums disabled:opacity-50"
              />
              / {totalPages.toLocaleString()}
            </span>
          )}

          <button
            type="button"
            aria-label="Next page"
            disabled={!canNext || isPending}
            onClick={() => goToPage(page + 1)}
            className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-1 hover:bg-[color:var(--color-bg-secondary)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[color:var(--color-bg-primary)]"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
