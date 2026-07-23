import Link from 'next/link'
import { DATE_RANGE_OPTIONS, type DateRangeKey } from '../../_lib/date-range'

/**
 * Segmented chip strip for picking a dashboard's date window. Every
 * dashboard renders this in its header and reads the selection back
 * via the `?range=` URL param — server component, no client state
 * needed (each chip is a Link).
 *
 * `basePath` is the current dashboard's route so the chips land back
 * on the same page with only ?range changed. Any other query params
 * are preserved via `preserveParams`.
 */
export function DateRangeToggle({
  basePath,
  active,
  preserveParams,
}: {
  basePath: string
  active: DateRangeKey
  preserveParams?: URLSearchParams
}) {
  return (
    <nav className="inline-flex items-center gap-0.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-0.5 text-[11px]">
      {DATE_RANGE_OPTIONS.map(opt => {
        const params = new URLSearchParams(preserveParams ?? undefined)
        // 'today' is the default — leave off the URL for a clean landing link
        if (opt.key === 'today') params.delete('range')
        else params.set('range', opt.key)
        const qs = params.toString()
        const href = qs ? `${basePath}?${qs}` : basePath
        const isActive = active === opt.key
        return (
          <Link
            key={opt.key}
            href={href}
            className={[
              'rounded-sm px-2 py-1 font-medium transition-colors',
              isActive
                ? 'bg-[color:var(--color-accent)]/15 text-[color:var(--color-text-primary)]'
                : 'text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)]',
            ].join(' ')}
          >
            {opt.label}
          </Link>
        )
      })}
    </nav>
  )
}
