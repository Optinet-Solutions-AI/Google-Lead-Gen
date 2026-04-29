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
      return v === '' ? q : q.eq(def.key, coerce(v, def))
    case 'neq':
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
      return v === '' ? q : q.lt(def.key, v)
    case 'after':
      return v === '' ? q : q.gt(def.key, v)
    case 'between': {
      const v2 = f.v2 ?? ''
      if (v === '' || v2 === '') return q
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
        return q.not(def.key, 'is', null)
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
