'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'

/**
 * Two-way Today / Yesterday toggle for the Overview daily report.
 * Drives a dedicated `?day=` param so it doesn't collide with the
 * page's main `?range=` date toggle. Server components read `day` and
 * render the matching snapshot.
 */
export function DayToggle({ active }: { active: 'today' | 'yesterday' }) {
  const pathname = usePathname()
  const sp = useSearchParams()

  const hrefFor = (day: 'today' | 'yesterday') => {
    const params = new URLSearchParams(sp.toString())
    // 'today' is the default — keep it off the URL for a clean link.
    if (day === 'today') params.delete('day')
    else params.set('day', day)
    const qs = params.toString()
    return qs ? `${pathname}?${qs}` : pathname
  }

  return (
    <nav className="inline-flex items-center gap-0.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-0.5 text-[11px]">
      {(['today', 'yesterday'] as const).map(day => {
        const isActive = active === day
        return (
          <Link
            key={day}
            href={hrefFor(day)}
            scroll={false}
            className={[
              'rounded-sm px-2.5 py-1 font-medium capitalize transition-colors',
              isActive
                ? 'bg-[color:var(--color-accent)]/15 text-[color:var(--color-text-primary)]'
                : 'text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]',
            ].join(' ')}
          >
            {day}
          </Link>
        )
      })}
    </nav>
  )
}
