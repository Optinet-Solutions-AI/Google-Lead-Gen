'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowDown,
  ArrowUp,
  Filter,
  ListFilter,
  Plus,
  Search as SearchIcon,
  Trash2,
  X,
} from 'lucide-react'
import {
  RANGE_OPS,
  VALUELESS_OPS,
  operatorsFor,
  type ColumnDef,
  type Filter as FilterRow,
  type Sort as SortRow,
} from '@/lib/filters/types'
import {
  buildSearchParams,
  parseFilters,
  parseSorts,
} from '@/lib/filters/serialize'

type Props = {
  /** Columns the user can filter / sort by, in the order they appear in dropdowns. */
  columns: ReadonlyArray<ColumnDef>
  /** Optional: keys to preserve as-is in the URL when building new params (legacy filters, etc). */
  preserve?: ReadonlyArray<string>
}

/** A draft row carries a stable UI key alongside the actual filter/sort
 *  data so React can correctly re-use DOM/state when middle rows are
 *  removed via `remove(i)`. Using the array index as React's key (the
 *  previous shape) caused the row that moved up into the removed slot
 *  to re-mount with the *previous* row's input/select state. See
 *  BUGS.md R2-29. The `_key` field is ignored by serializeFilters /
 *  serializeSorts so it never reaches the URL. */
type Keyed<T> = T & { _key: string }
function withKey<T>(row: T): Keyed<T> {
  return { ...row, _key: crypto.randomUUID() }
}

export function AdvancedFilters({ columns, preserve = [] }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const filters = useMemo(() => parseFilters(searchParams.getAll('f')), [searchParams])
  const sorts = useMemo(() => parseSorts(searchParams.getAll('s')), [searchParams])
  const q = searchParams.get('q') ?? ''

  const filterableCols = useMemo(() => columns.filter(c => c.filterable), [columns])
  const sortableCols = useMemo(() => columns.filter(c => c.sortable !== false), [columns])

  const [filterOpen, setFilterOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)
  const [draftFilters, setDraftFilters] = useState<Keyed<FilterRow>[]>(() => filters.map(withKey))
  const [draftSorts, setDraftSorts] = useState<Keyed<SortRow>[]>(() => sorts.map(withKey))

  // Re-sync drafts whenever URL state changes (e.g. user clicked a chip).
  useEffect(() => {
    setDraftFilters(filters.map(withKey))
  }, [filters])
  useEffect(() => {
    setDraftSorts(sorts.map(withKey))
  }, [sorts])

  function commit(input: {
    filters?: FilterRow[]
    sorts?: SortRow[]
    q?: string
  }) {
    const preserved: Record<string, string | undefined> = {}
    for (const key of preserve) {
      const v = searchParams.get(key)
      if (v) preserved[key] = v
    }
    const params = buildSearchParams({
      filters: input.filters ?? filters,
      sorts: input.sorts ?? sorts,
      q: input.q !== undefined ? input.q : q,
      preserve: preserved,
    })
    const qs = params.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput initial={q} onCommit={value => commit({ q: value })} />

        <FilterButton
          open={filterOpen}
          setOpen={setFilterOpen}
          count={filters.length}
        >
          <FilterPanel
            columns={filterableCols}
            draft={draftFilters}
            setDraft={setDraftFilters}
            onApply={() => {
              commit({ filters: draftFilters })
              setFilterOpen(false)
            }}
            onClear={() => {
              setDraftFilters([])
              commit({ filters: [] })
              setFilterOpen(false)
            }}
          />
        </FilterButton>

        <SortButton
          open={sortOpen}
          setOpen={setSortOpen}
          count={sorts.length}
        >
          <SortPanel
            columns={sortableCols}
            draft={draftSorts}
            setDraft={setDraftSorts}
            onApply={() => {
              commit({ sorts: draftSorts })
              setSortOpen(false)
            }}
            onClear={() => {
              setDraftSorts([])
              commit({ sorts: [] })
              setSortOpen(false)
            }}
          />
        </SortButton>
      </div>

      {(filters.length > 0 || sorts.length > 0) && (
        <ActiveChips
          filters={filters}
          sorts={sorts}
          columns={columns}
          onRemoveFilter={i => {
            const next = filters.slice()
            next.splice(i, 1)
            commit({ filters: next })
          }}
          onRemoveSort={i => {
            const next = sorts.slice()
            next.splice(i, 1)
            commit({ sorts: next })
          }}
          onClearAll={() => commit({ filters: [], sorts: [] })}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Search box
// ---------------------------------------------------------------------------

function SearchInput({ initial, onCommit }: { initial: string; onCommit: (v: string) => void }) {
  const [value, setValue] = useState(initial)
  useEffect(() => {
    // Re-sync local state when the URL-driven `initial` changes (e.g. user
    // clears via a chip).
    setValue(initial)
  }, [initial])

  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--color-text-secondary)]" />
      <input
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onCommit(value.trim())
          }
        }}
        onBlur={() => {
          if (value.trim() !== initial) onCommit(value.trim())
        }}
        placeholder="Search…"
        className="w-56 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] py-1.5 pl-7 pr-7 text-[12px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            setValue('')
            onCommit('')
          }}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filter button + panel
