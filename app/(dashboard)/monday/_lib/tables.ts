/**
 * Registry describing every table the Monday dashboard can display.
 *
 * For each of the 4 boards there are two views:
 *   - items   (the main board rows)
 *   - updates (posts/comments from Monday)
 *
 * The registry drives both the mini-nav and the data-table layout.
 */

export type BoardSlug =
  | 'leads'
  | 'affiliates'
  | 'not-relevant-leads'
  | 'email-undelivered-leads'

export type TableKind = 'items' | 'updates'

export type ColumnConfig = {
  /** SQL column name. */
  key: string
  /** Display label. */
  label: string
  /** Whether the header is clickable to change the sort order. */
  sortable: boolean
  /** Optional Tailwind class to constrain width. */
  className?: string
}

export type MobileCardConfig = {
  /** Column used as the card heading. */
  heading: string
  /** Optional column displayed as a small badge next to the heading. */
  badge?: string
  /** Columns displayed as secondary lines. */
  body: string[]
  /** Column displayed small at the bottom. */
  footer?: string
}

export type TableConfig = {
  boardSlug: BoardSlug
  kind: TableKind
  label: string
  sqlTable: string
  searchColumns: string[]
  columns: ColumnConfig[]
  mobileCard: MobileCardConfig
  /** Default sort column when no `?sort=...` is in the URL. */
  defaultSort: { column: string; order: 'asc' | 'desc' }
}

// ---------------------------------------------------------------------------
// Reusable column fragments
// ---------------------------------------------------------------------------

const UPDATES_COLUMNS: ColumnConfig[] = [
  { key: 'monday_item_id', label: 'Item ID', sortable: true, className: 'min-w-[110px]' },
  { key: 'creator_name', label: 'Creator', sortable: true, className: 'min-w-[160px]' },
  { key: 'creator_email', label: 'Email', sortable: true, className: 'min-w-[200px]' },
  { key: 'body_text', label: 'Content', sortable: false, className: 'min-w-[320px]' },
  {
    key: 'monday_created_at',
    label: 'Posted',
    sortable: true,
    className: 'min-w-[150px]',
  },
]

const UPDATES_SEARCH: string[] = ['body_text', 'creator_name', 'creator_email']
const UPDATES_MOBILE: MobileCardConfig = {
  heading: 'creator_name',
  body: ['body_text'],
  footer: 'monday_created_at',
}

const UPDATES_SORT = { column: 'monday_created_at', order: 'desc' as const }

function updatesTable(
  boardSlug: BoardSlug,
  label: string,
  sqlTable: string,
): TableConfig {
  return {
    boardSlug,
    kind: 'updates',
    label,
    sqlTable,
    searchColumns: UPDATES_SEARCH,
    columns: UPDATES_COLUMNS,
    mobileCard: UPDATES_MOBILE,
    defaultSort: UPDATES_SORT,
  }
}

// ---------------------------------------------------------------------------
// Board configs
// ---------------------------------------------------------------------------

