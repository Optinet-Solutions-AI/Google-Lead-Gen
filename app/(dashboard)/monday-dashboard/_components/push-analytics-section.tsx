'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { Download, Send, TrendingUp, Users } from 'lucide-react'
import type { MondayPushSummary } from '../../_lib/monday-push-queries'

/**
 * Client-side wrapper for the "Pushed to Monday" panel. Renders four
 * summary tiles + a trend chart + two leaderboards. Every click-through
 * (tile / chart bar / leaderboard row) opens the [[PushDetailSheet]]
 * by pushing URL params — no React state / provider plumbing.
 *
 * Why client: the leaderboards and chart bars use <Link> to change URL
 * search params; that composes cleanly with the sheet's URL-driven
 * open/close. The parent page passes the pre-computed summary in via
 * props so no server queries fire from here.
 */

type Props = {
  summary: MondayPushSummary
  rangeLabel: string
  rangeKey: string
}

export function PushAnalyticsSection({ summary, rangeLabel, rangeKey }: Props) {
  const pathname = usePathname()
  const sp = useSearchParams()

  const openWith = (extras: Record<string, string>) => {
    const params = new URLSearchParams(sp.toString())
    params.set('push_detail', '1')
    for (const [k, v] of Object.entries(extras)) params.set(k, v)
    return `${pathname}?${params.toString()}`
  }

  const openBase = openWith({})
  const openTopExportUrl = (() => {
    const qs = new URLSearchParams()
    qs.set('range', rangeKey)
    return `/api/monday-dashboard/push-export?${qs.toString()}`
  })()

  return (
    <div className="flex flex-col gap-3">
      {/* Header row with "View all + Export" affordance */}
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] text-[color:var(--color-text-secondary)]">
          Leads sent to Monday via <span className="font-medium text-[color:var(--color-text-primary)]">Push to Monday</span> from
          the Leads / Scrape pages. Click any tile or row to see the underlying leads.
        </p>
        <div className="flex items-center gap-2">
          <a
            href={openTopExportUrl}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-secondary)] px-2.5 py-1.5 text-[11px] font-medium text-[color:var(--color-text-primary)] hover:brightness-95"
            title="Download every push in this window as CSV"
            download
          >
            <Download className="h-3.5 w-3.5" />
            Export all
          </a>
          <Link
            href={openBase}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10 px-2.5 py-1.5 text-[11px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/20"
            scroll={false}
          >
            View details
          </Link>
        </div>
      </div>

      {/* Summary tiles — all clickable */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ClickableTile
          href={openBase}
          label="Pushed all time"
          value={summary.totalPushed}
          hint={`Across every lead we've ever pushed`}
          icon={<Send className="h-3.5 w-3.5" />}
          tone="plain"
        />
        <ClickableTile
          href={openBase}
          label={`Pushed · ${rangeLabel}`}
          value={summary.pushedInWindow}
          hint={`In the current window`}
          icon={<TrendingUp className="h-3.5 w-3.5" />}
          tone={summary.pushedInWindow > 0 ? 'accent' : 'plain'}
        />
        <ClickableTile
          href={openBase}
          label="Pushed today (24h)"
          value={summary.pushedToday}
          hint="Last rolling 24 hours"
          icon={<Send className="h-3.5 w-3.5" />}
          tone={summary.pushedToday > 0 ? 'good' : 'plain'}
        />
        <ClickableTile
          href={openBase}
          label={`Unique pushers · ${rangeLabel}`}
          value={summary.uniquePushers}
          hint="Distinct operators in window"
          icon={<Users className="h-3.5 w-3.5" />}
          tone="plain"
        />
      </div>

      {/* Trend chart — only when window spans multiple days */}
      {summary.dailyTrend.length > 0 && (
        <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              Daily push volume · {rangeLabel}
            </span>
            <span className="text-[10px] text-[color:var(--color-text-secondary)]">
              Click a bar to drill into that day
            </span>
          </div>
          <ClickableBarChart
            points={summary.dailyTrend}
            barHref={pt => openWith({ push_day: pt.day })}
          />
        </div>
      )}

      {/* Leaderboards */}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
            Top pushers · {rangeLabel}
          </div>
          {summary.pusherLeaderboard.length === 0 ? (
            <div className="py-4 text-center text-[11px] text-[color:var(--color-text-secondary)]">
              No pushes in this window.
            </div>
          ) : (
            <LeaderboardList
              rows={summary.pusherLeaderboard}
              linkFor={r => openWith({ push_pusher: r.label })}
            />
          )}
        </div>
        <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3">
          <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
            Top countries · {rangeLabel}
          </div>
          {summary.countryLeaderboard.length === 0 ? (
            <div className="py-4 text-center text-[11px] text-[color:var(--color-text-secondary)]">
              No pushes in this window.
            </div>
          ) : (
            <LeaderboardList
              rows={summary.countryLeaderboard}
              linkFor={r => openWith({ push_country: r.label })}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function ClickableTile({
  href,
  label,
  value,
  hint,
  icon,
  tone,
}: {
  href: string
  label: string
  value: number
  hint?: string
  icon?: React.ReactNode
  tone: 'plain' | 'accent' | 'good'
}) {
  const ring =
    tone === 'accent'
      ? 'border-[color:var(--color-accent)] bg-[color:var(--color-bg-secondary)]'
      : tone === 'good'
        ? 'border-emerald-300 bg-emerald-50'
        : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]'
  return (
    <Link
      href={href}
      scroll={false}
      className={[
        'block rounded-md border px-3 py-2 text-left transition-all hover:shadow-sm hover:brightness-[0.97] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]',
        ring,
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          {label}
        </span>
        <span className="text-[color:var(--color-text-secondary)]">{icon}</span>
      </div>
      <div className="mt-1 text-[20px] font-semibold tabular-nums text-[color:var(--color-text-primary)]">
        {value.toLocaleString()}
      </div>
      {hint && (
        <div className="mt-0.5 text-[10px] text-[color:var(--color-text-secondary)]">{hint}</div>
      )}
    </Link>
  )
}

/**
 * Bar chart with clickable bars. Reuses the same look as TrendChart
 * (SVG, no chart lib) but each bar wraps in an anchor so the operator
 * can jump straight into that day's rows.
 */
function ClickableBarChart({
  points,
  barHref,
}: {
  points: Array<{ label: string; value: number; day: string }>
  barHref: (pt: { label: string; value: number; day: string }) => string
}) {
  const height = 140
  const barGap = 6
  const totalBars = points.length
  const yMax = Math.max(1, ...points.map(p => p.value))

  // Sparse x-axis labels (first, middle, last) so we don't crowd.
  const labelIdx = totalBars <= 5
    ? points.map((_, i) => i)
    : [0, Math.floor(totalBars / 2), totalBars - 1]

  return (
    <div className="w-full">
      <div
        className="flex items-end gap-[var(--gap)]"
        style={{ '--gap': `${barGap}px`, height } as React.CSSProperties}
      >
        {points.map((p, i) => {
          const h = Math.max(2, (p.value / yMax) * (height - 20))
          return (
            <Link
              key={i}
              href={barHref(p)}
              scroll={false}
              title={`${p.label} — ${p.value.toLocaleString()} push${p.value === 1 ? '' : 'es'}`}
              className="group flex flex-1 flex-col items-center justify-end"
            >
              <div className="text-[9px] tabular-nums text-[color:var(--color-text-secondary)] opacity-0 transition-opacity group-hover:opacity-100">
                {p.value.toLocaleString()}
              </div>
              <div
                className="w-full rounded-t-sm bg-[color:var(--color-accent)]/70 transition-all group-hover:bg-[color:var(--color-accent)]"
                style={{ height: `${h}px` }}
              />
            </Link>
          )
        })}
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-[color:var(--color-text-secondary)]">
        {labelIdx.map(i => (
          <span key={i}>{points[i]!.label}</span>
        ))}
      </div>
    </div>
  )
}

function LeaderboardList({
  rows,
  linkFor,
}: {
  rows: Array<{ label: string; value: number }>
  linkFor: (r: { label: string; value: number }) => string
}) {
  const max = Math.max(1, ...rows.map(r => r.value))
  return (
    <ul className="flex flex-col gap-1">
      {rows.map(r => {
        const pct = Math.max(4, Math.round((r.value / max) * 100))
        return (
          <li key={r.label}>
            <Link
              href={linkFor(r)}
              scroll={false}
              className="group flex items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-[color:var(--color-bg-secondary)]"
            >
              <span className="min-w-0 flex-1 truncate text-[11px] text-[color:var(--color-text-primary)]">
                {r.label}
              </span>
              <span className="relative h-1.5 w-24 overflow-hidden rounded-full bg-[color:var(--color-bg-secondary)]">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-[color:var(--color-accent)]/70 transition-all group-hover:bg-[color:var(--color-accent)]"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="w-10 shrink-0 text-right text-[11px] font-medium tabular-nums text-[color:var(--color-text-primary)]">
                {r.value.toLocaleString()}
              </span>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

