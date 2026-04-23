'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BOARDS } from '../_lib/tables'

/**
 * Mini nav shown inside every /monday/* page.
 *
 * - Desktop: vertical rail on the right (the section the user asked for).
 * - Mobile: horizontal scrollable tab bar at the top.
 *
 * Shows the 4 boards only. Items vs updates is a sub-tab on each
 * page (see TableKindTabs).
 */
export function TableNav() {
  const pathname = usePathname()

  return (
    <>
      {/* Mobile — horizontal scroll */}
      <nav
        aria-label="Monday boards"
        className="no-scrollbar -mx-4 mb-3 flex gap-2 overflow-x-auto px-4 md:hidden"
      >
        {BOARDS.map(board => {
          const href = `/monday/${board.slug}`
          const active = pathname.startsWith(href)
          return (
            <Link
              key={board.slug}
              href={href}
              className={[
                'whitespace-nowrap rounded-full px-3 py-1.5 text-[12px] font-medium transition-colors',
                active
                  ? 'bg-[color:var(--color-accent)] text-[color:var(--color-text-primary)]'
                  : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-accent-hover)] hover:text-[color:var(--color-text-primary)]',
              ].join(' ')}
            >
              {board.label}
            </Link>
          )
        })}
      </nav>

      {/* Desktop — right-side vertical rail */}
      <nav
        aria-label="Monday boards"
        className="hidden w-48 shrink-0 md:block"
      >
        <div className="sticky top-4 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-2">
          <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">
            Boards
          </p>
          {BOARDS.map(board => {
            const href = `/monday/${board.slug}`
            const active = pathname.startsWith(href)
            return (
              <Link
                key={board.slug}
                href={href}
                className={[
                  'block rounded-md px-2 py-1.5 text-[13px] transition-colors',
                  active
                    ? 'bg-[color:var(--color-bg-secondary)] font-medium text-[color:var(--color-text-primary)]'
                    : 'text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]',
                ].join(' ')}
              >
                {board.label}
              </Link>
            )
          })}
        </div>
      </nav>
    </>
  )
}
