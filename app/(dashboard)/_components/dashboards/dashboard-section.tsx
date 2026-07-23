import { HelpCircle } from 'lucide-react'

/**
 * Standard "titled panel" every dashboard section lives inside.
 * Consistent frame → operators build muscle memory of where things
 * are. Optional right-slot for per-section controls (e.g. "sort by
 * volume ▾" or a mini-tab strip).
 */
export function DashboardSection({
  title,
  hint,
  right,
  children,
  className = '',
}: {
  title: string
  hint?: string
  right?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section
      className={[
        'flex flex-col gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-4',
        className,
      ].join(' ')}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold text-[color:var(--color-text-primary)]">
            {title}
            {hint && (
              <span
                className="inline-flex text-[color:var(--color-text-secondary)]"
                title={hint}
                aria-label={hint}
              >
                <HelpCircle className="h-3 w-3" />
              </span>
            )}
          </h2>
        </div>
        {right}
      </header>
      {children}
    </section>
  )
}

/**
 * "Coming in Phase N" placeholder — used across the four dashboards
 * in Phase 1 so operators see the layout even before every section
 * is populated. Keeps the visual footprint of each dashboard stable
 * as we ship the later phases.
 */
export function PlaceholderPanel({
  title,
  phase,
  note,
}: {
  title: string
  phase: number
  note?: string
}) {
  return (
    <DashboardSection title={title}>
      <div className="flex flex-col items-center gap-1 rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-4 py-8 text-center">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Coming in Phase {phase}
        </span>
        {note && (
          <p className="max-w-md text-[11px] text-[color:var(--color-text-secondary)]">
            {note}
          </p>
        )}
      </div>
    </DashboardSection>
  )
}
