'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import { ChevronLeft, Database, LayoutDashboard, Menu, X } from 'lucide-react'

const NAV_ITEMS = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard, match: (p: string) => p === '/' },
  {
    label: 'Monday Data',
    href: '/monday/leads',
    icon: Database,
    match: (p: string) => p.startsWith('/monday'),
  },
]

type Props = {
  children: React.ReactNode
}

export function DashboardShell({ children }: Props) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="flex min-h-screen bg-[color:var(--color-bg-secondary)]">
      {/* Mobile backdrop */}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={[
          'fixed inset-y-0 left-0 z-40 flex flex-col',
          'border-r border-[color:var(--color-border)]',
          'bg-[color:var(--color-bg-primary)] transition-all duration-200',
          // Mobile: slide in/out
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          // Desktop: always visible, width depends on `expanded`
          'md:translate-x-0',
          expanded ? 'w-60' : 'md:w-16',
          // On mobile when open, full expanded width
          mobileOpen ? 'w-60' : '',
        ].join(' ')}
      >
        {/* Sidebar header */}
        <div className="flex h-14 items-center justify-between border-b border-[color:var(--color-border)] px-4">
          {expanded || mobileOpen ? (
            <span className="text-[13px] font-semibold tracking-wide text-[color:var(--color-text-primary)]">
              Rooster Partners
            </span>
          ) : (
            <span className="text-base font-bold text-[color:var(--color-accent)]">R</span>
          )}
          <button
            type="button"
            aria-label="Toggle menu"
            className="text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
            onClick={() => {
              if (mobileOpen) setMobileOpen(false)
              else setExpanded(prev => !prev)
            }}
          >
            {mobileOpen ? (
              <X className="h-4 w-4" />
            ) : (
              <ChevronLeft
                className={[
                  'h-4 w-4 transition-transform',
                  expanded ? '' : 'rotate-180',
                ].join(' ')}
              />
            )}
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {NAV_ITEMS.map(item => {
            const active = item.match(pathname)
            const Icon = item.icon
            return (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={[
                  'group flex items-center gap-3 rounded-md px-2 py-2 text-[13px]',
                  'transition-colors',
                  active
                    ? 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-primary)]'
                    : 'text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]',
                ].join(' ')}
              >
                <Icon
                  className={[
                    'h-4 w-4 shrink-0',
                    active ? 'text-[color:var(--color-accent-hover)]' : '',
                  ].join(' ')}
                />
                {(expanded || mobileOpen) && <span>{item.label}</span>}
              </Link>
            )
          })}
        </nav>

        {/* Footer */}
        {(expanded || mobileOpen) && (
          <div className="border-t border-[color:var(--color-border)] px-4 py-3 text-[11px] text-[color:var(--color-text-secondary)]">
            v0.1.0
          </div>
        )}
      </aside>

      {/* Main area */}
      <div
        className={[
          'flex min-h-screen flex-1 flex-col',
          'transition-[margin] duration-200',
          // Push content over on desktop based on sidebar width
          expanded ? 'md:ml-60' : 'md:ml-16',
        ].join(' ')}
      >
        {/* Top bar (mobile hamburger) */}
        <header className="flex h-14 items-center gap-3 border-b border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-4 md:hidden">
          <button
            type="button"
            aria-label="Open menu"
            className="text-[color:var(--color-text-primary)]"
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-[13px] font-semibold">Rooster Partners</span>
        </header>

        <main className="flex-1 bg-[color:var(--color-bg-primary)]">{children}</main>
      </div>
    </div>
  )
}
