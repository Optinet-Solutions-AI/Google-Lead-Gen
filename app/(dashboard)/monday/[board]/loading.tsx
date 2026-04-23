import { TableNav } from '../_components/table-nav'

/**
 * Shown automatically by Next.js while a new /monday/[board] or
 * /monday/[board]/updates route is streaming.
 *
 * Includes the live TableNav so the selected pill updates immediately
 * based on the URL — makes the transition feel continuous instead
 * of dropping to a blank screen.
 */
export default function Loading() {
  return (
    <section className="flex min-w-0 flex-col">
      {/* Page header skeleton */}
      <header className="mb-3">
        <div className="h-5 w-36 animate-pulse rounded bg-[color:var(--color-border-strong)]" />
        <div className="mt-1.5 h-3 w-20 animate-pulse rounded bg-[color:var(--color-border)]" />
      </header>

      {/* Live board nav — reflects the NEW pathname already */}
      <div className="mb-3">
        <TableNav />
      </div>

      {/* Items | Updates tabs skeleton */}
      <div className="flex gap-6 border-b border-[color:var(--color-border)] pb-2">
        <div className="h-4 w-12 animate-pulse rounded bg-[color:var(--color-border-strong)]" />
        <div className="h-4 w-16 animate-pulse rounded bg-[color:var(--color-border)]" />
      </div>

      {/* Search bar skeleton */}
      <div className="py-3">
        <div className="h-8 w-full max-w-sm animate-pulse rounded-md bg-[color:var(--color-border)]" />
      </div>

      {/* Table skeleton — 10 rows to match the default page size */}
      <div className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)]">
        <div className="h-8 border-b border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)]" />
        {Array.from({ length: 10 }).map((_, i) => (
          <SkeletonRow key={i} />
        ))}
      </div>
    </section>
  )
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 border-b border-[color:var(--color-border)] px-3 py-2.5 last:border-b-0">
      <div className="h-2.5 w-28 animate-pulse rounded bg-[color:var(--color-border-strong)]" />
      <div className="h-2.5 w-16 animate-pulse rounded bg-[color:var(--color-border)]" />
      <div className="h-2.5 w-40 animate-pulse rounded bg-[color:var(--color-border)]" />
      <div className="h-2.5 w-32 animate-pulse rounded bg-[color:var(--color-border)]" />
      <div className="h-2.5 w-24 animate-pulse rounded bg-[color:var(--color-border)]" />
    </div>
  )
}
