/**
 * Shared page-size parser for paginated tables (/leads, /scrape,
 * /scrape/[id], /monday/*, /activity).
 *
 * Two valid shapes:
 *   - `0` is the "All rows" sentinel — the server-side query helpers
 *     substitute their per-table soft cap (e.g. LEAD_ROWS_ALL_CAP).
 *   - Any integer between 1 and {@link MAX_PAGE_SIZE} is honoured
 *     directly, so operators can pick a custom count like "show 34"
 *     from the pagination UI's custom input.
 *
 * Anything else (non-numeric, negative, over the cap) falls back to
 * the provided default — this keeps `?size=garbage` from crashing the
 * page while still being lenient about user-typed values.
 */
export const MAX_PAGE_SIZE = 10_000

export function clampPageSize(
  raw: string | string[] | undefined,
  fallback: number,
): number {
  if (typeof raw !== 'string') return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  if (n === 0) return 0
  if (n < 1 || n > MAX_PAGE_SIZE) return fallback
  return n
}
