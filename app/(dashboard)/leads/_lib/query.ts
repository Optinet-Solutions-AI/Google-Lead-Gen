import 'server-only'
import { applyFilters, applySorts } from '@/lib/filters/apply'
import { LEADS_COLUMNS } from '@/lib/filters/columns-leads'
import type { Filter, Sort } from '@/lib/filters/types'
import { applyShadowFilter, getShadowContext } from '@/lib/shadow-filter'
import { createServiceClient } from '@/lib/supabase/service'
import { DEFAULT_RECENCY_BANDS, recencyBand, type RecencyBand, type RecencyBands } from '@/lib/website-profiles/recency'

// 0 is the sentinel for "All rows" — substituted with a soft cap
// in queryLeads so a multi-thousand-row table doesn't lock up the
// browser. Keep the sentinel in sync with ALL_ROWS in
// monday/_components/pagination.tsx.
export const LEAD_PAGE_SIZES = [20, 50, 100, 0] as const
export const DEFAULT_LEAD_PAGE_SIZE = 20
/** Soft cap used when the user picks "All". */
export const LEAD_ROWS_ALL_CAP = 10_000

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
  /** Which device view captured this lead: 'desktop' | 'mobile' | 'both' | null. */
  seen_on: string | null
  batch_id: number | null
  scrape_job_id: string | null
  // Monday duplicate check (7.1)
  is_on_monday: boolean | null
  monday_board: string | null
  monday_item_id: string | null
  monday_overridden_at: string | null
  /** When the Monday duplicate check last ran for this row. Shown on the
   *  "Already exists?" badge so an operator can judge how stale it is. */
  monday_checked_at: string | null
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
  /** Obvious non-affiliate category set by the system (denylist, social host,
   *  known list, OpenAI). Hidden by default like not-relevant rows. */
  system_flag: string | null
  // Website profile (one per website) — when the website was last seen on
  // any scrape and how often, plus the colour band for the table dot.
  profile_id: number | null
  last_seen_at: string | null
  appearance_count: number | null
  recency_band: RecencyBand
  /** What the website IS, in a dozen words, from the SERP screen. Lives on
   *  the profile because it describes the site, not this one appearance. */
  ai_site_description: string | null
  /** True when the website already had a profile when this lead was
   *  written. Stored, not derived — see 20260925120000. */
  seen_before: boolean | null
  /** Where this domain already exists. 'monday' — it matched a Monday
   *  board. 'system' — our own database saw it on an earlier scrape.
   *  'new' — a genuinely new lead, which is the one we want. */
  existing_state: 'monday' | 'system' | 'new'
  // Relevance to the keyword, screened off the SERP before any crawl.
  is_relevant: boolean | null
  relevance_reason: string | null
  relevance_overridden_at: string | null
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
  /** If set, rows across ANY of these job ids. Used to merge the Organic
   *  (Apify) + PPC (VM) halves of one split batch on the detail page so that
   *  opening either half shows the batch's full result set — previously an
   *  operator opening the PPC half saw "no results" while the organic leads
   *  sat under a sibling job id. Takes precedence over scrapeJobId. */
  scrapeJobIds?: string[]
  /** Advanced filter rows from the URL (parsed `?f=` params). */
  filters?: Filter[]
  /** Advanced sort priority list (parsed `?s=` params). */
  sorts?: Sort[]
  /** Include rows flagged is_not_relevant. Default false — those rows
   *  are hidden from the default /leads view. Pass true to surface
   *  them (with the badge) e.g. for an admin "show hidden" toggle. */
  includeNotRelevant?: boolean
  /** Recency colour bands (admin setting). Defaults to the seed values. */
  recencyBands?: RecencyBands
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
  // Shadow isolation — see lib/shadow-filter.ts. google_lead_gen_table
  // carries created_by_is_shadow cascaded from scrape_queue at
  // insert time (complete_scrape_job RPC).
  const shadowCtx = await getShadowContext()

  let query = svc
    .from('google_lead_gen_table')
    .select(
      [
        'id, keyword, country, country_code, url, domain',
        'page_number, position_on_page, overall_position',
        'result_type, seen_on, batch_id, scrape_job_id',
        'is_on_monday, monday_board, monday_item_id, monday_overridden_at, monday_checked_at',
        'is_affiliate, affiliate_confidence, is_affiliate_overridden_at',
        'is_rooster_partner, brand, is_rooster_overridden_at',
        'has_contact_details, is_contact_overridden_at',
        'has_s_tags, is_stag_overridden_at',
        's_tags_checked_at, s_tag_id',
        'created_at',
        'is_not_relevant, system_flag, profile_id, seen_before',
        'is_relevant, relevance_reason, relevance_overridden_at',
        // Website profile — FK google_lead_gen_table.profile_id → website_profiles(id).
        'website_profiles:website_profiles!profile_id(last_seen_at, first_seen_at, appearance_count, ai_site_description)',
        // FK join — google_lead_gen_table.scrape_job_id → scrape_queue(id).
        // PostgREST flattens this into a nested object on the row.
        'scrape_queue:scrape_queue!scrape_job_id(created_by_username, created_by_display)',
      ].join(', '),
      { count: 'exact' },
    )

  // Shadow isolation kicks in before any other filter so a non-shadow
  // viewer never even sees a count of shadow rows.
  query = applyShadowFilter(query, shadowCtx) as typeof query

  // Default: hide not-relevant rows (Monday not_relevant board match
  // OR user-flagged). `?show_hidden=1` flips includeNotRelevant=true.
  if (!opts.includeNotRelevant) {
    query = query.eq('is_not_relevant', false).is('system_flag', null)
  }

  if (opts.scrapeJobIds && opts.scrapeJobIds.length > 0) {
    query = query.in('scrape_job_id', opts.scrapeJobIds)
  } else if (opts.scrapeJobId) {
    query = query.eq('scrape_job_id', opts.scrapeJobId)
  }

  const cleanQ = sanitize(opts.q)
  if (cleanQ.length > 0) {
    const or = SEARCHABLE_COLUMNS.map(c => `${c}.ilike.%${cleanQ}%`).join(',')
    query = query.or(or)
  }

  if (opts.countryCode) query = query.eq('country_code', opts.countryCode)
  if (opts.resultType) query = query.eq('result_type', opts.resultType)

  // "Already exists?" is a view over two columns, not one, so it can't go
  // through the generic filter layer — translate it here and hand the rest on.
  const passThrough: Filter[] = []
  for (const f of opts.filters ?? []) {
    if (f.col !== 'existing_state') {
      passThrough.push(f)
      continue
    }
    const want = (f.v ?? '').toLowerCase()
    const negate = f.op === 'isnot'
    if (want === 'monday') {
      query = negate
        ? query.or('is_on_monday.is.null,is_on_monday.eq.false')
        : query.eq('is_on_monday', true)
    } else if (want === 'system' || want === 'new') {
      const seen = want === 'system'
      // "not monday" has to be null-safe: an unchecked row is not on Monday.
      if (!negate) {
        query = query
          .or('is_on_monday.is.null,is_on_monday.eq.false')
          .eq('seen_before', seen)
      } else {
        query = query.not('seen_before', 'eq', seen)
      }
    }
  }

  // Advanced filter rows (`?f=col:op:val`). Validated against LEADS_COLUMNS.
  if (passThrough.length > 0) {
    query = applyFilters(query, passThrough, LEADS_COLUMNS)
  }

  // PPC > Organic alphabetically, so DESC groups PPC above Organic by default.
  // When the user clicks the result_type header with order=asc, honor the
  // flip so Organic groups first. nullsFirst:false keeps null rows at bottom.
  const resultTypeAsc = opts.sort === 'result_type' && opts.order === 'asc'
  query = query.order('result_type', { ascending: resultTypeAsc, nullsFirst: false })

  // Advanced multi-sort takes precedence over the legacy single-sort fields.
  if (opts.sorts && opts.sorts.length > 0) {
    query = applySorts(query, opts.sorts, LEADS_COLUMNS)
  } else if (opts.sort !== 'result_type') {
    // Legacy: user's column-click sort acts as the secondary key within
    // each result_type group.
    query = query.order(opts.sort, { ascending: opts.order === 'asc', nullsFirst: false })
  }

  // size === 0 (sentinel "All") → fetch up to LEAD_ROWS_ALL_CAP rows
  // from page 1; the dropdown UI calls page=1 implicitly for "All".
  if (opts.size === 0) {
    query = query.range(0, LEAD_ROWS_ALL_CAP - 1)
  } else {
    const from = Math.max(0, (opts.page - 1) * opts.size)
    query = query.range(from, from + opts.size - 1)
  }

  const { data, count, error } = await query
  if (error) {
    console.error('[queryLeads]', error)
    throw new Error('Failed to load leads.')
  }
  // PostgREST returns the joined scrape_queue row as a nested object —
  // flatten it into the LeadRow shape callers expect.
  const bands = opts.recencyBands ?? DEFAULT_RECENCY_BANDS
  const nowMs = Date.now()
  const rows = (data ?? []).map(raw => {
    const r = raw as unknown as Record<string, unknown> & {
      scrape_queue: { created_by_username: string | null; created_by_display: string | null } | null
      website_profiles: {
        last_seen_at: string | null
        first_seen_at: string | null
        appearance_count: number | null
        ai_site_description: string | null
      } | null
    }
    const { scrape_queue, website_profiles, ...rest } = r
    const lastSeen = website_profiles?.last_seen_at ?? null
    return {
      ...rest,
      created_by_username: scrape_queue?.created_by_username ?? null,
      created_by_display: scrape_queue?.created_by_display ?? null,
      last_seen_at: lastSeen,
      appearance_count: website_profiles?.appearance_count ?? null,
      recency_band: recencyBand(lastSeen, bands, nowMs),
      ai_site_description: website_profiles?.ai_site_description ?? null,
      existing_state: existingState(
        r.is_on_monday as boolean | null,
        r.seen_before as boolean | null,
      ),
    }
  }) as unknown as LeadRow[]
  return { rows, total: count ?? 0 }
}

/**
 * Monday and our own database are one merged corpus now, so a lead does not
 * need two "have we seen this before?" columns — it needs one that says
 * WHERE.
 *
 * Monday outranks our own history: scraping a site puts it in the system by
 * definition, so "known externally but not in the system" cannot happen, and
 * "in system" only means anything once Monday is ruled out.
 *
 * `seen_before` is stored on the row rather than recomputed here, so the
 * filter in the panel and the badge in the table cannot disagree.
 */
function existingState(
  isOnMonday: boolean | null,
  seenBefore: boolean | null,
): 'monday' | 'system' | 'new' {
  if (isOnMonday === true) return 'monday'
  return seenBefore === true ? 'system' : 'new'
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
