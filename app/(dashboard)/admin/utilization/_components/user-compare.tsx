'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Users, Check } from 'lucide-react'
import type { UserComparison, CompareUserSeries } from '../_lib/compare-queries'

/**
 * "Compare users" tool. Tick two or more users and see them head-to-head
 * over the page's date window (e.g. 20–24 Jul, Jana vs Ryan). The
 * selection rides in `?users=a@x,b@y`; the date window is the page's
 * shared ?range= / ?from=&to=, so the existing toggle + custom picker
 * drive this section too.
 */

// Stable column accent per selected user (up to 6), so a user keeps the
// same colour as you toggle others on/off.
const SERIES_COLORS = [
  'var(--color-accent)',
  '#6aa9ff',
  '#7bd88f',
  '#f6c453',
  '#c792ea',
  '#ff8fab',
]

export function UserCompareSection({ comparison }: { comparison: UserComparison }) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()

  const selected = new Set(
    (sp.get('users') ?? '')
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean),
  )

  const toggle = (email: string) => {
    const next = new Set(selected)
    if (next.has(email)) next.delete(email)
    else next.add(email)
    const params = new URLSearchParams(sp.toString())
    if (next.size === 0) params.delete('users')
    else params.set('users', [...next].join(','))
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  const { roster, dayIsos, series } = comparison

  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
      <header className="mb-3">
        <h2 className="inline-flex items-center gap-2 text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          <Users className="h-4 w-4 text-[color:var(--color-accent)]" />
          Compare users
        </h2>
        <p className="mt-1 max-w-3xl text-[11px] text-[color:var(--color-text-secondary)]">
          Tick two or more users to compare their scrape output head-to-head. The window is the one set
          by the date toggle + custom from/to picker in the <strong>Per-user cap</strong> section above —
          e.g. set 20 Jul → 24 Jul there, then tick Jana and Ryan here.
        </p>
      </header>

      {/* User picker */}
      {roster.length === 0 ? (
        <p className="text-[12px] text-[color:var(--color-text-secondary)]">
          No scrapes by anyone in this window.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {roster.map(email => {
            const on = selected.has(email)
            return (
              <button
                key={email}
                type="button"
                onClick={() => toggle(email)}
                className={[
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                  on
                    ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 text-[color:var(--color-text-primary)]'
                    : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)] hover:brightness-95',
                ].join(' ')}
              >
                {on && <Check className="h-3 w-3" />}
                {email}
              </button>
            )
          })}
        </div>
      )}

      {series.length === 0 ? (
        <p className="mt-4 text-[12px] text-[color:var(--color-text-secondary)]">
          Pick at least one user above to see their numbers.
        </p>
      ) : (
        <>
          {/* Head-to-head summary cards */}
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {series.map((u, i) => (
              <CompareCard key={u.email} user={u} color={SERIES_COLORS[i % SERIES_COLORS.length]!} />
            ))}
          </div>

          {/* Per-day head-to-head table */}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead className="bg-[color:var(--color-bg-secondary)] text-left text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                <tr>
                  <th className="px-3 py-1.5">User</th>
                  <th className="px-3 py-1.5 text-right">Total</th>
                  {dayIsos.map(iso => (
                    <th key={iso} className="px-2 py-1.5 text-right font-mono text-[9px]">
                      {iso.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {series.map((u, i) => {
                  const color = SERIES_COLORS[i % SERIES_COLORS.length]!
                  return (
                    <tr key={u.email} className="border-b border-[color:var(--color-border)] last:border-b-0">
                      <td className="px-3 py-1.5">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                          <span className="font-medium text-[color:var(--color-text-primary)]">{u.email}</span>
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums font-semibold">
                        {u.total.toLocaleString()}
                      </td>
                      {u.byDay.map((c, di) => (
                        <td
                          key={di}
                          className="px-2 py-1.5 text-right font-mono tabular-nums text-[color:var(--color-text-secondary)]"
                        >
                          {c === 0 ? <span className="opacity-30">·</span> : c}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

function CompareCard({ user, color }: { user: CompareUserSeries; color: string }) {
  const successPct = user.total > 0 ? Math.round((user.completed / user.total) * 100) : 0
  return (
    <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3">
      <div className="flex items-center gap-1.5">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
        <span className="truncate text-[12px] font-semibold text-[color:var(--color-text-primary)]" title={user.email}>
          {user.email}
        </span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-[22px] font-semibold tabular-nums text-[color:var(--color-text-primary)]">
          {user.total.toLocaleString()}
        </span>
        <span className="text-[11px] text-[color:var(--color-text-secondary)]">scrapes</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <Metric label="Completed" value={user.completed} tone="text-emerald-700" />
        <Metric label="Success" value={`${successPct}%`} tone="text-[color:var(--color-text-primary)]" />
        <Metric label="Failed" value={user.failed} tone="text-red-700" />
        <Metric label="Captcha" value={user.captcha} tone="text-amber-700" />
      </div>
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: number | string; tone: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[color:var(--color-text-secondary)]">{label}</span>
      <span className={['font-mono tabular-nums font-medium', tone].join(' ')}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </span>
    </div>
  )
}
