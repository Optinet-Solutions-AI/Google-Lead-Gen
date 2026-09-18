/**
 * Recency bands for "last seen on a scrape" / "last updated" colouring.
 * Band widths come from the `recency_bands_days` system setting so the
 * admin can tune them; the defaults here match the migration seed.
 */

export type RecencyBands = { fresh: number; recent: number; aging: number }

export const DEFAULT_RECENCY_BANDS: RecencyBands = { fresh: 7, recent: 30, aging: 90 }

export type RecencyBand = 'fresh' | 'recent' | 'aging' | 'stale' | 'never'

export function parseRecencyBands(raw: unknown): RecencyBands {
  if (!raw || typeof raw !== 'object') return DEFAULT_RECENCY_BANDS
  const o = raw as Record<string, unknown>
  const num = (v: unknown, d: number) => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d
  }
  return {
    fresh: num(o.fresh, DEFAULT_RECENCY_BANDS.fresh),
    recent: num(o.recent, DEFAULT_RECENCY_BANDS.recent),
    aging: num(o.aging, DEFAULT_RECENCY_BANDS.aging),
  }
}

/** Whole days between an ISO instant and `nowMs`. */
export function daysSince(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000))
}

export function recencyBand(iso: string | null | undefined, bands: RecencyBands, nowMs: number): RecencyBand {
  const d = daysSince(iso, nowMs)
  if (d === null) return 'never'
  if (d <= bands.fresh) return 'fresh'
  if (d <= bands.recent) return 'recent'
  if (d <= bands.aging) return 'aging'
  return 'stale'
}

export const RECENCY_LABEL: Record<RecencyBand, string> = {
  fresh: 'Seen this week',
  recent: 'Seen this month',
  aging: 'Seen this quarter',
  stale: 'Not seen for a while',
  never: 'Never seen on a scrape',
}

/** Tailwind classes for a small dot / pill per band. */
export const RECENCY_DOT: Record<RecencyBand, string> = {
  fresh: 'bg-emerald-500',
  recent: 'bg-lime-500',
  aging: 'bg-amber-500',
  stale: 'bg-rose-400',
  never: 'bg-slate-300',
}

export const RECENCY_PILL: Record<RecencyBand, string> = {
  fresh: 'bg-emerald-100 text-emerald-800',
  recent: 'bg-lime-100 text-lime-800',
  aging: 'bg-amber-100 text-amber-900',
  stale: 'bg-rose-100 text-rose-800',
  never: 'bg-slate-100 text-slate-600',
}

export function formatDaysAgo(days: number | null): string {
  if (days === null) return 'never'
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  if (days < 365) return `${Math.floor(days / 30)} mo ago`
  return `${Math.floor(days / 365)} yr ago`
}
