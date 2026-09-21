'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { Loader2, RotateCcw, Search, SlidersHorizontal } from 'lucide-react'
import { Modal } from '../../_components/modal'
import { Flag } from '../../_components/flag'
import { SourceIcon } from '../../_components/source-icon'

/**
 * Advanced search — a self-contained lookup with its OWN filters.
 *
 * It deliberately ignores the list's day and owner scope. Searching inside
 * whatever the page happens to be showing meant a query was silently
 * narrowed by filters you were not thinking about; here the only things that
 * apply are the ones in this panel.
 *
 * Matching is fuzzy and ranked server-side (search_scrape_jobs), so a
 * partial name or a typo still finds the batch, and each result says why it
 * matched.
 */

export type SearchFacets = {
  countries: Array<{ code: string; name: string | null }>
  engines: string[]
  statuses: string[]
  sources: string[]
  owners: Array<{ email: string; label: string }>
}

type Hit = {
  id: string
  keyword: string | null
  country_code: string | null
  search_engine: string | null
  status: string | null
  batch_id: number | null
  created_at: string
  created_by_display: string | null
  matchScore: number
  matchReasons: string[]
}

type Criteria = {
  query: string
  countries: string[]
  engines: string[]
  statuses: string[]
  sources: string[]
  owners: string[]
  from: string
  to: string
  enrichment: string
}

const EMPTY: Criteria = {
  query: '', countries: [], engines: [], statuses: [], sources: [], owners: [],
  from: '', to: '', enrichment: '',
}

export function AdvancedSearch({ facets }: { facets: SearchFacets }) {
  const [open, setOpen] = useState(false)
  const [c, setC] = useState<Criteria>(EMPTY)
  const [rows, setRows] = useState<Hit[] | null>(null)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reqId = useRef(0)

  const activeFilters =
    c.countries.length + c.engines.length + c.statuses.length + c.sources.length + c.owners.length +
    (c.from ? 1 : 0) + (c.to ? 1 : 0) + (c.enrichment ? 1 : 0)

  async function run(criteria: Criteria) {
    const mine = ++reqId.current
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/jobs/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...criteria, limit: 100 }),
        cache: 'no-store',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { rows: Hit[]; total: number }
      // Ignore a response that a newer search has already superseded.
      if (mine !== reqId.current) return
      setRows(body.rows ?? [])
      setTotal(body.total ?? 0)
    } catch (e) {
      if (mine === reqId.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (mine === reqId.current) setLoading(false)
    }
  }

  // Debounced live search — typing shows progress rather than freezing.
  useEffect(() => {
    if (!open) return
    if (!c.query.trim() && activeFilters === 0) { setRows(null); setTotal(0); return }
    const id = setTimeout(() => { void run(c) }, 300)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, c])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-3 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
      >
        <Search className="h-3.5 w-3.5" />
        Advanced search
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title="Advanced search" width="min(96rem, 95vw)">
        <div className="flex flex-col gap-3">
          {/* Query */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--color-text-secondary)]" />
            {loading && (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[color:var(--color-text-secondary)]" />
            )}
            <input
              autoFocus
              value={c.query}
              onChange={e => setC({ ...c, query: e.target.value })}
              placeholder="A keyword, a website (partial or misspelled), a person, a batch number…"
              className="w-full rounded-lg border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-primary)] py-2.5 pl-10 pr-10 text-[14px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-accent)]"
            />
          </div>
          <p className="-mt-1 text-[11px] text-[color:var(--color-text-secondary)]">
            Searches keywords (and their English translations), countries, engines, owners, batch numbers and the
            websites each batch found. Near matches are included. These filters are the only ones that apply — the
            list&rsquo;s day and owner scope is ignored.
          </p>

          {/* Filters */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            <Multi label="Country" options={facets.countries.map(x => ({ value: x.code, label: x.name ?? x.code }))}
                   selected={c.countries} onChange={v => setC({ ...c, countries: v })} flags />
            <Multi label="Source" options={facets.engines.map(e => ({ value: e, label: e }))}
                   selected={c.engines} onChange={v => setC({ ...c, engines: v })} icons />
            <Multi label="Status" options={facets.statuses.map(s => ({ value: s, label: s }))}
                   selected={c.statuses} onChange={v => setC({ ...c, statuses: v })} />
            <Multi label="Run by" options={facets.owners.map(o => ({ value: o.email, label: o.label }))}
                   selected={c.owners} onChange={v => setC({ ...c, owners: v })} />
            <Multi label="Ran on" options={facets.sources.map(s => ({ value: s, label: s }))}
                   selected={c.sources} onChange={v => setC({ ...c, sources: v })} />
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">Enrichment</span>
              <select
                value={c.enrichment}
                onChange={e => setC({ ...c, enrichment: e.target.value })}
                className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1.5 text-[12.5px] text-[color:var(--color-text-primary)]"
              >
                <option value="">Any</option>
                <option value="yes">With enrichment</option>
                <option value="no">Without</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">From</span>
              <input type="date" value={c.from} onChange={e => setC({ ...c, from: e.target.value })}
                     className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1.5 text-[12.5px] text-[color:var(--color-text-primary)]" />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">To</span>
              <input type="date" value={c.to} onChange={e => setC({ ...c, to: e.target.value })}
                     className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1.5 text-[12.5px] text-[color:var(--color-text-primary)]" />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[color:var(--color-border)] pt-3">
            <span className="inline-flex items-center gap-2 text-[12px] text-[color:var(--color-text-secondary)]">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {activeFilters === 0 ? 'No filters' : `${activeFilters} filter${activeFilters === 1 ? '' : 's'}`}
              {loading && <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> searching…</span>}
            </span>
            <button
              type="button"
              onClick={() => { setC(EMPTY); setRows(null); setTotal(0) }}
              className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] px-2.5 py-1 text-[12px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Reset
            </button>
          </div>

          {/* Results */}
          <Results rows={rows} total={total} loading={loading} error={error} />
        </div>
      </Modal>
    </>
  )
}

