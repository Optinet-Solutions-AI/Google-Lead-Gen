import type { ColumnDef } from './types'

const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'captcha', label: 'Captcha' },
  { value: 'paused', label: 'Paused' },
  { value: 'cancelled', label: 'Cancelled' },
] as const

const ENRICHMENT_STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'affiliate_running', label: 'Affiliate running' },
  { value: 'all_running', label: 'All running' },
  { value: 'complete', label: 'Complete' },
] as const

const SEARCH_ENGINE_OPTIONS = [
  { value: 'google', label: 'Google' },
  { value: 'bing', label: 'Bing' },
] as const

/** Registry for the /scrape jobs table. Country options are injected at
 *  render time from the DB. */
export const JOBS_COLUMNS: ReadonlyArray<ColumnDef> = [
  { key: 'keyword', label: 'Keyword', type: 'text', filterable: true, sortable: true },
  { key: 'country_code', label: 'Country', type: 'select', filterable: true, sortable: true, options: [] },
  { key: 'status', label: 'Status', type: 'select', filterable: true, sortable: true, options: [...STATUS_OPTIONS] },
  { key: 'enrichment_status', label: 'Enrichment status', type: 'select', filterable: true, sortable: true, options: [...ENRICHMENT_STATUS_OPTIONS] },
  { key: 'with_enrichment', label: 'With enrichment', type: 'boolean', filterable: true, sortable: true },
  { key: 'pages', label: 'Pages', type: 'number', filterable: true, sortable: true },
  { key: 'priority', label: 'Priority', type: 'number', filterable: true, sortable: true },
  { key: 'attempts', label: 'Attempts', type: 'number', filterable: true, sortable: true },
  { key: 'language', label: 'Language', type: 'text', filterable: true, sortable: true },
  { key: 'search_engine', label: 'Search engine', type: 'select', filterable: true, sortable: true, options: [...SEARCH_ENGINE_OPTIONS] },
  { key: 'batch_id', label: 'Batch', type: 'number', filterable: true, sortable: true },
  { key: 'created_at', label: 'Queued at', type: 'date', filterable: true, sortable: true },
  { key: 'started_at', label: 'Started at', type: 'date', filterable: true, sortable: true },
  { key: 'completed_at', label: 'Completed at', type: 'date', filterable: true, sortable: true },
  { key: 'scheduled_at', label: 'Scheduled at', type: 'date', filterable: true, sortable: true },
]
