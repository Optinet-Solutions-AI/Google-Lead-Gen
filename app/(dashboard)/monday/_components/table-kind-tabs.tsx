'use client'

import Link from 'next/link'

type Props = {
  boardSlug: string
  active: 'items' | 'updates'
}

/** Items ↔ Updates tab pair shown at the top of every board page. */
export function TableKindTabs({ boardSlug, active }: Props) {
  const tabs = [
    { key: 'items' as const, label: 'Items', href: `/monday/${boardSlug}` },
    { key: 'updates' as const, label: 'Updates', href: `/monday/${boardSlug}/updates` },
  ]

  return (
    <div className="flex border-b border-[color:var(--color-border)]">
      {tabs.map(tab => {
        const isActive = tab.key === active
        return (
          <Link
            key={tab.key}
            href={tab.href}
            className={[
              'relative px-4 py-2 text-[13px] font-medium transition-colors',
              isActive
                ? 'text-[color:var(--color-text-primary)]'
                : 'text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]',
            ].join(' ')}
          >
            {tab.label}
            {isActive && (
              <span className="absolute bottom-[-1px] left-0 right-0 h-[2px] bg-[color:var(--color-accent)]" />
            )}
          </Link>
        )
      })}
    </div>
  )
}