export const BOARDS: ReadonlyArray<{
  slug: BoardSlug
  label: string
  items: TableConfig
  updates: TableConfig
}> = [
  {
    slug: 'leads',
    label: 'Leads',
    items: {
      boardSlug: 'leads',
      kind: 'items',
      label: 'Leads',
      sqlTable: 'leads_table',
      searchColumns: ['name', 'email', 'website', 'keywords', 'comments'],
      columns: [
        { key: 'name', label: 'Name', sortable: true, className: 'min-w-[200px]' },
        { key: 'status', label: 'Status', sortable: true, className: 'min-w-[140px]' },
        { key: 'email', label: 'Email', sortable: true, className: 'min-w-[200px]' },
        { key: 'website', label: 'Website', sortable: true, className: 'min-w-[200px]' },
        { key: 'keywords', label: 'Keywords', sortable: true, className: 'min-w-[160px]' },
        { key: 'source', label: 'Source', sortable: true, className: 'min-w-[120px]' },
        { key: 'traffic_size', label: 'Traffic', sortable: true, className: 'min-w-[110px]' },
        { key: 'owner', label: 'Owner', sortable: true, className: 'min-w-[160px]' },
        { key: 'geo', label: 'Geo', sortable: true, className: 'min-w-[90px]' },
        { key: 'date', label: 'Date', sortable: true, className: 'min-w-[120px]' },
      ],
      mobileCard: {
        heading: 'name',
        badge: 'status',
        body: ['website', 'email', 'keywords'],
        footer: 'date',
      },
      defaultSort: { column: 'id', order: 'desc' },
    },
    updates: updatesTable('leads', 'Leads Updates', 'leads_updates_table'),
  },
  {
    slug: 'affiliates',
    label: 'Affiliates',
    items: {
      boardSlug: 'affiliates',
      kind: 'items',
      label: 'Affiliates',
      sqlTable: 'affiliates_table',
      searchColumns: ['name', 'affiliate_name', 'email', 'website', 'keywords'],
      columns: [
        { key: 'name', label: 'Name', sortable: true, className: 'min-w-[200px]' },
        { key: 'affiliate_name', label: 'Affiliate', sortable: true, className: 'min-w-[180px]' },
        { key: 'status', label: 'Status', sortable: true, className: 'min-w-[140px]' },
        { key: 'email', label: 'Email', sortable: true, className: 'min-w-[200px]' },
        { key: 'website', label: 'Website', sortable: true, className: 'min-w-[200px]' },
        { key: 'keywords', label: 'Keywords', sortable: true, className: 'min-w-[160px]' },
        { key: 'pm', label: 'PM', sortable: true, className: 'min-w-[90px]' },
        { key: 'nd', label: 'ND', sortable: true, className: 'min-w-[90px]' },
        { key: 'source', label: 'Source', sortable: true, className: 'min-w-[120px]' },
        { key: 'traffic_size', label: 'Traffic', sortable: true, className: 'min-w-[110px]' },
        { key: 'owner', label: 'Owner', sortable: true, className: 'min-w-[160px]' },
        { key: 'geo', label: 'Geo', sortable: true, className: 'min-w-[90px]' },
        { key: 'date', label: 'Date', sortable: true, className: 'min-w-[120px]' },
      ],
      mobileCard: {
        heading: 'name',
        badge: 'status',
        body: ['affiliate_name', 'website', 'email'],
        footer: 'date',
      },
      defaultSort: { column: 'id', order: 'desc' },
    },
    updates: updatesTable('affiliates', 'Affiliates Updates', 'affiliates_updates_table'),
  },
  {
    slug: 'not-relevant-leads',
    label: 'Not Relevant',
    items: {
      boardSlug: 'not-relevant-leads',
      kind: 'items',
      label: 'Not Relevant Leads',
      sqlTable: 'not_relevant_leads_table',
      searchColumns: ['name', 'affiliate_name', 'email', 'website', 'keywords'],
      columns: [
        { key: 'name', label: 'Name', sortable: true, className: 'min-w-[200px]' },
        { key: 'affiliate_name', label: 'Affiliate', sortable: true, className: 'min-w-[180px]' },
        { key: 'status', label: 'Status', sortable: true, className: 'min-w-[180px]' },
        { key: 'email', label: 'Email', sortable: true, className: 'min-w-[200px]' },
        { key: 'website', label: 'Website', sortable: true, className: 'min-w-[200px]' },
        { key: 'keywords', label: 'Keywords', sortable: true, className: 'min-w-[160px]' },
        { key: 'google_page', label: 'Google Page', sortable: true, className: 'min-w-[120px]' },
        { key: 'source', label: 'Source', sortable: true, className: 'min-w-[120px]' },
        { key: 'traffic_size', label: 'Traffic', sortable: true, className: 'min-w-[110px]' },
        { key: 'owner', label: 'Owner', sortable: true, className: 'min-w-[160px]' },
        { key: 'geo', label: 'Geo', sortable: true, className: 'min-w-[90px]' },
        { key: 'date', label: 'Date', sortable: true, className: 'min-w-[120px]' },
      ],
      mobileCard: {
        heading: 'name',
        badge: 'status',
        body: ['affiliate_name', 'website', 'email'],
        footer: 'date',
      },
      defaultSort: { column: 'id', order: 'desc' },
    },
    updates: updatesTable(
      'not-relevant-leads',
      'Not Relevant Updates',
      'not_relevant_leads_updates_table',
    ),
  },
  {
    slug: 'email-undelivered-leads',
    label: 'Email Undelivered',
    items: {
      boardSlug: 'email-undelivered-leads',
      kind: 'items',
      label: 'Email Undelivered Leads',
      sqlTable: 'email_undelivered_leads_table',
      searchColumns: ['name', 'affiliate_name', 'email', 'website', 'keywords'],
      columns: [
        { key: 'name', label: 'Name', sortable: true, className: 'min-w-[200px]' },
        { key: 'affiliate_name', label: 'Affiliate', sortable: true, className: 'min-w-[180px]' },
        { key: 'status', label: 'Status', sortable: true, className: 'min-w-[180px]' },
        { key: 'email', label: 'Email', sortable: true, className: 'min-w-[200px]' },
        { key: 'website', label: 'Website', sortable: true, className: 'min-w-[200px]' },
        { key: 'keywords', label: 'Keywords', sortable: true, className: 'min-w-[160px]' },
        { key: 'google_page', label: 'Google Page', sortable: true, className: 'min-w-[120px]' },
        { key: 'source', label: 'Source', sortable: true, className: 'min-w-[120px]' },
        { key: 'traffic_size', label: 'Traffic', sortable: true, className: 'min-w-[110px]' },
        { key: 'owner', label: 'Owner', sortable: true, className: 'min-w-[160px]' },
        { key: 'geo', label: 'Geo', sortable: true, className: 'min-w-[90px]' },
        { key: 'date', label: 'Date', sortable: true, className: 'min-w-[120px]' },
      ],
      mobileCard: {
        heading: 'name',
        badge: 'status',
        body: ['affiliate_name', 'website', 'email'],
        footer: 'date',
      },
      defaultSort: { column: 'id', order: 'desc' },
    },
    updates: updatesTable(
      'email-undelivered-leads',
      'Email Undelivered Updates',
      'email_undelivered_leads_updates_table',
    ),
  },
] as const

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getBoardBySlug(slug: string): (typeof BOARDS)[number] | null {
  return BOARDS.find(b => b.slug === slug) ?? null
}

export function getTableConfig(
  boardSlug: string,
  kind: TableKind,
): TableConfig | null {
  const board = getBoardBySlug(boardSlug)
  if (!board) return null
  return kind === 'items' ? board.items : board.updates
}

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 10
