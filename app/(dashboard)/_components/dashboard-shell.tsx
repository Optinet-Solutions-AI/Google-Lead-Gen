'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  BookOpen,
  ChevronLeft,
  Clock,
  DollarSign,
  Database,
  Fingerprint,
  Gauge,
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
import { type ProxyBandwidth } from '../_lib/dashboard-queries'
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
    label: 'S-tag Mapping',
    href: '/stag-mapping',
    icon: Fingerprint,
    match: (p: string) => p.startsWith('/stag-mapping'),
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
    // URL keeps the /admin/ prefix for backwards-compat (sidebar
    // entries, deep links). Page is now open to all signed-in users
    // for reveal; admin-only for add/replace/remove.
    label: 'Google Login',
    href: '/admin/google-login',
    icon: KeyRound,
    match: (p: string) => p.startsWith('/admin/google-login'),
  },
  {
    label: 'My Account',
    href: '/account/password',
    icon: KeyRound,
    match: (p: string) => p.startsWith('/account'),
  },
]

const ADMIN_NAV_ITEMS = [
  {
    label: 'Ops (Admin)',
    href: '/admin/ops',
    icon: Gauge,
    match: (p: string) => p.startsWith('/admin/ops'),
  },
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
    // Carries the unresolved-feedback count badge.
    badge: 'openFeedback' as const,
  },
  {
    label: 'Operations (Admin)',
    href: '/admin/operations',
    icon: DollarSign,
    match: (p: string) => p.startsWith('/admin/operations'),
  },
  {
    label: 'Utilization (Admin)',
    href: '/admin/utilization',
    icon: Gauge,
    match: (p: string) => p.startsWith('/admin/utilization'),
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
  proxyBandwidth?: ProxyBandwidth | null
  openFeedbackCount?: number
}

export function DashboardShell({
  children,
  username,
  isAdmin = false,
  proxyBandwidth = null,
  openFeedbackCount = 0,
}: Props) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [expanded, setExpanded] = useState(true)

  const showLabels = expanded || mobileOpen

  // Close the mobile drawer on Escape (backdrop click already closes it).
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [mobileOpen])

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
            aria-label={mobileOpen ? 'Close menu' : expanded ? 'Collapse sidebar' : 'Expand sidebar'}
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
            const badgeCount =
              'badge' in item && item.badge === 'openFeedback' ? openFeedbackCount : 0
            return (
              <Link
                key={item.label}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={[
                  'group relative flex items-center gap-3 rounded-md px-2 py-2 text-[13px] transition-colors',
                  active
                    ? 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-primary)]'
                    : 'text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]',
                ].join(' ')}
                title={
                  showLabels
                    ? undefined
                    : badgeCount > 0
                      ? `${item.label} — ${badgeCount} unresolved`
                      : item.label
                }
              >
                <span className="relative shrink-0">
                  <Icon
                    className={[
                      'h-4 w-4 shrink-0',
                      active ? 'text-[color:var(--color-accent-hover)]' : '',
                    ].join(' ')}
                  />
                  {/* Collapsed sidebar: a small dot on the icon stands in
                      for the count, which has no room to render. */}
                  {!showLabels && badgeCount > 0 && (
                    <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-[color:var(--color-bg-primary)]" />
                  )}
                </span>
                {showLabels && <span>{item.label}</span>}
                {showLabels && badgeCount > 0 && (
                  <span className="ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                    {badgeCount > 99 ? '99+' : badgeCount}
                  </span>
                )}
              </Link>
            )
          })}
        </nav>

        {/* Footer: proxy bandwidth + user + logout */}
        <div className="border-t border-[color:var(--color-border)] px-2 py-2">
          <SidebarBandwidth bw={proxyBandwidth} showLabels={showLabels} />
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

// Client-side GB formatter — mirrors lib/proxy-bandwidth.ts's formatGb,
// duplicated here because that module is server-only and this is a
// client component.
const BYTES_PER_GB = 1024 ** 3
function formatGb(bytes: number): string {
  const gb = bytes / BYTES_PER_GB
  return `${gb >= 100 ? Math.round(gb) : gb.toFixed(1)} GB`
}

/**
 * Compact proxy-bandwidth readout for the sidebar footer. Mirrors the
 * dashboard's BandwidthMeter so the remaining balance is visible on
 * every page. Links to the Dashboard for the full card. Renders an
 * icon-only indicator when the sidebar is collapsed.
 */
function SidebarBandwidth({
  bw,
  showLabels,
}: {
  bw: ProxyBandwidth | null
  showLabels: boolean
}) {
  if (!bw) return null

  const limit = bw.limitBytes > 0 ? bw.limitBytes : 1
  const usedPct = Math.min(100, Math.max(0, (bw.usedBytes / limit) * 100))
  const barCls = bw.isLow
    ? 'bg-rose-500'
    : usedPct >= 80
      ? 'bg-amber-500'
      : 'bg-emerald-500'
  const remaining = formatGb(bw.remainingBytes)

  if (!showLabels) {
    // Collapsed sidebar: gauge icon + thin bar, full readout in tooltip.
    return (
      <Link
        href="/"
        title={`Proxy bandwidth: ${remaining} of ${formatGb(bw.limitBytes)} remaining`}
        className="mb-1 flex flex-col items-center gap-1 rounded-md px-2 py-2 text-[color:var(--color-text-secondary)] transition-colors hover:bg-[color:var(--color-bg-secondary)] hover:text-[color:var(--color-text-primary)]"
      >
        {bw.isLow ? (
          <AlertTriangle className="h-4 w-4 shrink-0 text-rose-500" />
        ) : (
          <Gauge className="h-4 w-4 shrink-0" />
        )}
        <span className="h-1 w-6 overflow-hidden rounded-full bg-[color:var(--color-bg-secondary)]">
          <span className={['block h-full rounded-full', barCls].join(' ')} style={{ width: `${usedPct}%` }} />
        </span>
      </Link>
    )
  }

  return (
    <Link
      href="/"
      title={bw.stale ? 'Reading is stale — the bandwidth poller may not be running' : 'View on Dashboard'}
      className="mb-2 block rounded-md px-2 py-1.5 transition-colors hover:bg-[color:var(--color-bg-secondary)]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          <Gauge className="h-3 w-3" />
          Proxy bandwidth
        </span>
        {bw.isLow && (
          <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-100 px-1.5 py-0.5 text-[9px] font-semibold text-rose-800">
            <AlertTriangle className="h-2.5 w-2.5" />
            Low
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[13px] font-semibold leading-none text-[color:var(--color-text-primary)]">
        {remaining}{' '}
        <span className="text-[11px] font-normal text-[color:var(--color-text-secondary)]">
          of {formatGb(bw.limitBytes)}
        </span>
      </p>
      <span className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-[color:var(--color-bg-secondary)]">
        <span className={['block h-full rounded-full transition-all', barCls].join(' ')} style={{ width: `${usedPct}%` }} />
      </span>
    </Link>
  )
}
