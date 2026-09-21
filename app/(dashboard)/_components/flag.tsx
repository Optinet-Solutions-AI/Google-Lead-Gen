'use client'

import * as Flags from 'country-flag-icons/react/3x2'

/**
 * Country flag as an inline SVG.
 *
 * Replaces the regional-indicator emoji we used before. Windows does not ship
 * flag glyphs, so Chrome and Edge on Windows render those as the bare letter
 * pair ("NO") — which is most of this team. These are real SVGs, bundled, no
 * network call, and they look the same on every OS.
 *
 * Falls back to the country code when a code has no flag (or is not a
 * country at all), so nothing ever renders blank.
 */
export function Flag({
  code,
  className = 'h-3.5 w-5',
  title,
}: {
  code: string | null | undefined
  className?: string
  title?: string
}) {
  const cc = (code ?? '').trim().toUpperCase()
  const Svg = cc.length === 2 ? (Flags as Record<string, React.ComponentType<{ className?: string; title?: string }> | undefined>)[cc] : undefined

  if (!Svg) {
    return (
      <span
        title={title ?? cc}
        className="inline-block rounded-[2px] bg-[color:var(--color-bg-secondary)] px-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]"
      >
        {cc || '—'}
      </span>
    )
  }
  return <Svg className={`inline-block shrink-0 rounded-[2px] ${className}`} title={title ?? cc} />
}

/** Flag plus the country code, the pairing used in list rows. */
export function FlagLabel({
  code,
  className,
}: {
  code: string | null | undefined
  className?: string
}) {
  const cc = (code ?? '').trim().toUpperCase()
  return (
    <span className={['inline-flex items-center gap-1.5', className ?? ''].join(' ')}>
      <Flag code={cc} />
      <span className="tabular-nums">{cc || '—'}</span>
    </span>
  )
}
