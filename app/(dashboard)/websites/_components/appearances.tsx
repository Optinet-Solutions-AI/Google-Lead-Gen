import Link from 'next/link'
import { EyeOff, ExternalLink } from 'lucide-react'
import type { Appearance } from '../_lib/query'

/**
 * Every time this website turned up in a SERP.
 *
 * These are the only genuinely per-row facts left once the verdicts move
 * to the website: which keyword found it, in which country, where it
 * ranked, and which batch it came from. Read down the keyword column and
 * you can see what the site actually ranks for.
 */
export function Appearances({ rows }: { rows: Appearance[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-[12px] text-[color:var(--color-text-secondary)]">
        No scrape has turned up this website yet.
      </p>
    )
  }

  // 500 rows would bury everything below it, so the list scrolls in place
  // with a stuck header instead of running down the page.
  return (
    <div className="max-h-[560px] overflow-auto rounded-md border border-[color:var(--color-border)]">
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10 bg-[color:var(--color-border-strong)]">
          <tr>
            <Th>Keyword</Th>
            <Th>Country</Th>
            <Th>Type</Th>
            <Th className="text-right">Pos</Th>
            <Th>Relevant?</Th>
            <Th>Scraped</Th>
            <Th>By</Th>
            <Th>Batch</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr
              key={r.id}
              className="border-b border-[color:var(--color-border)] last:border-b-0 hover:bg-[color:var(--color-bg-secondary)]"
            >
              <Td>
                <span className="flex items-center gap-1.5">
                  {r.is_not_relevant && (
                    <EyeOff
                      className="h-3 w-3 shrink-0 text-amber-700"
                      aria-label="Marked not relevant"
                    />
                  )}
                  <span className="font-medium text-[color:var(--color-text-primary)]">
                    {r.keyword ?? '—'}
                  </span>
                </span>
                {r.url && (
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 flex items-center gap-1 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
                    title={r.url}
                  >
                    <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                    <span className="truncate">{r.url.replace(/^https?:\/\//, '')}</span>
                  </a>
                )}
              </Td>
              <Td>{r.country_code ?? '—'}</Td>
              <Td>
                <span className="flex flex-wrap items-center gap-1">
                  <span>{r.result_type ?? '—'}</span>
                  {r.seen_on && r.seen_on !== 'desktop' && (
                    <span className="rounded-full bg-[color:var(--color-bg-secondary)] px-1.5 py-0.5 text-[9px] font-medium text-[color:var(--color-text-secondary)]">
                      {r.seen_on === 'both' ? 'desktop + mobile' : r.seen_on}
                    </span>
                  )}
                </span>
              </Td>
              <Td className="text-right tabular-nums">{r.overall_position ?? '—'}</Td>
              <Td>
                <RelevancePill relevant={r.is_relevant} reason={r.relevance_reason} />
              </Td>
              <Td className="whitespace-nowrap">{new Date(r.created_at).toLocaleDateString()}</Td>
              <Td className="max-w-[120px] truncate">{r.queued_by_display ?? '—'}</Td>
              <Td>
                {r.scrape_job_id ? (
                  <Link
                    href={`/scrape/${r.scrape_job_id}`}
                    className="underline underline-offset-2 hover:text-[color:var(--color-text-primary)]"
                  >
                    {r.batch_id ?? 'open'}
                  </Link>
                ) : (
                  (r.batch_id ?? '—')
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RelevancePill({ relevant, reason }: { relevant: boolean | null; reason: string | null }) {
  if (relevant === null) {
    return <span className="text-[color:var(--color-text-secondary)]">—</span>
  }
  return (
    <span
      className={[
        'rounded-full px-2 py-0.5 text-[10px] font-medium',
        relevant ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800',
      ].join(' ')}
      title={reason ?? undefined}
    >
      {relevant ? 'On keyword' : 'Off keyword'}
    </span>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={[
        'whitespace-nowrap border-b border-[color:var(--color-border-strong)] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-primary)]',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </th>
  )
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td
      className={[
        'px-3 py-2 align-top text-[color:var(--color-text-secondary)]',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </td>
  )
}
