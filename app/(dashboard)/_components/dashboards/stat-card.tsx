'use client'

import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { DashboardModal } from './dashboard-modal'

/**
 * Clickable statistic card. When `drilldown` is provided, the card
 * becomes a button that opens a modal with that content — every
 * dashboard uses this so operators can click any number to see the
 * rows / rationale behind it.
 *
 * When `drilldown` is null, renders as a plain non-clickable card
 * (matches the historical Stat component). This lets us bump one
 * component into every dashboard without forcing every stat to have
 * a drill-down.
 */
export type StatTone = 'plain' | 'ok' | 'warn' | 'bad' | 'emphasis'

export type StatCardProps = {
  label: string
  value: string | number
  hint?: string
  tone?: StatTone
  /** Optional trend delta ("+12%" / "-3%"). Rendered inline. */
  delta?: {
    text: string
    direction: 'up' | 'down' | 'flat'
  }
  drilldown?: {
    title: string
    subtitle?: string
    body: React.ReactNode
  } | null
}

export function StatCard({ label, value, hint, tone = 'plain', delta, drilldown }: StatCardProps) {
  const [open, setOpen] = useState(false)
  const ring = toneRing(tone)
  const isClickable = !!drilldown

  const inner = (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          {label}
        </div>
        {isClickable && (
          <ExternalLink
            className="h-3 w-3 shrink-0 text-[color:var(--color-text-secondary)]"
            aria-hidden
          />
        )}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <div className="text-[20px] font-semibold text-[color:var(--color-text-primary)] tabular-nums">
          {typeof value === 'number' ? value.toLocaleString() : value}
        </div>
        {delta && (
          <span
            className={[
              'text-[11px] font-medium tabular-nums',
              delta.direction === 'up'
                ? 'text-emerald-700'
                : delta.direction === 'down'
                  ? 'text-red-700'
                  : 'text-[color:var(--color-text-secondary)]',
            ].join(' ')}
          >
            {delta.text}
          </span>
        )}
      </div>
      {hint && (
        <div className="mt-0.5 text-[10px] text-[color:var(--color-text-secondary)]">
          {hint}
        </div>
      )}
    </>
  )

  if (!isClickable) {
    return <div className={['rounded-md border px-3 py-2', ring].join(' ')}>{inner}</div>
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={[
          'block rounded-md border px-3 py-2 text-left transition-all hover:shadow-sm hover:brightness-[0.97] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)]',
          ring,
        ].join(' ')}
        title="Click for the rows behind this number"
      >
        {inner}
      </button>
      {drilldown && (
        <DashboardModal
          open={open}
          onClose={() => setOpen(false)}
          title={drilldown.title}
          {...(drilldown.subtitle ? { subtitle: drilldown.subtitle } : {})}
        >
          {drilldown.body}
        </DashboardModal>
      )}
    </>
  )
}

function toneRing(tone: StatTone): string {
  switch (tone) {
    case 'warn':
      return 'border-amber-300 bg-amber-50'
    case 'ok':
      return 'border-emerald-300 bg-emerald-50'
    case 'bad':
      return 'border-red-300 bg-red-50'
    case 'emphasis':
      return 'border-[color:var(--color-accent)] bg-[color:var(--color-bg-secondary)]'
    case 'plain':
    default:
      return 'border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]'
  }
}
