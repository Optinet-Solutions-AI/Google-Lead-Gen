/**
 * Placeholder shown while a page's server render is in flight.
 *
 * Every dashboard page is `force-dynamic`, so each navigation waits on a
 * round trip to Vercel plus a handful to Supabase. Without a loading
 * boundary Next blocks the transition entirely: the old page stays frozen
 * and nothing indicates the click registered. A `loading.tsx` turns that
 * into an instant paint, and lets Link prefetch pull this shell ahead of
 * time.
 *
 * Deliberately plain — it should suggest the shape of what is coming, not
 * imitate it so closely that the swap looks like a glitch.
 */

function Bar({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-[color:var(--color-bg-secondary)] ${className}`} />
}

export function PageSkeleton({
  /** Rows of the list/table placeholder. */
  rows = 6,
  /** Show a strip of summary tiles above the list. */
  stats = 0,
  /** Show a filter/controls bar. */
  controls = true,
}: {
  rows?: number
  stats?: number
  controls?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4 px-4 py-4 md:px-6 md:py-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="flex items-center justify-between gap-3">
        <Bar className="h-5 w-44" />
        <Bar className="h-9 w-28" />
      </div>

      {stats > 0 && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: stats }).map((_, i) => (
            <Bar key={i} className="h-14" />
          ))}
        </div>
      )}

      {controls && (
        <div className="flex flex-wrap gap-2">
          <Bar className="h-8 w-24" />
          <Bar className="h-8 w-28" />
          <Bar className="h-8 w-20" />
        </div>
      )}

      <div className="flex flex-col gap-2">
        {Array.from({ length: rows }).map((_, i) => (
          <Bar key={i} className="h-14" />
        ))}
      </div>
    </div>
  )
}

/** Form-shaped placeholder, for the new-scrape page. */
export function FormSkeleton() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-4 md:px-6 md:py-5 lg:max-w-none lg:px-8" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="flex items-center justify-between gap-3">
        <Bar className="h-5 w-40" />
        <Bar className="h-8 w-32" />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Bar className="h-[26rem]" />
        <Bar className="h-[26rem]" />
      </div>
    </div>
  )
}
