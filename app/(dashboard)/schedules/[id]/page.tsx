import { notFound } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Play, Trash2 } from 'lucide-react'
import { deleteScheduledSet, runScheduledSetNow } from '../actions'
import { ItemsSection } from '../_components/items-section'
import { SetForm } from '../_components/set-form'
import { describeCron } from '../_lib/cron-presets'
import { getScheduledSet, listActiveCountries } from '../_lib/queries'

export const dynamic = 'force-dynamic'

type Props = {
  params: Promise<{ id: string }>
}

export default async function ScheduleDetailPage({ params }: Props) {
  const { id } = await params
  const [detail, countries] = await Promise.all([
    getScheduledSet(id),
    listActiveCountries(),
  ])
  if (!detail.set) notFound()
  const { set, items } = detail

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-4 md:px-6 md:py-6">
      <header className="flex flex-col gap-1.5">
        <Link
          href="/schedules"
          className="inline-flex w-fit items-center gap-1 text-[12px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to Schedules
        </Link>
        <div className="flex items-center justify-between gap-3">
          <h1 className="truncate text-[16px] font-semibold text-[color:var(--color-text-primary)]">
            {set.name}
          </h1>
          <span
            className={[
              'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium',
              set.is_active
                ? 'bg-green-100 text-green-800'
                : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
            ].join(' ')}
          >
            {set.is_active ? 'active' : 'paused'}
          </span>
        </div>
        <p className="text-[12px] text-[color:var(--color-text-secondary)]">
          {describeCron(set.cron)}
          {' · '}
          {set.item_count} keyword{set.item_count === 1 ? '' : 's'}
          {set.next_run_at && (
            <>
              {' · next run '}
              <time dateTime={set.next_run_at}>{formatTs(set.next_run_at)}</time>
            </>
          )}
        </p>
      </header>

      {/* Set metadata form */}
      <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4">
        <h2 className="mb-3 text-[13px] font-semibold text-[color:var(--color-text-primary)]">
          Schedule
        </h2>
        <SetForm
          mode="edit"
          set={{
            id: set.id,
            name: set.name,
            description: set.description,
            cron: set.cron,
            is_active: set.is_active,
            default_pages: set.default_pages,
          }}
        />
      </section>

      {/* Items */}
      <ItemsSection setId={set.id} items={items} countries={countries} />

      {/* Danger / ops zone */}
      <section className="flex flex-wrap items-center gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] p-3">
        <form action={runScheduledSetNow}>
          <input type="hidden" name="id" value={set.id} />
          <button
            type="submit"
            title="Forces next_run_at into the past so the next /api/scheduler/tick enqueues this set's items."
            className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
          >
            <Play className="h-3 w-3" />
            Run now
          </button>
        </form>

        <form action={deleteScheduledSet} className="ml-auto">
          <input type="hidden" name="id" value={set.id} />
          <button
            type="submit"
            className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-white px-3 py-1.5 text-[12px] font-medium text-red-700 hover:bg-red-50"
          >
            <Trash2 className="h-3 w-3" />
            Delete schedule
          </button>
        </form>
      </section>
    </div>
  )
}

function formatTs(iso: string | null): string {
  if (!iso) return '—'
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
