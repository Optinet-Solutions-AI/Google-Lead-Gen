'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { KeyboardEvent } from 'react'

type Props = {
  mondayItemId: string
  isActive: boolean
  children: React.ReactNode
}

/**
 * A <tr> that behaves like a button: clicking (or pressing Enter /
 * Space while focused) updates the URL's `?item=<monday_item_id>`,
 * which triggers the server component to pre-fetch the item's
 * updates and the drawer to slide in.
 */
export function ClickableRow({ mondayItemId, isActive, children }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()

  function open() {
    const params = new URLSearchParams(sp.toString())
    params.set('item', mondayItemId)
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  function onKeyDown(e: KeyboardEvent<HTMLTableRowElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      open()
    }
  }

  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={`Open updates for item ${mondayItemId}`}
      onClick={open}
      onKeyDown={onKeyDown}
      className={[
        'cursor-pointer border-b border-[color:var(--color-border)] transition-colors last:border-b-0',
        isActive
          ? 'bg-[color:var(--color-bg-secondary)]'
          : 'hover:bg-[color:var(--color-bg-secondary)]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]',
      ].join(' ')}
    >
      {children}
    </tr>
  )
}

type CardProps = {
  mondayItemId: string
  isActive: boolean
  children: React.ReactNode
}

/** Mobile-card equivalent of ClickableRow. */
export function ClickableCard({ mondayItemId, isActive, children }: CardProps) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()

  function open() {
    const params = new URLSearchParams(sp.toString())
    params.set('item', mondayItemId)
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  return (
    <button
      type="button"
      onClick={open}
      className={[
        'w-full rounded-md border p-3 text-left transition-colors',
        isActive
          ? 'border-[color:var(--color-accent)] bg-[color:var(--color-bg-secondary)]'
          : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]',
      ].join(' ')}
    >
      {children}
    </button>
  )
}
