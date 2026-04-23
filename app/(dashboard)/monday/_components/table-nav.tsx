'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BOARDS } from '../_lib/tables'

/**
 * Horizontal pill nav for the 4 Monday boards. Renders above the
 * Items/Updates tabs inside TableView. The previous right-side rail
 * was taking ~48 rem of horizontal space on desktop; putting the nav
 * in the header area gives the table back that width.
 *
 * On narrow viewports the pills scroll horizontally (no visible
 * scrollbar).
 */
export function TableNav() {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Monday boards"
      className="no-scrollbar flex gap-2 overflow-x-auto"
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
  )
}
