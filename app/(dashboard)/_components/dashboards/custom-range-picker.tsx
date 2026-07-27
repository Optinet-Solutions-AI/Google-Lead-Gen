'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CalendarRange, X } from 'lucide-react'

/**
 * Two-input from/to date picker that drives a dashboard's window via
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD` (resolved server-side by
 * resolveDashboardRange). Sits next to the preset DateRangeToggle;
 * applying a custom range clears the preset `?range=` so the two don't
 * fight, and clearing the custom range restores the preset default.
 *
 * Kept deliberately small — native <input type="date"> (no calendar
 * lib), UTC-calendar-day semantics matching resolveDashboardRange.
 */
export function CustomRangePicker({ basePath }: { basePath: string }) {
  const router = useRouter()
  const sp = useSearchParams()

  const activeFrom = sp.get('from') ?? ''
  const activeTo = sp.get('to') ?? ''
  const isActive = Boolean(activeFrom && activeTo)

  const [from, setFrom] = useState(activeFrom)
  const [to, setTo] = useState(activeTo)

  const apply = () => {
    if (!from || !to) return
    const params = new URLSearchParams(sp.toString())
    params.set('from', from)
    params.set('to', to)
    params.delete('range') // custom wins; drop the preset so it's unambiguous
    router.push(`${basePath}?${params.toString()}`, { scroll: false })
  }

  const clear = () => {
    const params = new URLSearchParams(sp.toString())
    params.delete('from')
    params.delete('to')
    setFrom('')
    setTo('')
    const qs = params.toString()
    router.push(qs ? `${basePath}?${qs}` : basePath, { scroll: false })
  }

  const invalid = Boolean(from && to && from > to)

  return (
    <div className="inline-flex flex-wrap items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1">
      <CalendarRange className="h-3.5 w-3.5 shrink-0 text-[color:var(--color-text-secondary)]" />
      <input
        type="date"
        value={from}
        max={to || undefined}
        onChange={e => setFrom(e.target.value)}
        aria-label="From date"
        className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-1.5 py-0.5 text-[11px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none"
      />
      <span className="text-[11px] text-[color:var(--color-text-secondary)]">→</span>
      <input
        type="date"
        value={to}
        min={from || undefined}
        onChange={e => setTo(e.target.value)}
        aria-label="To date"
        className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-1.5 py-0.5 text-[11px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none"
      />
      <button
        type="button"
        onClick={apply}
        disabled={!from || !to || invalid}
        className="rounded bg-[color:var(--color-accent)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-accent-hover)] disabled:opacity-40"
        title={invalid ? 'From date must be on or before To date' : 'Apply custom range'}
      >
        Apply
      </button>
      {isActive && (
        <button
          type="button"
          onClick={clear}
          className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
          title="Clear custom range"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
