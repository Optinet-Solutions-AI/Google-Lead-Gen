'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { ChevronRight, ExternalLink, Search } from 'lucide-react'
import type { StagGroup, StagLead } from '../_lib/queries'

type Filter = 'all' | 'mapped' | 'unmapped' | 'mirror'

type Props = {
  groups: StagGroup[]
  truncated: boolean
}

const PAGE_SIZE = 25

export function StagTable({ groups, truncated }: Props) {
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return groups.filter(g => {
      if (filter === 'mapped' && !g.isOnMonday) return false
      if (filter === 'unmapped' && g.isOnMonday) return false
      if (filter === 'mirror' && g.domainCount < 2) return false
      if (q) {
        const hay = [g.sTag, g.brand, ...g.domains].join(' ').toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [groups, filter, query])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const start = (currentPage - 1) * PAGE_SIZE
  const pageRows = filtered.slice(start, start + PAGE_SIZE)

  const toggle = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const counts = useMemo(
    () => ({
      all: groups.length,
      mapped: groups.filter(g => g.isOnMonday).length,
      unmapped: groups.filter(g => !g.isOnMonday).length,
      mirror: groups.filter(g => g.domainCount >= 2).length,
    }),
    [groups],
  )

  return (
    <section className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[color:var(--color-border)] px-4 py-3">
        <div className="inline-flex items-center gap-1.5">
          {(['all', 'mapped', 'unmapped', 'mirror'] as Filter[]).map(f => (
            <button
              key={f}
              type="button"
              onClick={() => {
                setFilter(f)
                setPage(1)
              }}
              className={[
                'rounded-md border px-2.5 py-1 text-[11px] font-medium capitalize transition-colors',
                filter === f
                  ? 'border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/15 text-[color:var(--color-text-primary)]'
                  : 'border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]',
              ].join(' ')}
              title={filterHint(f)}
            >
              {f === 'mirror' ? 'Mirror groups' : f} <span className="ml-1 opacity-70">({counts[f]})</span>
            </button>
          ))}
        </div>
        <label className="relative inline-flex items-center">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-[color:var(--color-text-secondary)]" />
          <input
            value={query}
            onChange={e => {
              setQuery(e.target.value)
              setPage(1)
            }}
            placeholder="Search s-tag, brand or domain…"
            className="w-[280px] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] py-1 pl-7 pr-2 text-[12px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
          />
        </label>
      </header>

      {truncated && (
        <div className="border-b border-[color:var(--color-border)] bg-amber-50 px-4 py-2 text-[11px] text-amber-900">
          Showing the most-recent 8,000 tag rows in the lookback window. Older extractions are hidden — widen or narrow the ?days= URL param to shift the window.
        </div>
      )}

      {pageRows.length === 0 ? (
        <p className="px-4 py-6 text-[12px] text-[color:var(--color-text-secondary)]">
          No S-tags match the current filter.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="bg-[color:var(--color-bg-secondary)] text-left text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              <tr>
                <th className="w-6 px-2 py-2" />
                <th className="px-3 py-2">S-tag</th>
                <th className="px-3 py-2">Param</th>
                <th className="px-3 py-2">Brand</th>
                <th className="px-3 py-2 text-right">Websites</th>
                <th className="px-3 py-2 text-right">Leads</th>
                <th className="px-3 py-2">Last seen</th>
                <th className="px-3 py-2">Monday status</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map(g => {
                const isOpen = expanded.has(g.sTag)
                return (
                  <TagRow
                    key={g.sTag}
                    group={g}
                    open={isOpen}
                    onToggle={() => toggle(g.sTag)}
                  />
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <footer className="flex items-center justify-between gap-2 border-t border-[color:var(--color-border)] px-4 py-2 text-[11px] text-[color:var(--color-text-secondary)]">
        <span>
          Showing {pageRows.length === 0 ? 0 : start + 1}–{start + pageRows.length} of {filtered.length.toLocaleString()}{' '}
          {filtered.length === 1 ? 'group' : 'groups'}
        </span>
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => setPage(currentPage - 1)}
            className="rounded border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] hover:bg-[color:var(--color-bg-secondary)] disabled:opacity-40"
          >
            Prev
          </button>
          <span className="px-1 tabular-nums">
            {currentPage} / {totalPages}
          </span>
          <button
            type="button"
            disabled={currentPage >= totalPages}
            onClick={() => setPage(currentPage + 1)}
            className="rounded border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] hover:bg-[color:var(--color-bg-secondary)] disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </footer>
    </section>
  )
}

function filterHint(f: Filter): string {
  switch (f) {
    case 'all':
      return 'Every unique S-tag in the window'
    case 'mapped':
      return 'S-tags already linked to a Monday item — known affiliates'
    case 'unmapped':
      return 'S-tags not yet on Monday — pitch opportunities'
    case 'mirror':
      return 'S-tags shared by 2+ domains — mirror-domain groups'
  }
}

function TagRow({
  group,
  open,
  onToggle,
}: {
  group: StagGroup
  open: boolean
  onToggle: () => void
}) {
  const mondayCell = group.isOnMonday ? (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800">
        ✓ On Monday
        <span className="opacity-70">({group.mondayMatchKind ?? '?'})</span>
      </span>
      {group.mondayItemIds.length > 0 && (
        <span className="text-[9px] font-mono text-[color:var(--color-text-secondary)]">
          {group.mondayItemIds.slice(0, 2).map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <a
                href={`https://roosterpartnersaffiliates.monday.com/boards/1236073873/pulses/${id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-[color:var(--color-accent-hover)]"
              >
                {id}
              </a>
            </span>
          ))}
          {group.mondayItemIds.length > 2 && ` +${group.mondayItemIds.length - 2}`}
        </span>
      )}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-bg-secondary)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-text-secondary)]">
      Not mapped
    </span>
  )

  return (
    <>
      <tr
        className={[
          'cursor-pointer border-b border-[color:var(--color-border)] transition-colors',
          open ? 'bg-[color:var(--color-bg-secondary)]' : 'hover:bg-[color:var(--color-bg-secondary)]',
        ].join(' ')}
        onClick={onToggle}
      >
        <td className="px-2 py-2 align-top">
          <ChevronRight
            className={[
              'h-3.5 w-3.5 text-[color:var(--color-text-secondary)] transition-transform',
              open ? 'rotate-90' : '',
            ].join(' ')}
          />
        </td>
        <td className="px-3 py-2 font-mono text-[11px] text-[color:var(--color-text-primary)]" title={group.sTag}>
          {truncate(group.sTag, 42)}
        </td>
        <td className="px-3 py-2 text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          {group.sourceParam ?? '—'}
        </td>
        <td className="px-3 py-2 text-[color:var(--color-text-primary)]">{group.brand ?? '—'}</td>
        <td className="px-3 py-2 text-right font-mono tabular-nums">
          {group.domainCount}
          {group.domainCount >= 2 && (
            <span
              title="Mirror group — this S-tag appears on multiple domains, indicating the same operator running duplicate sites"
              className="ml-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-900"
            >
              mirror
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-right font-mono tabular-nums">{group.leadCount}</td>
        <td className="px-3 py-2 whitespace-nowrap text-[color:var(--color-text-secondary)]">
          {fmtDateShort(group.lastSeen)}
        </td>
        <td className="px-3 py-2">{mondayCell}</td>
      </tr>
      {open && (
        <tr className="border-b border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]">
          <td colSpan={8} className="px-6 py-3">
            <ExpandedDetail group={group} />
          </td>
        </tr>
      )}
    </>
  )
}

function ExpandedDetail({ group }: { group: StagGroup }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 md:grid-cols-3">
        <DetailChip label="First seen" value={fmtDateShort(group.firstSeen)} />
        <DetailChip label="Distinct domains" value={String(group.domainCount)} />
        <DetailChip
          label="Monday item IDs"
          value={group.mondayItemIds.length === 0 ? '—' : group.mondayItemIds.length === 1 ? group.mondayItemIds[0]! : `${group.mondayItemIds.length} distinct`}
        />
      </div>
      {group.domains.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
            Domains sharing this S-tag ({group.domains.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {group.domains.map(d => (
              <span
                key={d}
                className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-0.5 font-mono text-[10px] text-[color:var(--color-text-primary)]"
              >
                {d}
              </span>
            ))}
          </div>
        </div>
      )}
      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Leads carrying this S-tag ({group.leads.length})
        </div>
        <div className="overflow-x-auto rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
          <table className="w-full border-collapse text-[11px]">
            <thead className="bg-[color:var(--color-bg-secondary)] text-left text-[9px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              <tr>
                <th className="px-3 py-1.5">Domain</th>
                <th className="px-3 py-1.5">Country</th>
                <th className="px-3 py-1.5">Extracted</th>
                <th className="px-3 py-1.5">On Monday</th>
                <th className="px-3 py-1.5">Links</th>
              </tr>
            </thead>
            <tbody>
              {group.leads.slice(0, 100).map(l => (
                <LeadRow key={l.leadId} lead={l} />
              ))}
            </tbody>
          </table>
          {group.leads.length > 100 && (
            <p className="px-3 py-1.5 text-[10px] text-[color:var(--color-text-secondary)]">
              …and {group.leads.length - 100} more. Filter above to narrow.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function LeadRow({ lead }: { lead: StagLead }) {
  return (
    <tr className="border-b border-[color:var(--color-border)] last:border-b-0">
      <td className="px-3 py-1.5 font-mono text-[10px]">{lead.domain ?? '—'}</td>
      <td className="px-3 py-1.5 text-[color:var(--color-text-secondary)]">{lead.countryCode ?? '—'}</td>
      <td className="px-3 py-1.5 whitespace-nowrap text-[color:var(--color-text-secondary)]">{fmtDateShort(lead.createdAt)}</td>
      <td className="px-3 py-1.5">
        {lead.isOnMonday ? (
          <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-800" title={lead.mondayBoard ?? undefined}>
            {lead.mondayBoard ?? 'yes'}
          </span>
        ) : (
          <span className="text-[9px] text-[color:var(--color-text-secondary)]">—</span>
        )}
      </td>
      <td className="px-3 py-1.5">
        <span className="inline-flex items-center gap-2">
          {lead.url && (
            <a
              href={lead.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 text-[10px] text-[color:var(--color-accent-hover)] hover:underline"
              onClick={e => e.stopPropagation()}
            >
              site <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {lead.scrapeJobId && (
            <Link
              href={`/scrape/${lead.scrapeJobId}`}
              className="text-[10px] text-[color:var(--color-accent-hover)] hover:underline"
              onClick={e => e.stopPropagation()}
            >
              job
            </Link>
          )}
        </span>
      </td>
    </tr>
  )
}

function DetailChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-1.5">
      <div className="text-[9px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
        {label}
      </div>
      <div className="mt-0.5 text-[12px] font-mono text-[color:var(--color-text-primary)]">{value}</div>
    </div>
  )
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

function fmtDateShort(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: '2-digit',
    })
  } catch {
    return iso
  }
}
