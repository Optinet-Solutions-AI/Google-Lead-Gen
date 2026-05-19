import type { ColumnDef } from './types'

const RESULT_TYPE_OPTIONS = [
  { value: 'PPC', label: 'PPC' },
  { value: 'Organic', label: 'Organic' },
] as const

const SEEN_ON_OPTIONS = [
  { value: 'desktop', label: 'Desktop' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'both', label: 'Both' },
] as const

const BOOL_THREE_OPTIONS = [
  { value: 'true', label: 'Yes' },
  { value: 'false', label: 'No' },
] as const

/** Registry of every column the user can filter / sort the leads table by.
 *  Country options are injected at render time since they come from the DB. */
export const LEADS_COLUMNS: ReadonlyArray<ColumnDef> = [
  { key: 'keyword', label: 'Keyword', type: 'text', filterable: true, sortable: true },
  { key: 'country_code', label: 'Country', type: 'select', filterable: true, sortable: true, options: [] },
  { key: 'result_type', label: 'Type', type: 'select', filterable: true, sortable: true, options: [...RESULT_TYPE_OPTIONS] },
  { key: 'seen_on', label: 'View', type: 'select', filterable: true, sortable: true, options: [...SEEN_ON_OPTIONS] },
  { key: 'domain', label: 'Domain', type: 'text', filterable: true, sortable: true },
  { key: 'url', label: 'URL', type: 'text', filterable: true, sortable: false },
  { key: 'overall_position', label: 'Position', type: 'number', filterable: true, sortable: true },
  { key: 'page_number', label: 'Page #', type: 'number', filterable: true, sortable: true },
  { key: 'batch_id', label: 'Batch', type: 'number', filterable: true, sortable: true },
  { key: 'is_on_monday', label: 'Is on Monday?', type: 'boolean', filterable: true, sortable: false },
  { key: 'is_affiliate', label: 'Is affiliate?', type: 'boolean', filterable: true, sortable: false, options: [...BOOL_THREE_OPTIONS] },
  { key: 'is_rooster_partner', label: 'Rooster brand?', type: 'boolean', filterable: true, sortable: false },
  { key: 'has_contact_details', label: 'Has contacts?', type: 'boolean', filterable: true, sortable: false },
  { key: 'has_s_tags', label: 'Has s-tags?', type: 'boolean', filterable: true, sortable: false },
  { key: 's_tags_checked_at', label: 'S-tags checked', type: 'date', filterable: true, sortable: true },
  { key: 'created_at', label: 'Created', type: 'date', filterable: true, sortable: true },
]
