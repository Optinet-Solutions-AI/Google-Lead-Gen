'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { PAGE_SIZE_OPTIONS as MONDAY_PAGE_SIZE_OPTIONS } from '../_lib/tables'

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

  const totalPages = Math.max(1, Math.ceil(total / size))
  const fromRow = total === 0 ? 0 : (page - 1) * size + 1
  const toRow = Math.min(page * size, total)

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
    router.push(`${pathname}?${params.toString()}`)
  }

  const canPrev = page > 1
  const canNext = page < totalPages

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[color:var(--color-border)] px-3 py-2 text-[12px] text-[color:var(--color-text-secondary)]">
      <span>
        {total === 0 ? 'No rows' : `${fromRow.toLocaleString()}–${toRow.toLocaleString()} of ${total.toLocaleString()}`}
      </span>

      <div className="flex items-center gap-3">
        <label className="hidden items-center gap-1 md:flex">
          <span>Rows:</span>
          <select
            value={size}
            onChange={e => onSizeChange(Number(e.target.value))}
            className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-1 py-0.5 text-[12px]"
          >
            {sizeOptions.map(opt => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1">
          {canPrev ? (
            <Link
              href={hrefForPage(page - 1)}
              aria-label="Previous page"
              className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-1 hover:bg-[color:var(--color-bg-secondary)]"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <span
              aria-label="Previous page disabled"
              className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-1 opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </span>
          )}

          <span className="px-2 text-[color:var(--color-text-primary)]">
            Page {page.toLocaleString()} / {totalPages.toLocaleString()}
          </span>

          {canNext ? (
            <Link
              href={hrefForPage(page + 1)}
              aria-label="Next page"
              className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-1 hover:bg-[color:var(--color-bg-secondary)]"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          ) : (
            <span
              aria-label="Next page disabled"
              className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-1 opacity-40"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
