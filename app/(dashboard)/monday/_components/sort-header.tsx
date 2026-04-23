'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react'

type Props = {
  columnKey: string
  label: string
  sortable: boolean
  className?: string
}

/**
 * Column header that toggles ?sort=<col>&order=<asc|desc> on click.
 * Resets `?page` so the user lands on page 1 of the re-sorted result.
 */
export function SortHeader({ columnKey, label, sortable, className }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const currentSort = sp.get('sort')
  const currentOrder = sp.get('order') === 'asc' ? 'asc' : 'desc'

  const isActive = currentSort === columnKey

  function toggle() {
    const params = new URLSearchParams(sp.toString())
    if (!isActive) {
      params.set('sort', columnKey)
      params.set('order', 'asc')
    } else if (currentOrder === 'asc') {
      params.set('sort', columnKey)
      params.set('order', 'desc')
    } else {
      params.delete('sort')
      params.delete('order')
    }
    params.delete('page')
    router.push(`${pathname}?${params.toString()}`)
  }

  if (!sortable) {
    return (
      <span
        className={[
          'text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]',
          className ?? '',
        ].join(' ')}
      >
        {label}
      </span>
    )
  }

  const Icon = isActive
    ? currentOrder === 'asc'
      ? ArrowUp
      : ArrowDown
    : ChevronsUpDown

  return (
    <button
      type="button"
      onClick={toggle}
      className={[
        'inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide',
        isActive
          ? 'text-[color:var(--color-text-primary)]'
          : 'text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]',
        className ?? '',
      ].join(' ')}
    >
      <span>{label}</span>
      <Icon className="h-3 w-3" />
    </button>
  )
}
