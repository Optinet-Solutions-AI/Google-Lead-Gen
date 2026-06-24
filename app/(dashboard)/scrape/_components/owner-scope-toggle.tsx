'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { User, Users } from 'lucide-react'

/**
 * Mine / All toggle in the /scrape page header. Defaults to "Mine"
 * so operators land on their own work; switch to "All" via the
 * second segment.
 *
 * URL-driven: ?owner=mine|all. Omitted = mine (the implicit default).
 * Page nav drops the page param so a switch always lands on page 1.
 */
export function OwnerScopeToggle({
  current,
  mineCount,
  allCount,
}: {
  current: 'mine' | 'all'
  mineCount: number
  allCount: number
}) {
  const pathname = usePathname()
  const sp = useSearchParams()

  const hrefFor = (next: 'mine' | 'all') => {
    const params = new URLSearchParams(sp.toString())
    if (next === 'mine') params.delete('owner')
    else params.set('owner', 'all')
    params.delete('page')
    const qs = params.toString()
    return qs ? `${pathname}?${qs}` : pathname
  }

  const segment = (key: 'mine' | 'all', label: string, count: number, Icon: typeof User) => {
    const active = current === key
    return (
      <Link
        href={hrefFor(key)}
        scroll={false}
        prefetch={false}
        aria-pressed={active}
        className={[
          'inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium transition-colors',
          active
            ? 'bg-[color:var(--color-accent)]/20 text-[color:var(--color-text-primary)]'
            : 'text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]',
        ].join(' ')}
      >
        <Icon className="h-3.5 w-3.5" />
        {label}
        <span
          className={[
            'rounded-full px-1.5 py-0.5 text-[10px] tabular-nums',
            active
              ? 'bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-primary)]'
              : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
          ].join(' ')}
        >
          {count.toLocaleString()}
        </span>
      </Link>
    )
  }

  return (
    <div
      role="group"
      aria-label="Scope"
      className="inline-flex overflow-hidden rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]"
    >
      {segment('mine', 'Mine', mineCount, User)}
      <span className="w-px bg-[color:var(--color-border)]" aria-hidden="true" />
      {segment('all', 'All', allCount, Users)}
    </div>
  )
}
