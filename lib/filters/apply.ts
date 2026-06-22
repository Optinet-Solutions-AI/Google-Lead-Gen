import 'server-only'
import type { ColumnDef, Filter, Sort } from './types'

type AnyQuery = {
  eq: (col: string, v: unknown) => AnyQuery
  neq: (col: string, v: unknown) => AnyQuery
  gt: (col: string, v: unknown) => AnyQuery
  gte: (col: string, v: unknown) => AnyQuery
  lt: (col: string, v: unknown) => AnyQuery
  lte: (col: string, v: unknown) => AnyQuery
  ilike: (col: string, v: string) => AnyQuery
  not: (col: string, op: string, v: unknown) => AnyQuery
  is: (col: string, v: null | boolean) => AnyQuery
  in: (col: string, v: unknown[]) => AnyQuery
  or: (filter: string) => AnyQuery
  order: (col: string, opts: { ascending: boolean; nullsFirst?: boolean }) => AnyQuery
}

/**
 * Mutates the query builder by chaining `.eq()`, `.ilike()`, etc. for each
 * filter. Skips filters whose column isn't in the registry, prevents column
 * injection by only allowing whitelisted column names.
 */
export function applyFilters<Q extends AnyQuery>(
  query: Q,
  filters: Filter[],
  registry: ReadonlyArray<ColumnDef>,
): Q {
  const byKey = new Map(registry.map(c => [c.key, c]))
  let q: AnyQuery = query
  for (const f of filters) {
    const def = byKey.get(f.col)
    if (!def || !def.filterable) continue
    q = applyOne(q, f, def)
  }
  return q as Q
}

function applyOne(q: AnyQuery, f: Filter, def: ColumnDef): AnyQuery {
  const v = f.v ?? ''
  // Sanitize ILIKE inputs — strip % and _ so user input is treated literally.
  const safe = (s: string) => s.replace(/[%_\\]/g, m => '\\' + m)

  // Date columns store timestamps with second-level precision, so a
  // naive `=` against a datetime-local string ('2026-06-16T00:00')
  // almost never matches. Pre-compute the day-bounded range once so
  // every date branch can use it.
  const dayBounds = def.type === 'date' && v !== '' ? toDayBounds(v) : null

  switch (f.op) {
    case 'contains':
      return v ? q.ilike(def.key, `%${safe(v)}%`) : q
    case 'notcontains':
      return v ? q.not(def.key, 'ilike', `%${safe(v)}%`) : q
    case 'startswith':
      return v ? q.ilike(def.key, `${safe(v)}%`) : q
    case 'is':
      return v === '' ? q : q.eq(def.key, coerce(v, def))
    case 'isnot':
      return v === '' ? q : q.neq(def.key, coerce(v, def))
    case 'eq':
      if (def.type === 'date') {
        return dayBounds
          ? q.gte(def.key, dayBounds.start).lt(def.key, dayBounds.end)
          : q
      }
      return v === '' ? q : q.eq(def.key, coerce(v, def))
    case 'neq':
      if (def.type === 'date') {
        return dayBounds
          ? q.or(`${def.key}.lt.${dayBounds.start},${def.key}.gte.${dayBounds.end}`)
          : q
      }
      return v === '' ? q : q.neq(def.key, coerce(v, def))
    case 'gt':
      return v === '' ? q : q.gt(def.key, coerce(v, def))
    case 'gte':
      return v === '' ? q : q.gte(def.key, coerce(v, def))
    case 'lt':
      return v === '' ? q : q.lt(def.key, coerce(v, def))
    case 'lte':
      return v === '' ? q : q.lte(def.key, coerce(v, def))
    case 'before':
      // "is before 16/06" → rows whose timestamp falls on any earlier
      // calendar day. Strip the time so picking 16/06 14:32 still means
      // "before the 16th", not "before 14:32 on the 16th".
      if (def.type === 'date') {
        return dayBounds ? q.lt(def.key, dayBounds.start) : q
      }
      return v === '' ? q : q.lt(def.key, v)
    case 'after':
      // "is after 16/06" → rows on the 17th or later. Use day_end so
      // anything ON the 16th is excluded — matches operator intuition.
      if (def.type === 'date') {
        return dayBounds ? q.gte(def.key, dayBounds.end) : q
      }
      return v === '' ? q : q.gt(def.key, v)
    case 'between': {
      const v2 = f.v2 ?? ''
      if (v === '' || v2 === '') return q
      if (def.type === 'date') {
        // Inclusive on both ends, day-granular: between 16/06 and 18/06
        // includes the full 16th, 17th and 18th. Auto-swap if reversed.
        const a = toDayBounds(v)
        const b = toDayBounds(v2)
        if (!a || !b) return q
        const lo = a.start < b.start ? a.start : b.start
        const hiEnd = a.end > b.end ? a.end : b.end
        return q.gte(def.key, lo).lt(def.key, hiEnd)
      }
      return q.gte(def.key, coerce(v, def)).lte(def.key, coerce(v2, def))
    }
    case 'empty':
      // Treat both NULL and empty-string as "empty" for text columns.
      // For other types, only NULL counts.
      if (def.type === 'text') {
        return q.or(`${def.key}.is.null,${def.key}.eq.`)
      }
      return q.is(def.key, null)
    case 'notempty':
      if (def.type === 'text') {
        // Mirror the 'empty' branch — for text columns, both NULL and
        // empty-string count as empty, so notempty must exclude both.
        return q.not(def.key, 'is', null).neq(def.key, '')
      }
      return q.not(def.key, 'is', null)
    case 'istrue':
      return q.is(def.key, true)
    case 'isfalse':
      return q.is(def.key, false)
    default:
      return q
  }
}

/**
 * Translate a date-picker value (YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss[.fff]])
 * into the UTC range that covers the whole calendar day.
 *
 * Why UTC: timestamptz columns are stored + compared in UTC on the
 * server side. Using the operator's local TZ would require a
 * client-side hint we don't currently pass; UTC is predictable and
 * matches how the columns render elsewhere (e.g. /scrape's "Started"
 * label). If we later want PHT-day or Europe/Madrid-day, add a TZ
 * argument and offset the bounds accordingly.
 */
function toDayBounds(v: string): { start: string; end: string } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const start = new Date(Date.UTC(y, mo - 1, d))
  if (Number.isNaN(start.getTime())) return null
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)
  return { start: start.toISOString(), end: end.toISOString() }
}

function coerce(v: string, def: ColumnDef): unknown {
  if (def.type === 'number') {
    const n = Number(v)
    return Number.isFinite(n) ? n : v
  }
  if (def.type === 'boolean') {
    return v === 'true' || v === '1'
  }
  return v
}

/**
 * Apply Sort entries in priority order. The first sort becomes the primary
 * key, subsequent ones are tiebreakers. Skips sorts whose column isn't in
 * the registry or isn't marked sortable.
 */
export function applySorts<Q extends AnyQuery>(
  query: Q,
  sorts: Sort[],
  registry: ReadonlyArray<ColumnDef>,
): Q {
  const byKey = new Map(registry.map(c => [c.key, c]))
  let q: AnyQuery = query
  for (const s of sorts) {
    const def = byKey.get(s.col)
    if (!def || def.sortable === false) continue
    q = q.order(def.key, { ascending: s.dir === 'asc', nullsFirst: false })
  }
  return q as Q
}
