'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import {
  Bell,
  BookOpen,
  ChevronLeft,
  Clock,
  Database,
  Globe,
  Hand,
  HelpCircle,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  MessageCircle,
  Search,
  Settings,
  Star,
  Users,
  X,
} from 'lucide-react'
import { signOutAction } from '../_actions/auth'
import { FeedbackWidget } from './feedback-widget'

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
  // Schedules sidebar entry hidden pending the scheduler UI work — the
  // page still exists at /schedules; this is just a sidebar omission.
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
    // Open to all signed-in users so the whole ops team can clear
    // captchas, not just the admin. URL keeps the /admin/ prefix for
    // backwards-compat (banner deep links, browser history).
    label: 'Interactive Checkpoints',
    href: '/admin/interactive',
    icon: Hand,
    match: (p: string) => p.startsWith('/admin/interactive'),
  },
  {
    label: 'Country Profiles',
    href: '/profiles',
    icon: Globe,
    match: (p: string) => p.startsWith('/profiles'),
  },
  {
    label: 'Rooster Brands',
    href: '/brands',
    icon: Star,
    match: (p: string) => p.startsWith('/brands'),
  },
  {
    label: 'Activity Log',
    href: '/activity',
    icon: Clock,
    match: (p: string) => p.startsWith('/activity'),
  },
  {
    label: 'Onboarding',
    href: '/onboarding',
    icon: BookOpen,
    match: (p: string) => p.startsWith('/onboarding'),
  },
  {
    label: 'Help & Docs',
    href: '/help',
    icon: HelpCircle,
    match: (p: string) => p.startsWith('/help'),
  },
  {
    label: 'Change Password',
    href: '/account/password',
    icon: KeyRound,
    match: (p: string) => p.startsWith('/account'),
  },
]

const ADMIN_NAV_ITEMS = [
  {
    label: 'Users (Admin)',
    href: '/admin/users',
    icon: Users,
    match: (p: string) => p.startsWith('/admin/users'),
  },
  {
    label: 'Alert Recipients (Admin)',
    href: '/admin/alerts',
    icon: Bell,
    match: (p: string) => p.startsWith('/admin/alerts'),
  },
  {
    label: 'QA Feedback (Admin)',
    href: '/admin/feedback',
    icon: MessageCircle,
    match: (p: string) => p.startsWith('/admin/feedback'),
  },
  {
    label: 'Google Login (Admin)',
    href: '/admin/google-login',
    icon: KeyRound,
    match: (p: string) => p.startsWith('/admin/google-login'),
  },
  {
    label: 'System (Admin)',
    href: '/admin/system',
    icon: Settings,
    match: (p: string) => p.startsWith('/admin/system'),
  },
] as const

type Props = {
  children: React.ReactNode
  username: string
  isAdmin?: boolean
}

export function DashboardShell({ children, username, isAdmin = false }: Props) {
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
          {[...NAV_ITEMS, ...(isAdmin ? ADMIN_NAV_ITEMS : [])].map(item => {
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

      {/* Floating QA-feedback widget — bottom-right of every dashboard
       *  page. Any signed-in user can fire a row into qa_feedback;
       *  admins triage at /admin/feedback. */}
      <FeedbackWidget />
    </div>
  )
}
