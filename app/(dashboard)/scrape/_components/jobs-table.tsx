import type { ScrapeJob } from '../_lib/queries'

type Props = { jobs: ScrapeJob[] }

const STATUS_STYLES: Record<ScrapeJob['status'], string> = {
  pending: 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)]',
  running: 'bg-[color:var(--color-accent)]/50 text-[color:var(--color-text-primary)]',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  captcha: 'bg-amber-100 text-amber-800',
}

export function JobsTable({ jobs }: Props) {
  if (jobs.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-4 py-10 text-center text-[12px] text-[color:var(--color-text-secondary)]">
        No scrapes queued yet. Submit one above.
      </div>
    )
  }

  return (
    <div className="hidden overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] md:block">
      <table className="w-full border-collapse text-[11px]">
        <thead className="bg-[color:var(--color-bg-secondary)]">
          <tr>
            <Th>Keyword</Th>
            <Th>Country</Th>
            <Th>Pages</Th>
            <Th>Status</Th>
            <Th>Worker</Th>
            <Th>Started</Th>
            <Th>Duration</Th>
            <Th>Results</Th>
            <Th>Batch</Th>
            <Th>Error</Th>
          </tr>
        </thead>
        <tbody>
          {jobs.map(job => (
            <tr
              key={job.id}
              className="border-b border-[color:var(--color-border)] last:border-b-0"
            >
              <Td className="max-w-[280px] truncate" title={job.keyword}>
                {job.keyword}
              </Td>
              <Td>{job.country_code}</Td>
              <Td>{job.pages}</Td>
              <Td>
                <span
                  className={[
                    'inline-block rounded-full px-2 py-0.5 text-[10px] font-medium',
                    STATUS_STYLES[job.status],
                  ].join(' ')}
                >
                  {job.status}
                  {job.attempts > 1 ? ` · ${job.attempts}` : ''}
                </span>
              </Td>
              <Td className="text-[color:var(--color-text-secondary)]">
                {job.claimed_by ?? '—'}
              </Td>
              <Td>{formatTimestamp(job.started_at)}</Td>
              <Td>{formatDuration(job.started_at, job.completed_at)}</Td>
              <Td>{totalResults(job.result_summary) ?? '—'}</Td>
              <Td>{job.batch_id ?? '—'}</Td>
              <Td className="max-w-[280px] truncate text-red-700" title={job.error_message ?? ''}>
                {job.error_message ?? ''}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Mobile card layout below — same data, stacked.
export function JobsCardList({ jobs }: Props) {
  if (jobs.length === 0) return null
  return (
    <div className="flex flex-col gap-2 md:hidden">
      {jobs.map(job => (
        <div
          key={job.id}
          className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3"
        >
          <div className="mb-1.5 flex items-start justify-between gap-2">
            <p className="truncate text-[13px] font-medium text-[color:var(--color-text-primary)]">
              {job.keyword}
            </p>
            <span
              className={[
                'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
                STATUS_STYLES[job.status],
              ].join(' ')}
            >
              {job.status}
            </span>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[color:var(--color-text-secondary)]">
            <span>{job.country_code}</span>
            <span>{job.pages} {job.pages === 1 ? 'page' : 'pages'}</span>
            {job.claimed_by && <span>worker {job.claimed_by}</span>}
            <span>{formatDuration(job.started_at, job.completed_at)}</span>
            {totalResults(job.result_summary) !== null && (
              <span>{totalResults(job.result_summary)} results</span>
            )}
          </div>
          {job.error_message && (
            <p className="mt-1.5 text-[11px] text-red-700" title={job.error_message}>
              {job.error_message.length > 100
                ? job.error_message.slice(0, 100) + '…'
                : job.error_message}
            </p>
          )}
        </div>
      ))}
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

function Td({
  children,
  className,
  title,
}: {
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <td
      {...(title ? { title } : {})}
      className={['whitespace-nowrap px-3 py-2 align-middle', className ?? ''].join(' ')}
    >
      {children}
    </td>
  )
}

function totalResults(summary: Record<string, unknown> | null): number | null {
  if (!summary) return null
  const v = summary['total_results']
  if (typeof v === 'number') return v
  return null
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return iso
  }
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '—'
  const start = new Date(startedAt).getTime()
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  if (Number.isNaN(start)) return '—'
  const secs = Math.max(0, Math.round((end - start) / 1000))
  if (secs < 60) return `${secs}s`
  return `${Math.floor(secs / 60)}m ${secs % 60}s`
}
