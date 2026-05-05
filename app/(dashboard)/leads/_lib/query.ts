import 'server-only'
import { applyFilters, applySorts } from '@/lib/filters/apply'
import { LEADS_COLUMNS } from '@/lib/filters/columns-leads'
import type { Filter, Sort } from '@/lib/filters/types'
import { createServiceClient } from '@/lib/supabase/service'

export const LEAD_PAGE_SIZES = [10, 25, 50, 100] as const
export const DEFAULT_LEAD_PAGE_SIZE = 10

export type LeadRow = {
  id: number
  keyword: string | null
  country: string | null
  country_code: string | null
  url: string | null
  domain: string | null
  page_number: number | null
  position_on_page: number | null
  overall_position: number | null
  result_type: string | null
  batch_id: number | null
  scrape_job_id: string | null
  // Monday duplicate check (7.1)
  is_on_monday: boolean | null
  monday_board: string | null
  monday_item_id: string | null
  monday_overridden_at: string | null
  // Affiliate detection (7.2)
  is_affiliate: boolean | null
  affiliate_confidence: string | null
  is_affiliate_overridden_at: string | null
  // Rooster partner (7.3)
  is_rooster_partner: boolean | null
  brand: string | null
  is_rooster_overridden_at: string | null
  // Contacts (7.4)
  has_contact_details: boolean | null
  is_contact_overridden_at: string | null
  // S-tags (7.5)
  has_s_tags: boolean | null
  is_stag_overridden_at: string | null
  // S-tag verified (7.6)
  s_tags_checked_at: string | null
  s_tag_id: number | null
  created_at: string
  is_not_relevant: boolean
  // Attribution — denormalized from scrape_queue at query time so the
  // table can show "by <display>" without an extra round-trip.
  created_by_username: string | null
  created_by_display: string | null
}

export type LeadsQueryOptions = {
  page: number
  size: number
  /** Legacy primary-sort + order — used when no `sorts[]` is provided. */
  sort: string
  order: 'asc' | 'desc'
  q: string
  countryCode: string
  resultType: string
  /** If set, only rows whose scrape_job_id matches (single-job detail page). */
  scrapeJobId?: string
  /** Advanced filter rows from the URL (parsed `?f=` params). */
  filters?: Filter[]
  /** Advanced sort priority list (parsed `?s=` params). */
  sorts?: Sort[]
  /** Include rows flagged is_not_relevant. Default false — those rows
   *  are hidden from the default /leads view. Pass true to surface
   *  them (with the badge) e.g. for an admin "show hidden" toggle. */
  includeNotRelevant?: boolean
}

export type LeadsQueryResult = {
  rows: LeadRow[]
  total: number
}

const SEARCHABLE_COLUMNS = ['keyword', 'url', 'domain', 'country']

function sanitize(q: string): string {
  return q.replace(/[,()*]/g, '').trim()
}

export async function queryLeads(opts: LeadsQueryOptions): Promise<LeadsQueryResult> {
  const svc = createServiceClient()

  let query = svc
    .from('google_lead_gen_table')
    .select(
      [
        'id, keyword, country, country_code, url, domain',
        'page_number, position_on_page, overall_position',
        'result_type, batch_id, scrape_job_id',
        'is_on_monday, monday_board, monday_item_id, monday_overridden_at',
        'is_affiliate, affiliate_confidence, is_affiliate_overridden_at',
        'is_rooster_partner, brand, is_rooster_overridden_at',
        'has_contact_details, is_contact_overridden_at',
        'has_s_tags, is_stag_overridden_at',
        's_tags_checked_at, s_tag_id',
        'created_at',
        'is_not_relevant',
        // FK join — google_lead_gen_table.scrape_job_id → scrape_queue(id).
        // PostgREST flattens this into a nested object on the row.
        'scrape_queue:scrape_queue!scrape_job_id(created_by_username, created_by_display)',
      ].join(', '),
      { count: 'exact' },
    )

  // Default: hide not-relevant rows (Monday not_relevant board match
  // OR user-flagged). `?show_hidden=1` flips includeNotRelevant=true.
  if (!opts.includeNotRelevant) {
    query = query.eq('is_not_relevant', false)
  }

  if (opts.scrapeJobId) {
    query = query.eq('scrape_job_id', opts.scrapeJobId)
  }

  const cleanQ = sanitize(opts.q)
  if (cleanQ.length > 0) {
    const or = SEARCHABLE_COLUMNS.map(c => `${c}.ilike.%${cleanQ}%`).join(',')
    query = query.or(or)
  }

  if (opts.countryCode) query = query.eq('country_code', opts.countryCode)
  if (opts.resultType) query = query.eq('result_type', opts.resultType)

  // Advanced filter rows (`?f=col:op:val`). Validated against LEADS_COLUMNS.
  if (opts.filters && opts.filters.length > 0) {
    query = applyFilters(query, opts.filters, LEADS_COLUMNS)
  }

  // PPC always groups above Organic regardless of the user's column-click sort.
  // PPC > Organic alphabetically, so DESC puts PPC first; nullsFirst:false
  // keeps null result_type rows at the very bottom.
  query = query.order('result_type', { ascending: false, nullsFirst: false })

  // Advanced multi-sort takes precedence over the legacy single-sort fields.
  if (opts.sorts && opts.sorts.length > 0) {
    query = applySorts(query, opts.sorts, LEADS_COLUMNS)
  } else if (opts.sort !== 'result_type') {
    // Legacy: user's column-click sort acts as the secondary key within
    // each result_type group.
    query = query.order(opts.sort, { ascending: opts.order === 'asc', nullsFirst: false })
  }

  const from = Math.max(0, (opts.page - 1) * opts.size)
  query = query.range(from, from + opts.size - 1)

  const { data, count, error } = await query
  if (error) {
    throw new Error(
      `queryLeads failed: ${error.message} (details: ${JSON.stringify(error.details ?? {})})`,
    )
  }
  // PostgREST returns the joined scrape_queue row as a nested object —
  // flatten it into the LeadRow shape callers expect.
  const rows = (data ?? []).map(raw => {
    const r = raw as unknown as Record<string, unknown> & {
      scrape_queue: { created_by_username: string | null; created_by_display: string | null } | null
    }
    const { scrape_queue, ...rest } = r
    return {
      ...rest,
      created_by_username: scrape_queue?.created_by_username ?? null,
      created_by_display: scrape_queue?.created_by_display ?? null,
    }
  }) as unknown as LeadRow[]
  return { rows, total: count ?? 0 }
}

export async function listCountryFilters(): Promise<Array<{ code: string; name: string }>> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from('gologin_profiles')
    .select('country_code, country_name')
    .eq('is_active', true)
    .order('country_name', { ascending: true })
  if (error) throw error
  return (data ?? []).map(r => ({ code: r.country_code, name: r.country_name }))
}
