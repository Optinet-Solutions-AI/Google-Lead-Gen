import 'server-only'
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
  is_on_monday: boolean | null
  monday_board: string | null
  monday_item_id: string | null
  monday_overridden_at: string | null
  created_at: string
}

export type LeadsQueryOptions = {
  page: number
  size: number
  sort: string
  order: 'asc' | 'desc'
  q: string
  countryCode: string
  resultType: string
  /** If set, only rows whose scrape_job_id matches (single-job detail page). */
  scrapeJobId?: string
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
      'id, keyword, country, country_code, url, domain, page_number, position_on_page, overall_position, result_type, batch_id, scrape_job_id, is_on_monday, monday_board, monday_item_id, monday_overridden_at, created_at',
      { count: 'exact' },
    )

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

  query = query.order(opts.sort, { ascending: opts.order === 'asc', nullsFirst: false })

  const from = Math.max(0, (opts.page - 1) * opts.size)
  query = query.range(from, from + opts.size - 1)

  const { data, count, error } = await query
  if (error) {
    throw new Error(
      `queryLeads failed: ${error.message} (details: ${JSON.stringify(error.details ?? {})})`,
    )
  }
  return { rows: (data ?? []) as LeadRow[], total: count ?? 0 }
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