function Results({
  rows, total, loading, error,
}: { rows: Hit[] | null; total: number; loading: boolean; error: string | null }) {
  if (error) {
    return <p className="rounded-md bg-red-50 px-3 py-2 text-[12px] text-red-700">Search failed: {error}</p>
  }
  if (rows === null) {
    return (
      <p className="py-6 text-center text-[12.5px] text-[color:var(--color-text-secondary)]">
        Type something, or pick a filter.
      </p>
    )
  }
  if (loading && rows.length === 0) {
    return (
      <div className="flex flex-col gap-2 py-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded bg-[color:var(--color-bg-secondary)]" />
        ))}
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-[12.5px] text-[color:var(--color-text-secondary)]">
        Nothing matched. Near matches are already included, so try fewer words or drop a filter.
      </p>
    )
  }

  return (
    <div className={loading ? 'opacity-60 transition-opacity' : ''}>
      <p className="mb-1.5 text-[11.5px] text-[color:var(--color-text-secondary)]">
        {total.toLocaleString()} match{total === 1 ? '' : 'es'}
        {rows.length < total && ` · showing the ${rows.length} best`}
      </p>
      <ul className="divide-y divide-[color:var(--color-border)] rounded-md border border-[color:var(--color-border)]">
        {rows.map(r => (
          <li key={r.id}>
            <Link
              href={`/scrape/${r.id}`}
              className="flex flex-col gap-1 px-3 py-2 hover:bg-[color:var(--color-bg-secondary)] sm:flex-row sm:items-center sm:gap-3"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <Flag code={r.country_code} />
                <SourceIcon engine={r.search_engine} className="h-3.5 w-3.5" />
                <span className="truncate text-[13px] font-medium text-[color:var(--color-text-primary)]">
                  {r.keyword || '(no keyword)'}
                </span>
              </span>
              <span className="flex shrink-0 flex-wrap items-center gap-2 text-[11px] text-[color:var(--color-text-secondary)]">
                {r.matchReasons.length > 0 && (
                  <span className="rounded-full bg-[color:var(--color-bg-secondary)] px-2 py-0.5">
                    {r.matchReasons.join(' · ')}
                  </span>
                )}
                <span>{r.status}</span>
                {r.batch_id != null && <span>#{r.batch_id}</span>}
                <span>{new Date(r.created_at).toLocaleDateString()}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Compact multi-select rendered as toggle chips. */
function Multi({
  label, options, selected, onChange, flags, icons,
}: {
  label: string
  options: Array<{ value: string; label: string }>
  selected: string[]
  onChange: (v: string[]) => void
  flags?: boolean
  icons?: boolean
}) {
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v])
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--color-text-secondary)]">
        {label}
      </span>
      <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto rounded-md border border-[color:var(--color-border)] p-1.5">
        {options.map(o => {
          const on = selected.includes(o.value)
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => toggle(o.value)}
              className={[
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] transition-colors',
                on
                  ? 'bg-[color:var(--color-accent)] text-[color:var(--color-text-primary)]'
                  : 'bg-[color:var(--color-bg-secondary)] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]',
              ].join(' ')}
            >
              {flags && <Flag code={o.value} className="h-2.5 w-4" />}
              {icons && <SourceIcon engine={o.value} className="h-3 w-3" tinted={false} />}
              <span className="max-w-[8rem] truncate">{o.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
