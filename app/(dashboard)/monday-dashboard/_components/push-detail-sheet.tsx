'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { X, Download, ExternalLink, Loader2 } from 'lucide-react'

/**
 * Right-anchored slide-in that lists the leads pushed to Monday in
 * the current window (or narrowed to a country / pusher / single day
 * when the operator clicked a specific bucket on the dashboard).
 *
 * URL-driven so links from the page (StatCard, leaderboard rows) work
 * with plain <Link> — no context / provider plumbing needed:
 *   ?push_detail=1                         open the sheet
 *   &push_country=DE                       narrow to a country
 *   &push_pusher=Christian%20Albea         narrow to a pusher
 *   &push_day=2026-07-24                   narrow to a specific day
 *
 * Data is fetched lazily on open — the dashboard's initial render
 * only carries summary counts, so this doesn't bloat the RSC payload.
 */

type Row = {
  lead_id: number
  url: string | null
  domain: string | null
  keyword: string | null
  country_code: string | null
  brand: string | null
  result_type: string | null
  scraped_at: string | null
  scraped_by: string | null
  pushed_at: string
  pushed_by: string | null
  monday_pushed_item_id: string | null
}

export function PushDetailSheet({ range }: { range: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()

  const open = sp.get('push_detail') === '1'
  const country = sp.get('push_country') ?? ''
  const pusher = sp.get('push_pusher') ?? ''
  const day = sp.get('push_day') ?? ''
  const allTime = sp.get('push_all') === '1'

  const [rows, setRows] = useState<Row[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = useCallback(() => {
    const params = new URLSearchParams(sp.toString())
    for (const k of ['push_detail', 'push_country', 'push_pusher', 'push_day', 'push_all']) {
      params.delete(k)
    }
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [sp, pathname, router])

  // Esc + body-scroll lock
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    const originalOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = originalOverflow
    }
  }, [open, close])

  // Fetch when opened OR when the filter narrowing changes. React
  // 19's react-hooks/set-state-in-effect flags the pre-fetch setLoading
  // / setError calls, but the intended fix (SWR / useSyncExternalStore)
  // is heavier than the primitive itself for a one-endpoint sheet.
  // The pattern is: kick off a fetch, show a spinner while it's in
  // flight, replace state on completion — this is exactly what the
  // rule's escape hatch is for.
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see block comment
    setLoading(true)
     
    setError(null)
    const qs = new URLSearchParams({ range })
    if (country) qs.set('country', country)
    if (pusher) qs.set('pusher', pusher)
    if (day) qs.set('day', day)
    if (allTime) qs.set('all', '1')
    fetch(`/api/monday-dashboard/push-details?${qs.toString()}`, { signal: controller.signal })
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(body => setRows((body?.rows ?? []) as Row[]))
      .catch(err => {
        if (err.name !== 'AbortError') setError(String(err.message ?? err))
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [open, range, country, pusher, day, allTime])

  const exportUrl = useMemo(() => {
    const qs = new URLSearchParams({ range })
    if (country) qs.set('country', country)
    if (pusher) qs.set('pusher', pusher)
    if (day) qs.set('day', day)
    if (allTime) qs.set('all', '1')
    return `/api/monday-dashboard/push-export?${qs.toString()}`
  }, [range, country, pusher, day, allTime])

  const filterBadges = [
    allTime && { label: 'Window', value: 'All time', param: 'push_all' },
    country && { label: 'Country', value: country, param: 'push_country' },
    pusher && { label: 'Pusher', value: pusher, param: 'push_pusher' },
    day && { label: 'Day', value: day, param: 'push_day' },
  ].filter(Boolean) as Array<{ label: string; value: string; param: string }>

  const clearFilter = (param: string) => {
    const params = new URLSearchParams(sp.toString())
    params.delete(param)
    router.push(`${pathname}?${params.toString()}`, { scroll: false })
  }

  return (
    <>
      {/* Backdrop */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={close}
        className={[
          'fixed inset-0 z-40 bg-black/30 transition-opacity duration-200',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        ].join(' ')}
      />

      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Leads pushed to Monday"
        className={[
          'fixed inset-y-0 right-0 z-50 flex w-full max-w-[720px] flex-col bg-[color:var(--color-bg-primary)] shadow-2xl transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : 'translate-x-full',
        ].join(' ')}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[color:var(--color-border)] px-5 py-4">
          <div>
            <h2 className="text-[14px] font-semibold text-[color:var(--color-text-primary)]">
              Leads pushed to Monday
            </h2>
            <p className="mt-0.5 text-[11px] text-[color:var(--color-text-secondary)]">
              Every push in the current window, newest first. Click a lead URL to open it in a new tab.
            </p>
            {filterBadges.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {filterBadges.map(b => (
                  <button
                    key={b.param}
                    type="button"
                    onClick={() => clearFilter(b.param)}
                    className="group inline-flex items-center gap-1 rounded-full border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-secondary)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)] hover:brightness-95"
                    title={`Remove ${b.label} filter`}
                  >
                    <span>{b.label}: <span className="normal-case text-[color:var(--color-text-primary)]">{b.value}</span></span>
                    <X className="h-3 w-3 opacity-60 group-hover:opacity-100" />
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <a
              href={exportUrl}
              className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border-strong)] bg-[color:var(--color-bg-secondary)] px-2.5 py-1.5 text-[11px] font-medium text-[color:var(--color-text-primary)] hover:brightness-95"
              title="Download CSV of these rows"
              download
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </a>
            <button
              type="button"
              onClick={close}
              className="rounded-md p-1.5 text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-16 text-[12px] text-[color:var(--color-text-secondary)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading pushes…
            </div>
          )}
          {error && (
            <div className="mx-5 mt-5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
              Couldn&apos;t load the pushes: {error}
            </div>
          )}
          {!loading && !error && rows !== null && rows.length === 0 && (
            <div className="py-16 text-center text-[12px] text-[color:var(--color-text-secondary)]">
              No pushes match the current filters.
            </div>
          )}
          {!loading && !error && rows !== null && rows.length > 0 && (
            <>
              <div className="border-b border-[color:var(--color-border)] px-5 py-2 text-[11px] text-[color:var(--color-text-secondary)]">
                Showing {rows.length.toLocaleString()} pushes
              </div>
              <table className="w-full border-collapse text-[12px]">
                <thead className="sticky top-0 z-10 bg-[color:var(--color-bg-primary)]">
                  <tr className="border-b border-[color:var(--color-border)] text-left text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                    <th className="px-5 py-2">Lead</th>
                    <th className="py-2">Scraped</th>
                    <th className="py-2">Pushed</th>
                    <th className="px-5 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr
                      key={r.lead_id}
                      className="border-b border-[color:var(--color-border)]/60 align-top hover:bg-[color:var(--color-bg-secondary)]/60"
                    >
                      <td className="px-5 py-2">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1">
                            {r.url ? (
                              <a
                                href={r.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="max-w-[360px] truncate text-[color:var(--color-text-primary)] hover:text-[color:var(--color-accent)] hover:underline"
                                title={r.url}
                              >
                                {r.domain ?? r.url}
                              </a>
                            ) : (
                              <span className="text-[color:var(--color-text-secondary)]">(no url)</span>
                            )}
                            <ExternalLink className="h-3 w-3 shrink-0 text-[color:var(--color-text-secondary)]" />
                          </div>
                          <div className="flex flex-wrap items-center gap-x-2 text-[10px] text-[color:var(--color-text-secondary)]">
                            {r.country_code && (
                              <span className="rounded-sm bg-[color:var(--color-bg-secondary)] px-1 font-medium">{r.country_code}</span>
                            )}
                            {r.result_type && <span>{r.result_type}</span>}
                            {r.brand && <span>brand: <span className="text-[color:var(--color-text-primary)]">{r.brand}</span></span>}
                          </div>
                          {r.keyword && (
                            <div className="max-w-[360px] truncate text-[10px] text-[color:var(--color-text-secondary)]">
                              &ldquo;{r.keyword}&rdquo;
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="py-2 text-[11px] text-[color:var(--color-text-secondary)]">
                        <div>{formatDate(r.scraped_at)}</div>
                        <div className="text-[color:var(--color-text-primary)]">{r.scraped_by ?? '—'}</div>
                      </td>
                      <td className="py-2 text-[11px] text-[color:var(--color-text-secondary)]">
                        <div>{formatDate(r.pushed_at)}</div>
                        <div className="text-[color:var(--color-text-primary)]">{r.pushed_by ?? '—'}</div>
                      </td>
                      <td className="px-5 py-2 text-right">
                        <Link
                          href={`/leads?item=${r.lead_id}`}
                          className="text-[11px] text-[color:var(--color-accent)] hover:underline"
                          title="Open lead detail"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </aside>
    </>
  )
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
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
