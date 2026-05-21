import { Hand } from 'lucide-react'
import type { BoardData } from '../_lib/queries'
import {
  EnrichmentRunningCard,
  IdleWorkerCard,
  KanbanCard,
} from './kanban-card'

/**
 * Kanban board view for /scrape. Six columns:
 *   Pending → Next in queue → Running → Idle → Completed → Failed
 *
 * Caps + sort logic live in `queryBoardData()`. Card click → expand
 * in-place (KanbanCard owns that state). Column-width drag-resize is
 * deferred to v2.
 */
export function KanbanBoard({ data }: { data: BoardData }) {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <Column
        title="Pending"
        subtitle="Country lock held"
        count={data.totals.pending}
        tone="slate"
      >
        {data.pending.length === 0 ? (
          <EmptyState text="Nothing waiting on a locked country." />
        ) : (
          data.pending.map(job => (
            <KanbanCard key={job.id} job={job} variant="pending" />
          ))
        )}
      </Column>

      <Column
        title="Next in queue"
        subtitle={`Top ${data.next_in_queue.length} of ${data.totals.next_in_queue}`}
        count={data.totals.next_in_queue}
        tone="amber"
      >
        {data.next_in_queue.length === 0 ? (
          <EmptyState text="Queue is empty." />
        ) : (
          data.next_in_queue.map(job => (
            <KanbanCard key={job.id} job={job} variant="next" />
          ))
        )}
      </Column>

      <Column
        title="Running"
        subtitle={`${data.totals.running} scrape · ${data.totals.running_enrichment} enrich`}
        count={data.totals.running + data.totals.running_enrichment}
        tone="accent"
      >
        {data.running.length === 0 && data.running_enrichment.length === 0 ? (
          <EmptyState text="No workers are claiming anything right now." />
        ) : (
          <>
            {data.running.map(job => (
              <KanbanCard key={job.id} job={job} variant="running" />
            ))}
            {data.running_enrichment.map(job => (
              <EnrichmentRunningCard key={job.id} job={job} />
            ))}
          </>
        )}
      </Column>

      <Column
        title="Idle"
        subtitle="Available workers"
        count={data.totals.idle}
        tone="muted"
      >
        {data.idle.length === 0 ? (
          <EmptyState text="No idle workers — everyone is busy." />
        ) : (
          data.idle.map(w => <IdleWorkerCard key={w.worker_id} worker={w} />)
        )}
      </Column>

      <Column
        title="Completed"
        subtitle="Last 24h"
        count={data.totals.completed}
        tone="emerald"
      >
        {data.completed.length === 0 ? (
          <EmptyState text="No scrapes have finished in the last 24h." />
        ) : (
          data.completed.map(job => (
            <KanbanCard key={job.id} job={job} variant="completed" />
          ))
        )}
      </Column>

      <Column
        title="Failed"
        subtitle="Last 24h · failed / captcha / cancelled"
        count={data.totals.failed}
        tone="rose"
      >
        {data.failed.length === 0 ? (
          <EmptyState text="No failures in the last 24h." />
        ) : (
          data.failed.map(job => (
            <KanbanCard key={job.id} job={job} variant="failed" />
          ))
        )}
      </Column>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Column shell
// ---------------------------------------------------------------------------
const TONE_STYLES: Record<string, { header: string; count: string }> = {
  slate: {
    header: 'border-slate-200',
    count: 'bg-slate-100 text-slate-700',
  },
  amber: {
    header: 'border-amber-200',
    count: 'bg-amber-100 text-amber-800',
  },
  accent: {
    header: 'border-[color:var(--color-accent)]/40',
    count: 'bg-[color:var(--color-accent)]/30 text-[color:var(--color-text-primary)]',
  },
  muted: {
    header: 'border-[color:var(--color-border)]',
    count: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
  },
  emerald: {
    header: 'border-emerald-200',
    count: 'bg-emerald-100 text-emerald-800',
  },
  rose: {
    header: 'border-rose-200',
    count: 'bg-rose-100 text-rose-800',
  },
}

function Column({
  title,
  subtitle,
  count,
  tone,
  children,
}: {
  title: string
  subtitle?: string
  count: number
  tone: keyof typeof TONE_STYLES
  children: React.ReactNode
}) {
  const styles = TONE_STYLES[tone] ?? TONE_STYLES.muted!
  return (
    <section className="flex min-w-0 flex-col rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]/30">
      <header
        className={[
          'flex items-center justify-between border-b px-2.5 py-1.5',
          styles.header,
        ].join(' ')}
      >
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--color-text-primary)]">
            {title}
          </p>
          {subtitle && (
            <p className="truncate text-[10px] text-[color:var(--color-text-secondary)]">
              {subtitle}
            </p>
          )}
        </div>
        <span
          className={[
            'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
            styles.count,
          ].join(' ')}
        >
          {count}
        </span>
      </header>
      <div className="flex flex-col gap-1.5 overflow-y-auto p-2" style={{ maxHeight: '70vh' }}>
        {children}
      </div>
    </section>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <p className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]/40 px-2 py-4 text-center text-[10px] text-[color:var(--color-text-secondary)]">
      <Hand className="mx-auto mb-1 h-3 w-3 opacity-40" />
      {text}
    </p>
  )
}
