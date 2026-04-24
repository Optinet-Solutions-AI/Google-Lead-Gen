import Link from 'next/link'
import { Plus } from 'lucide-react'
import { describeCron } from './_lib/cron-presets'
import { listScheduledSets } from './_lib/queries'

export const dynamic = 'force-dynamic'

export default async function SchedulesPage() {
  const sets = await listScheduledSets()

  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            Schedules
          </h1>
          <p className="mt-0.5 text-[12px] text-[color:var(--color-text-secondary)]">
            Named keyword sets that enqueue scrapes automatically via Vercel cron.
            Each active set fires per its cron expression; the tick endpoint runs
            every minute and enqueues any due sets&apos; items.
          </p>
        </div>

        <Link
          href="/schedules/new"
          className="inline-flex items-center gap-1 rounded-md bg-[color:var(--color-accent)] px-3 py-2 text-[12px] font-medium text-[color:var(--color-text-primary)] transition-colors hover:bg-[color:var(--color-accent-hover)]"
        >
          <Plus className="h-3.5 w-3.5" />
          New schedule
        </Link>
      </header>

      {sets.length === 0 ? (
        <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-4 py-12 text-center">
          <p className="text-[14px] font-medium text-[color:var(--color-text-primary)]">
            No schedules yet
          </p>
          <p className="mt-1 text-[12px] text-[color:var(--color-text-secondary)]">
            Create one to run keyword scrapes on a repeating cadence.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
          <table className="w-full border-collapse text-[12px]">
            <thead className="bg-[color:var(--color-bg-secondary)]">
              <tr>
                <Th>Name</Th>
                <Th>Schedule</Th>
                <Th>Items</Th>
                <Th>Default pages</Th>
                <Th>Active</Th>
                <Th>Next run</Th>
                <Th>Last run</Th>
              </tr>
            </thead>
            <tbody>
              {sets.map(s => {
                const href = `/schedules/${s.id}`
                return (
                  <tr
                    key={s.id}
                    className="border-b border-[color:var(--color-border)] last:border-b-0 hover:bg-[color:var(--color-bg-secondary)]"
                  >
                    <LinkTd href={href} className="font-medium">
                      {s.name}
                    </LinkTd>
                    <LinkTd href={href} className="text-[color:var(--color-text-secondary)]">
                      {describeCron(s.cron)}
                    </LinkTd>
                    <LinkTd href={href}>{s.item_count}</LinkTd>
                    <LinkTd href={href}>{s.default_pages}</LinkTd>
                    <LinkTd href={href}>
                      <span
                        className={[
                          'inline-block rounded-full px-2 py-0.5 text-[10px] font-medium',
                          s.is_active
                            ? 'bg-green-100 text-green-800'
                            : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
                        ].join(' ')}
                      >
                        {s.is_active ? 'active' : 'paused'}
                      </span>
                    </LinkTd>
                    <LinkTd href={href} className="text-[color:var(--color-text-secondary)]">
                      {formatTs(s.next_run_at) ?? '—'}
                    </LinkTd>
                    <LinkTd href={href} className="text-[color:var(--color-text-secondary)]">
                      {formatTs(s.last_run_at) ?? 'never'}
                    </LinkTd>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="whitespace-nowrap border-b border-[color:var(--color-border)] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]"
    >
      {children}
    </th>
  )
}

function LinkTd({
  href,
  children,
  className,
}: {
  href: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <td className="p-0">
      <Link
        href={href}
        className={['block whitespace-nowrap px-3 py-2 text-[color:var(--color-text-primary)]', className ?? ''].join(' ')}
      >
        {children}
      </Link>
    </td>
  )
}

function formatTs(iso: string | null): string | null {
  if (!iso) return null
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
