import type { Filter, Sort } from './types'

/**
 * URL params for the advanced filter UI:
 *   ?f=domain:contains:rooster
 *   ?f=overall_position:between:1:10
 *   ?s=created_at:desc
 *   ?q=foo
 *
 * Multiple `f=` and `s=` entries are allowed. We use plain colons because
 * none of our column / operator names contain them; values that might
 * (rare) get URI-encoded by the browser anyway.
 */

export function parseFilters(raw: string | string[] | undefined): Filter[] {
  const all = Array.isArray(raw) ? raw : raw ? [raw] : []
  const out: Filter[] = []
  for (const r of all) {
    const parts = r.split(':')
    if (parts.length < 2) continue
    const [col, op, v, v2] = parts
    if (!col || !op) continue
    // `between` requires both bounds. Without them the filter is a
    // no-op downstream (see applyOne in ./apply.ts), and we'd rather
    // drop it than carry a half-formed row through the URL.
    if (op === 'between' && (!v || !v2)) continue
    const row: Filter = { col, op }
    if (v !== undefined) row.v = v
    if (v2 !== undefined) row.v2 = v2
    out.push(row)
  }
  return out
}

export function parseSorts(raw: string | string[] | undefined): Sort[] {
  const all = Array.isArray(raw) ? raw : raw ? [raw] : []
  const out: Sort[] = []
  for (const r of all) {
    const [col, dir] = r.split(':')
    if (!col) continue
    out.push({ col, dir: dir === 'desc' ? 'desc' : 'asc' })
  }
  return out
}

export function serializeFilters(filters: Filter[]): string[] {
  const out: string[] = []
  for (const f of filters) {
    if (!f.col || !f.op) continue
    if (f.op === 'between') {
      // Both bounds must be present — without them the filter is a
      // no-op, and emitting `col:between:5` would position-collapse
      // on the next parse (v2 silently slides into v).
      if (!f.v || !f.v2) continue
      out.push(`${f.col}:${f.op}:${f.v}:${f.v2}`)
      continue
    }
    // All other ops use only v; never emit v2 in this slot, since the
    // positional encoding would otherwise let v2 leak into v on parse.
    if (f.v !== undefined && f.v !== '') {
      out.push(`${f.col}:${f.op}:${f.v}`)
    } else {
      out.push(`${f.col}:${f.op}`)
    }
  }
  return out
}

export function serializeSorts(sorts: Sort[]): string[] {
  return sorts.filter(s => s.col).map(s => `${s.col}:${s.dir}`)
}

/** Build a URLSearchParams reflecting filters + sorts + search + page-state. */
export function buildSearchParams(input: {
  filters?: Filter[]
  sorts?: Sort[]
  q?: string
  page?: number
  size?: number
  /** Other params to preserve verbatim (e.g. `result_type`, `country_code`). */
  preserve?: Record<string, string | undefined>
}): URLSearchParams {
  const sp = new URLSearchParams()
  for (const f of serializeFilters(input.filters ?? [])) sp.append('f', f)
  for (const s of serializeSorts(input.sorts ?? [])) sp.append('s', s)
  if (input.q) sp.set('q', input.q)
  if (input.page && input.page > 1) sp.set('page', String(input.page))
  if (input.size) sp.set('size', String(input.size))
  for (const [k, v] of Object.entries(input.preserve ?? {})) {
    if (v) sp.set(k, v)
  }
  return sp
}
