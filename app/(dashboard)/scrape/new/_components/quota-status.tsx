'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Clock, ListOrdered } from 'lucide-react'
import { dayLabel, formatCountdown, msUntilUtcMidnight, utcDay, type QuotaPreview } from '../_lib/wizard-helpers'

type Props = {
  quota: QuotaPreview
  /** Which UTC day the pill should describe. Defaults to today. */
  day?: string
  /** Compact pill for headers; `full` renders the per-day breakdown too. */
  variant?: 'pill' | 'full'
}

/** Live countdown to UTC midnight, ticking once a second. */
export function useResetCountdown(active: boolean): string {
  const [label, setLabel] = useState(() => formatCountdown(msUntilUtcMidnight()))
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setLabel(formatCountdown(msUntilUtcMidnight())), 1000)
    return () => clearInterval(id)
  }, [active])
  return label
}

export function remainingFor(quota: QuotaPreview, day: string): number | null {
  if (quota.cap === null) return null
  const used = quota.days.find(d => d.day === day)?.used ?? 0
  return Math.max(quota.cap - used, 0)
}

/**
 * "17 of 20 keywords remaining today" pill. Links to the today's-queue page.
 * When the day is used up, the pill turns red and shows a countdown to the
 * UTC-midnight reset.
 */
export function QuotaStatus({ quota, day, variant = 'pill' }: Props) {
  const today = utcDay(new Date())
  const d = day ?? today
  const remaining = remainingFor(quota, d)
  const full = remaining === 0 && d === today
  const countdown = useResetCountdown(full)

  if (quota.cap === null) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--color-bg-secondary)] px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-text-secondary)]">
        No daily cap on this account
      </span>
    )
  }

  const tone = full
    ? 'bg-red-100 text-red-800'
    : remaining !== null && remaining <= Math.max(1, Math.floor(quota.cap * 0.25))
      ? 'bg-amber-100 text-amber-900'
      : 'bg-emerald-100 text-emerald-800'

  return (
    <div className={variant === 'full' ? 'flex flex-col gap-2' : 'inline-flex'}>
      <Link
        href="/scrape/today"
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-opacity hover:opacity-80 ${tone}`}
        title="Open today's scraping list"
      >
        <ListOrdered className="h-3.5 w-3.5" />
        {full ? (
          <>
            <span>Daily limit reached</span>
            <span className="inline-flex items-center gap-1 font-mono tabular-nums">
              <Clock className="h-3 w-3" /> resets in {countdown}
            </span>
          </>
        ) : (
          <span>
            {remaining} of {quota.cap} keywords remaining {dayLabel(d).toLowerCase()}
          </span>
        )}
        {quota.exempt && <span className="opacity-70">· you are exempt (preview)</span>}
      </Link>
      {variant === 'full' && (
        <ul className="flex flex-wrap gap-1.5 text-[11px]">
          {quota.days.map(x => {
            const r = Math.max(quota.cap! - x.used, 0)
            return (
              <li
                key={x.day}
                className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[color:var(--color-text-secondary)]"
              >
                <span className="font-medium text-[color:var(--color-text-primary)]">{dayLabel(x.day)}</span>
                {' · '}
                {r} left
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
