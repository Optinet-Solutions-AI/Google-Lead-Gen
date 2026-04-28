'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import {
  CalendarClock,
  ChevronLeft,
  Database,
  Globe,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Search,
  X,
} from 'lucide-react'
import { signOutAction } from '../_actions/auth'

const NAV_ITEMS = [
  {
    label: 'Dashboard',
    href: '/',
    icon: LayoutDashboard,
    match: (p: string) => p === '/',
  },
  {
    label: 'Scrape',
    href: '/scrape',
    icon: Search,
    match: (p: string) => p.startsWith('/scrape'),
  },
  {
    label: 'Schedules',
    href: '/schedules',
    icon: CalendarClock,
    match: (p: string) => p.startsWith('/schedules'),
  },
  {
    label: 'Leads',
    href: '/leads',
    icon: ListChecks,
    match: (p: string) => p.startsWith('/leads'),
  },
  {
    label: 'Monday Data',
    href: '/monday/leads',
    icon: Database,
    match: (p: string) => p.startsWith('/monday'),
  },
  {
    label: 'Country Profiles',
    href: '/profiles',
    icon: Globe,
    match: (p: string) => p.startsWith('/profiles'),
  },
  {
    label: 'Change Password',
    href: '/account/password',
    icon: KeyRound,
    match: (p: string) => p.startsWith('/account'),
  },
]

type Props = {
  children: React.ReactNode
  username: string
}

export function DashboardShell({ children, username }: Props) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [expanded, setExpanded] = useState(true)

  const showLabels = expanded || mobileOpen

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
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
          'md:translate-x-0',
          expanded ? 'w-60' : 'md:w-16',
          mobileOpen ? 'w-60' : '',
        ].join(' ')}
      >
        {/* Header */}
        <div className="flex h-14 items-center justify-between border-b border-[color:var(--color-border)] px-4">
          {showLabels ? (
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

        {/* Nav */}
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
                  'group flex items-center gap-3 rounded-md px-2 py-2 text-[13px] transition-colors',
                  active
                    ? 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-primary)]'
                    : 'text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]',
                ].join(' ')}
                title={showLabels ? undefined : item.label}
              >
                <Icon
                  className={[
                    'h-4 w-4 shrink-0',
                    active ? 'text-[color:var(--color-accent-hover)]' : '',
                  ].join(' ')}
                />
                {showLabels && <span>{item.label}</span>}
              </Link>
            )
          })}
        </nav>

        {/* Footer: user + logout */}
        <div className="border-t border-[color:var(--color-border)] px-2 py-2">
          {showLabels && (
            <p className="px-2 pb-1 text-[11px] text-[color:var(--color-text-secondary)]">
              Signed in as <span className="text-[color:var(--color-text-primary)]">{username}</span>
            </p>
          )}
          <form action={signOutAction}>
            <button
              type="submit"
              title={showLabels ? undefined : 'Sign out'}
              className="group flex w-full items-center gap-3 rounded-md px-2 py-2 text-[13px] text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
            >
              <LogOut className="h-4 w-4 shrink-0" />
              {showLabels && <span>Sign out</span>}
            </button>
          </form>
        </div>
      </aside>

      {/* Main area */}
      <div
        className={[
          'flex min-h-screen min-w-0 flex-1 flex-col transition-[margin] duration-200',
          expanded ? 'md:ml-60' : 'md:ml-16',
        ].join(' ')}
      >
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

        <main className="min-w-0 flex-1 bg-[color:var(--color-bg-primary)]">{children}</main>
      </div>
    </div>
  )
}
