import Link from 'next/link'
import { SortHeader } from '../../monday/_components/sort-header'
import type { LeadRow } from '../_lib/query'

type Props = {
  rows: LeadRow[]
}

export function LeadsTable({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-4 py-10 text-center text-[12px] text-[color:var(--color-text-secondary)]">
        No results match the current filters.
      </div>
    )
  }

  return (
    <>
      {/* Desktop — table */}
      <div className="hidden overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] md:block">
        <table className="w-full border-collapse text-[11px]">
          <thead className="bg-[color:var(--color-bg-secondary)]">
            <tr>
              <Th><SortHeader columnKey="keyword" label="Keyword" sortable /></Th>
              <Th><SortHeader columnKey="country_code" label="Country" sortable /></Th>
              <Th><SortHeader columnKey="result_type" label="Type" sortable /></Th>
              <Th><SortHeader columnKey="overall_position" label="Pos" sortable /></Th>
              <Th><SortHeader columnKey="page_number" label="Page" sortable /></Th>
              <Th><SortHeader columnKey="domain" label="Domain" sortable /></Th>
              <Th>URL</Th>
              <Th><SortHeader columnKey="batch_id" label="Batch" sortable /></Th>
              <Th><SortHeader columnKey="created_at" label="Scraped at" sortable /></Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr
                key={row.id}
                className="border-b border-[color:var(--color-border)] transition-colors last:border-b-0 hover:bg-[color:var(--color-bg-secondary)]"
              >
                <Td className="max-w-[220px] truncate" title={row.keyword ?? ''}>{row.keyword ?? '—'}</Td>
                <Td>{row.country_code ?? '—'}</Td>
                <Td>
                  <TypeBadge type={row.result_type} />
                </Td>
                <Td>{row.overall_position ?? '—'}</Td>
                <Td>{row.page_number ?? '—'}</Td>
                <Td>{row.domain ?? '—'}</Td>
                <Td className="max-w-[320px] truncate">
                  {row.url ? (
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-semibold underline underline-offset-2 decoration-[color:var(--color-text-primary)]"
                    >
                      {row.url.length > 60 ? row.url.slice(0, 60) + '…' : row.url}
                    </a>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td>
                  {row.scrape_job_id ? (
                    <Link
                      href={`/scrape/${row.scrape_job_id}`}
                      className="underline underline-offset-2 decoration-[color:var(--color-text-secondary)] hover:decoration-[color:var(--color-text-primary)]"
                    >
                      {row.batch_id ?? '—'}
                    </Link>
                  ) : (
                    row.batch_id ?? '—'
                  )}
                </Td>
                <Td className="text-[color:var(--color-text-secondary)]">
                  {formatTimestamp(row.created_at)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile — card list */}
      <div className="flex flex-col gap-2 md:hidden">
        {rows.map(row => (
          <div
            key={row.id}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3"
          >
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <p className="truncate text-[13px] font-medium text-[color:var(--color-text-primary)]">
                {row.keyword ?? '—'}
              </p>
              <TypeBadge type={row.result_type} />
            </div>
            <dl className="space-y-1 text-[12px]">
              <Field label="Country">{row.country_code ?? '—'}</Field>
              <Field label="Domain">{row.domain ?? '—'}</Field>
              <Field label="URL">
                {row.url ? (
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all font-semibold underline underline-offset-2 decoration-[color:var(--color-text-primary)]"
                  >
                    {row.url.length > 80 ? row.url.slice(0, 80) + '…' : row.url}
                  </a>
                ) : (
                  '—'
                )}
              </Field>
              <Field label="Position">
                #{row.overall_position ?? '—'} (page {row.page_number ?? '—'})
              </Field>
              <Field label="Batch">
                {row.scrape_job_id ? (
                  <Link
                    href={`/scrape/${row.scrape_job_id}`}
                    className="underline underline-offset-2"
                  >
                    {row.batch_id ?? '—'}
                  </Link>
                ) : (
                  row.batch_id ?? '—'
                )}
              </Field>
            </dl>
            <p className="mt-1.5 text-[11px] text-[color:var(--color-text-secondary)]">
              {formatTimestamp(row.created_at)}
            </p>
          </div>
        ))}
      </div>
    </>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="whitespace-nowrap border-b border-[color:var(--color-border)] px-3 py-2 text-left align-middle"
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
      className={['whitespace-nowrap px-3 py-2 align-top text-[color:var(--color-text-primary)]', className ?? ''].join(' ')}
    >
      {children}
    </td>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-[color:var(--color-text-secondary)]">{label}:</dt>
      <dd className="min-w-0 text-[color:var(--color-text-primary)]">{children}</dd>
    </div>
  )
}

function TypeBadge({ type }: { type: string | null }) {
  if (!type) return <span className="text-[color:var(--color-text-secondary)]">—</span>
  const styles =
    type === 'PPC'
      ? 'bg-amber-100 text-amber-800'
      : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-primary)]'
  return (
    <span className={['inline-block rounded-full px-2 py-0.5 text-[10px] font-medium', styles].join(' ')}>
      {type}
    </span>
  )
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}