// ---------------------------------------------------------------------------

function FilterButton({
  open,
  setOpen,
  count,
  children,
}: {
  open: boolean
  setOpen: (v: boolean) => void
  count: number
  children: React.ReactNode
}) {
  return (
    <Popover
      open={open}
      setOpen={setOpen}
      trigger={
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
        >
          <Filter className="h-3.5 w-3.5" />
          Filter
          {count > 0 && (
            <span className="rounded-full bg-[color:var(--color-accent)]/30 px-1.5 text-[10px] font-semibold">
              {count}
            </span>
          )}
        </button>
      }
    >
      {children}
    </Popover>
  )
}

function FilterPanel({
  columns,
  draft,
  setDraft,
  onApply,
  onClear,
}: {
  columns: ReadonlyArray<ColumnDef>
  draft: Keyed<FilterRow>[]
  setDraft: React.Dispatch<React.SetStateAction<Keyed<FilterRow>[]>>
  onApply: () => void
  onClear: () => void
}) {
  const firstCol = columns[0]
  const addRow = () => {
    if (!firstCol) return
    const ops = operatorsFor(firstCol.type)
    setDraft(prev => [...prev, withKey({ col: firstCol.key, op: ops[0]!.value, v: '', v2: '' })])
  }
  const update = (i: number, patch: Partial<FilterRow>) => {
    setDraft(prev => prev.map((f, ix) => (ix === i ? { ...f, ...patch } : f)))
  }
  const remove = (i: number) => {
    setDraft(prev => prev.filter((_, ix) => ix !== i))
  }

  return (
    <div className="flex w-[440px] flex-col gap-3">
      <header className="flex items-center justify-between">
        <h3 className="text-[12px] font-semibold text-[color:var(--color-text-primary)]">
          Filters
        </h3>
        <span className="text-[10px] text-[color:var(--color-text-secondary)]">
          All conditions must match (AND)
        </span>
      </header>

      <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
        {draft.length === 0 && (
          <p className="rounded-md border border-dashed border-[color:var(--color-border)] px-3 py-4 text-center text-[12px] text-[color:var(--color-text-secondary)]">
            No filters yet. Add one to narrow the results.
          </p>
        )}
        {draft.map((row, i) => {
          const def = columns.find(c => c.key === row.col) ?? columns[0]!
          const ops = operatorsFor(def.type)
          const valueless = VALUELESS_OPS.has(row.op)
          const range = RANGE_OPS.has(row.op)
          return (
            <div
              key={row._key}
              className="grid grid-cols-[8ch_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-1.5"
            >
              <span className="px-1 text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
                {i === 0 ? 'Where' : 'And'}
              </span>
              <select
                value={row.col}
                onChange={e => {
                  const next = columns.find(c => c.key === e.target.value)
                  if (!next) return
                  const nextOps = operatorsFor(next.type)
                  update(i, { col: next.key, op: nextOps[0]!.value, v: '', v2: '' })
                }}
                className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[12px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none"
              >
                {columns.map(c => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
              <select
                value={row.op}
                onChange={e => update(i, { op: e.target.value, v: '', v2: '' })}
                className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[12px] text-[color:var(--color-text-primary)] focus:border-[color:var(--color-accent)] focus:outline-none"
              >
                {ops.map(o => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {valueless ? (
                <span className="text-[11px] italic text-[color:var(--color-text-secondary)]">
                  no value
                </span>
              ) : range ? (
                <div className="flex items-center gap-1">
                  <ValueInput def={def} value={row.v ?? ''} onChange={v => update(i, { v })} />
                  <span className="text-[10px]">…</span>
                  <ValueInput def={def} value={row.v2 ?? ''} onChange={v => update(i, { v2: v })} />
                </div>
              ) : (
                <ValueInput def={def} value={row.v ?? ''} onChange={v => update(i, { v })} />
              )}
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label="Remove filter"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-red-700"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )
        })}
      </div>

      <footer className="flex items-center justify-between border-t border-[color:var(--color-border)] pt-2">
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] font-medium hover:bg-[color:var(--color-bg-secondary)]"
        >
          <Plus className="h-3 w-3" />
          Add filter
        </button>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClear}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] font-medium hover:bg-[color:var(--color-bg-secondary)]"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onApply}
            className="rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/20 px-2.5 py-1 text-[11px] font-semibold text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-accent)]/30"
          >
            Apply
          </button>
        </div>
      </footer>
    </div>
  )
}

function ValueInput({
  def,
  value,
  onChange,
}: {
  def: ColumnDef
  value: string
  onChange: (v: string) => void
}) {
  const cls =
    'w-full rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[12px] text-[color:var(--color-text-primary)] placeholder:text-[color:var(--color-text-secondary)] focus:border-[color:var(--color-accent)] focus:outline-none'
  if (def.type === 'select' && def.options && def.options.length > 0) {
    return (
      <select value={value} onChange={e => onChange(e.target.value)} className={cls}>
        <option value="">Pick…</option>
        {def.options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  if (def.type === 'boolean') {
    return (
      <select value={value} onChange={e => onChange(e.target.value)} className={cls}>
        <option value="">Pick…</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    )
  }
  if (def.type === 'date') {
    return (
      <input
        type="datetime-local"
        value={value}
        onChange={e => onChange(e.target.value)}
        className={cls}
      />
    )
  }
  if (def.type === 'number') {
    return (
      <input
        type="number"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="0"
        className={cls}
      />
    )
  }
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder="value"
      className={cls}
    />
  )
}

// ---------------------------------------------------------------------------
// Sort button + panel
// ---------------------------------------------------------------------------

function SortButton({
  open,
  setOpen,
  count,
  children,
}: {
  open: boolean
  setOpen: (v: boolean) => void
  count: number
  children: React.ReactNode
}) {
  return (
    <Popover
      open={open}
      setOpen={setOpen}
      trigger={
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-secondary)]"
        >
          <ListFilter className="h-3.5 w-3.5" />
          Sort
          {count > 0 && (
            <span className="rounded-full bg-[color:var(--color-accent)]/30 px-1.5 text-[10px] font-semibold">
              {count}
            </span>
          )}
        </button>
      }
    >
      {children}
    </Popover>
  )
}

function SortPanel({
  columns,
  draft,
  setDraft,
  onApply,
  onClear,
}: {
  columns: ReadonlyArray<ColumnDef>
  draft: Keyed<SortRow>[]
  setDraft: React.Dispatch<React.SetStateAction<Keyed<SortRow>[]>>
  onApply: () => void
  onClear: () => void
}) {
  const firstCol = columns[0]
  const addRow = () => {
    if (!firstCol) return
    setDraft(prev => [...prev, withKey({ col: firstCol.key, dir: 'asc' })])
  }
  const update = (i: number, patch: Partial<SortRow>) => {
    setDraft(prev => prev.map((s, ix) => (ix === i ? { ...s, ...patch } : s)))
  }
  const remove = (i: number) => {
    setDraft(prev => prev.filter((_, ix) => ix !== i))
  }
  return (
    <div className="flex w-[360px] flex-col gap-3">
      <header className="flex items-center justify-between">
        <h3 className="text-[12px] font-semibold text-[color:var(--color-text-primary)]">
          Sort
        </h3>
        <span className="text-[10px] text-[color:var(--color-text-secondary)]">
          First key wins; ties go to next key
        </span>
      </header>
      <div className="flex flex-col gap-2">
        {draft.length === 0 && (
          <p className="rounded-md border border-dashed border-[color:var(--color-border)] px-3 py-4 text-center text-[12px] text-[color:var(--color-text-secondary)]">
            No sort yet. Default is whatever the page picks.
          </p>
        )}
        {draft.map((row, i) => (
          <div
            key={row._key}
            className="grid grid-cols-[8ch_minmax(0,1fr)_auto_auto] items-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-1.5"
          >
            <span className="px-1 text-[10px] uppercase tracking-wide text-[color:var(--color-text-secondary)]">
              {i === 0 ? 'Sort by' : 'Then by'}
            </span>
            <select
              value={row.col}
              onChange={e => update(i, { col: e.target.value })}
              className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[12px] focus:border-[color:var(--color-accent)] focus:outline-none"
            >
              {columns.map(c => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => update(i, { dir: row.dir === 'asc' ? 'desc' : 'asc' })}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:var(--color-border)] hover:bg-[color:var(--color-bg-secondary)]"
              title={row.dir === 'asc' ? 'Ascending' : 'Descending'}
            >
              {row.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
            </button>
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label="Remove sort"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-secondary)] hover:text-red-700"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <footer className="flex items-center justify-between border-t border-[color:var(--color-border)] pt-2">
        <button
          type="button"
          onClick={addRow}
          className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] font-medium hover:bg-[color:var(--color-bg-secondary)]"
        >
          <Plus className="h-3 w-3" />
          Add sort
        </button>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onClear}
            className="rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] px-2 py-1 text-[11px] font-medium hover:bg-[color:var(--color-bg-secondary)]"
          >
            Clear all
          </button>
          <button
            type="button"
            onClick={onApply}
            className="rounded-md border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/20 px-2.5 py-1 text-[11px] font-semibold hover:bg-[color:var(--color-accent)]/30"
          >
            Apply
          </button>
        </div>
      </footer>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Active chips
// ---------------------------------------------------------------------------

function ActiveChips({
  filters,
  sorts,
  columns,
  onRemoveFilter,
  onRemoveSort,
  onClearAll,
}: {
  filters: FilterRow[]
  sorts: SortRow[]
  columns: ReadonlyArray<ColumnDef>
  onRemoveFilter: (i: number) => void
  onRemoveSort: (i: number) => void
  onClearAll: () => void
}) {
  const labelFor = (key: string) => columns.find(c => c.key === key)?.label ?? key
  const opLabel = (op: string) =>
    op === 'eq' ? '=' : op === 'neq' ? '≠' : op === 'gt' ? '>' : op === 'gte' ? '≥' : op === 'lt' ? '<' : op === 'lte' ? '≤' : op
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {filters.map((f, i) => (
        <Chip key={`f-${i}`} onRemove={() => onRemoveFilter(i)}>
          <span className="font-medium">{labelFor(f.col)}</span>{' '}
          <span className="text-[color:var(--color-text-secondary)]">{opLabel(f.op)}</span>{' '}
          {VALUELESS_OPS.has(f.op) ? null : RANGE_OPS.has(f.op) ? (
            <span>{f.v} … {f.v2}</span>
          ) : (
            <span>{f.v}</span>
          )}
        </Chip>
      ))}
      {sorts.map((s, i) => (
        <Chip key={`s-${i}`} onRemove={() => onRemoveSort(i)}>
          {s.dir === 'asc' ? <ArrowUp className="h-2.5 w-2.5" /> : <ArrowDown className="h-2.5 w-2.5" />}
          <span className="font-medium">{labelFor(s.col)}</span>
        </Chip>
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="text-[11px] text-[color:var(--color-text-secondary)] underline-offset-2 hover:underline"
      >
        Clear all
      </button>
    </div>
  )
}

function Chip({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg-secondary)] px-2 py-0.5 text-[11px] text-[color:var(--color-text-primary)]">
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove"
        className="text-[color:var(--color-text-secondary)] hover:text-red-700"
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Popover primitive
// ---------------------------------------------------------------------------

function Popover({
  open,
  setOpen,
  trigger,
  children,
}: {
  open: boolean
  setOpen: (v: boolean) => void
  trigger: React.ReactNode
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, setOpen])

  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen(!open)}>{trigger}</div>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-primary)] p-3 shadow-xl">
          {children}
        </div>
      )}
    </div>
  )
}
