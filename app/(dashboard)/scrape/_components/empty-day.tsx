import Link from 'next/link'
import { CalendarRange, Inbox, Users } from 'lucide-react'

/**
 * Shown when the current day + owner scope matches nothing.
 *
 * The list defaults to today and to your own work, so a quiet day (or a day
 * someone else was running the scrapes) would otherwise render as a blank
 * page that reads like a fault. This says which scope is empty and offers the
 * two ways out, including a jump to the most recent day that actually has
 * something.
 */
export function EmptyDay({
  day,
  today,
  ownerScope,
  latestDay,
  params,
}: {
  day: string
  today: string
  ownerScope: string
  /** Most recent day with a batch in this owner scope, if any. */
  latestDay: string | null
  /** Current query string, so the links keep any other filters. */
  params: string
}) {
  const withParam = (key: string, value: string) => {
    const p = new URLSearchParams(params)
    p.set(key, value)
    p.delete('page')
    const qs = p.toString()
    return qs ? `/scrape?${qs}` : '/scrape'
  }

  const mine = ownerScope === 'mine'
  const dayLabel = day === today ? 'today' : day

  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-dashed border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-secondary)]/40 px-4 py-10 text-center">
      <Inbox className="h-6 w-6 text-[color:var(--color-text-secondary)]" />
      <p className="text-[13px] font-medium text-[color:var(--color-text-primary)]">
        No batches {dayLabel === 'today' ? 'today' : `on ${dayLabel}`}
        {mine ? ', queued by you' : ''}
      </p>
      <p className="max-w-md text-[12px] text-[color:var(--color-text-secondary)]">
        The list opens on today and on your own work. Widen it below, or create a scrape.
      </p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        {latestDay && latestDay !== day && (
          <Link
            href={withParam('day', latestDay)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
          >
            <CalendarRange className="h-3.5 w-3.5" />
            Jump to {latestDay}
          </Link>
        )}
        <Link
          href={withParam('day', 'all')}
          className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
        >
          <CalendarRange className="h-3.5 w-3.5" />
          All dates
        </Link>
        {mine && (
          <Link
            href={withParam('owner', 'all')}
            className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
          >
            <Users className="h-3.5 w-3.5" />
            Everyone
          </Link>
        )}
      </div>
    </div>
  )
}
