'use client'

/** Panel shown when an enqueue was blocked because one or more keywords
 *  already completed before. Lists each with its last run date + who, and
 *  lets the operator override and run anyway. Shared by the scrape wizard. */
export function DuplicateWarning({
  duplicates,
  freshCount,
  pending,
  onRunAnyway,
}: {
  duplicates: Array<{
    keyword: string
    country_code: string
    search_engine: string
    lastCompletedAt: string
    lastBy: string | null
    completedCount: number
  }>
  freshCount: number
  pending: boolean
  onRunAnyway: () => void
}) {
  const fmt = (iso: string) => {
    if (!iso) return 'unknown date'
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return iso
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  }
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12px] text-amber-900">
      <p className="font-semibold">
        {duplicates.length} of these {duplicates.length === 1 ? 'keyword has' : 'keywords have'} already
        been scraped before — nothing was queued.
      </p>
      <p className="mt-0.5 text-[11px] text-amber-800">
        Re-running produces duplicate work (this is the fix for the repeated-scrape problem). Check the
        last run date below and only run again if you actually need fresh SERP data.
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {duplicates.slice(0, 12).map((d, i) => (
          <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-sm bg-white/60 px-2 py-1">
            <span className="min-w-0 truncate font-medium">
              &ldquo;{d.keyword}&rdquo;
              <span className="ml-1 font-normal text-amber-700">
                {d.country_code} · {d.search_engine}
              </span>
            </span>
            <span className="text-[11px] text-amber-800">
              last completed {fmt(d.lastCompletedAt)}
              {d.lastBy ? ` by ${d.lastBy}` : ''}
              {d.completedCount > 1 ? ` · ${d.completedCount}× total` : ''}
            </span>
          </li>
        ))}
        {duplicates.length > 12 && (
          <li className="px-2 text-[11px] text-amber-700">…and {duplicates.length - 12} more</li>
        )}
      </ul>
      <div className="mt-2.5 flex items-center gap-3">
        <button
          type="button"
          onClick={onRunAnyway}
          disabled={pending}
          className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-[12px] font-medium text-amber-900 transition-colors hover:bg-amber-100 disabled:opacity-50"
        >
          {pending
            ? 'Running…'
            : freshCount > 0
              ? `Run anyway (all ${duplicates.length + freshCount})`
              : `Run anyway (${duplicates.length})`}
        </button>
        {freshCount > 0 && (
          <span className="text-[11px] text-amber-800">
            {freshCount} new keyword{freshCount === 1 ? '' : 's'} in this batch {freshCount === 1 ? 'is' : 'are'} not
            a duplicate and will run too.
          </span>
        )}
      </div>
    </div>
  )
}
