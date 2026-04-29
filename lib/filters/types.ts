export type ColumnType = 'text' | 'select' | 'number' | 'date' | 'boolean'

export type ColumnDef = {
  /** DB column name. Also used as the key in URL params. */
  key: string
  label: string
  type: ColumnType
  /** For type='select' only — fixed value list shown in the value picker. */
  options?: ReadonlyArray<{ value: string; label: string }>
  /** Whether the column appears in the Sort popover. */
  sortable?: boolean
  /** Whether the column appears in the Filter popover's column dropdown. */
  filterable?: boolean
}

/** A single filter row in the Filter popover. */
export type Filter = {
  col: string
  op: string
  /** Primary value. Empty for operators that don't take a value (empty / notempty). */
  v?: string
  /** Secondary value, only used by `between`. */
  v2?: string
}

export type Sort = {
  col: string
  dir: 'asc' | 'desc'
}

/** Operators supported per column type. */
export const OPERATORS_BY_TYPE: Record<ColumnType, ReadonlyArray<{ value: string; label: string }>> = {
  text: [
    { value: 'contains', label: 'contains' },
    { value: 'notcontains', label: "doesn't contain" },
    { value: 'is', label: 'is' },
    { value: 'isnot', label: 'is not' },
    { value: 'startswith', label: 'starts with' },
    { value: 'empty', label: 'is empty' },
    { value: 'notempty', label: 'is not empty' },
  ],
  select: [
    { value: 'is', label: 'is' },
    { value: 'isnot', label: 'is not' },
    { value: 'empty', label: 'is empty' },
    { value: 'notempty', label: 'is not empty' },
  ],
  number: [
    { value: 'eq', label: '=' },
    { value: 'neq', label: '≠' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '≥' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '≤' },
    { value: 'between', label: 'between' },
    { value: 'empty', label: 'is empty' },
    { value: 'notempty', label: 'is not empty' },
  ],
  date: [
    { value: 'eq', label: 'is' },
    { value: 'before', label: 'is before' },
    { value: 'after', label: 'is after' },
    { value: 'between', label: 'is between' },
    { value: 'empty', label: 'is empty' },
    { value: 'notempty', label: 'is not empty' },
  ],
  boolean: [
    { value: 'istrue', label: 'is true' },
    { value: 'isfalse', label: 'is false' },
    { value: 'empty', label: 'is empty' },
  ],
}

export function operatorsFor(type: ColumnType) {
  return OPERATORS_BY_TYPE[type]
}

/** Operators that take no value at all. */
export const VALUELESS_OPS = new Set(['empty', 'notempty', 'istrue', 'isfalse'])

/** Operators that need a secondary value (range). */
export const RANGE_OPS = new Set(['between'])
