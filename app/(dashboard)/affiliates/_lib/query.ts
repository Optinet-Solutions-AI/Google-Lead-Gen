import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'
import { parseRecencyBands, type RecencyBands } from '@/lib/website-profiles/recency'

/**
 * Data for /affiliates — what the AI analysis found, and what is still
 * waiting for the manual S-tag walk.
 */

export type AffiliateRow = {
  id: number
  normalized_domain: string
  country_code: string | null
  ai_is_affiliate: boolean | null
  ai_affiliate_reason: string | null
  ai_brand_count: number | null
  ai_cta_count: number | null
  ai_brands: string[] | null
  ai_rooster_brands: string[] | null
  ai_new_brands: string[] | null
  ai_emails: string[] | null
  ai_phones: string[] | null
  ai_contact_page_url: string | null
  ai_crawl_at: string | null
  ai_crawl_status: string | null
  manual_stag_status: string | null
  last_seen_at: string | null
  appearance_count: number
  /** CTA links whose redirect chain ran through a Rooster tracker. */
  tracker_hits: number
  /** CTA links a human has already walked for an S-tag. */
  cta_checked: number
}

export type CtaLink = {
  id: number
  brand_name: string | null
  cta_url: string
  resolved_url: string | null
  resolved_host: string | null
  redirect_hops: number | null
  is_rooster_tracker: boolean
  is_rooster_brand: boolean
  tracker_host: string | null
  unmask_status: string | null
  stag_checked_at: string | null
  stag_found: string | null
}

export type AffiliateFilter = 'affiliates' | 'stag_queue' | 'rooster' | 'audited'

export const FILTERS: ReadonlyArray<{ key: AffiliateFilter; label: string; hint: string }> = [
  { key: 'affiliates', label: 'Confirmed affiliates', hint: 'Sites the model judged to be affiliates' },
  { key: 'stag_queue', label: 'Waiting for S-tags', hint: 'Affiliates with CTA links not yet walked in the browser' },
  { key: 'rooster', label: 'Promotes our brands', hint: 'A Rooster brand appears on the page or in a CTA chain' },
  { key: 'audited', label: 'Everything audited', hint: 'Every site the AI has opened, affiliate or not' },
]

export type AffiliateSummary = {
  screened: number
  audited: number
  affiliates: number
  stagPending: number
  ctaLinks: number
  roosterSites: number
}

export async function loadSummary(): Promise<AffiliateSummary> {
  const svc = createServiceClient()
  const profiles = () => svc.from('website_profiles').select('id', { count: 'exact', head: true })

  const [screened, audited, affiliates, stagPending, roosterSites, ctaLinks] = await Promise.all([
    profiles().not('ai_screened_at', 'is', null),
    profiles().not('ai_crawl_at', 'is', null),
    profiles().eq('ai_is_affiliate', true),
    profiles().eq('manual_stag_status', 'pending'),
    profiles().eq('ai_is_affiliate', true).neq('ai_rooster_brands', '[]'),
    svc.from('website_cta_links').select('id', { count: 'exact', head: true }),
  ])

  return {
    screened: screened.count ?? 0,
    audited: audited.count ?? 0,
    affiliates: affiliates.count ?? 0,
    stagPending: stagPending.count ?? 0,
    roosterSites: roosterSites.count ?? 0,
    ctaLinks: ctaLinks.count ?? 0,
  }
}

export async function loadRecencyBands(): Promise<RecencyBands> {
  const svc = createServiceClient()
  const { data } = await svc.rpc('get_system_setting', { p_key: 'recency_bands_days' })
  return parseRecencyBands(data)
}

export type AffiliateQuery = {
  filter: AffiliateFilter
  q: string
  country: string
  page: number
  size: number
}

export async function queryAffiliates(opts: AffiliateQuery): Promise<{ rows: AffiliateRow[]; total: number }> {
  const svc = createServiceClient()

  let query = svc
    .from('website_profiles')
    .select(
      [
        'id, normalized_domain, ai_is_affiliate, ai_affiliate_reason',
        'ai_brand_count, ai_cta_count, ai_brands, ai_rooster_brands, ai_new_brands',
        'ai_emails, ai_phones, ai_contact_page_url, ai_crawl_at, ai_crawl_status',
        'manual_stag_status, last_seen_at, appearance_count',
      ].join(', '),
      { count: 'exact' },
    )

  switch (opts.filter) {
    case 'affiliates':
      query = query.eq('ai_is_affiliate', true)
      break
    case 'stag_queue':
      query = query.eq('manual_stag_status', 'pending')
      break
    case 'rooster':
      query = query.eq('ai_is_affiliate', true).neq('ai_rooster_brands', '[]')
      break
    case 'audited':
      query = query.not('ai_crawl_at', 'is', null)
      break
  }

  if (opts.q) query = query.ilike('normalized_domain', `%${opts.q.replace(/[%,()]/g, '')}%`)

  const from = (opts.page - 1) * opts.size
  query = query.order('ai_cta_count', { ascending: false, nullsFirst: false })
    .order('ai_crawl_at', { ascending: false, nullsFirst: false })
    .range(from, from + opts.size - 1)

  const { data, count, error } = await query
  if (error) throw new Error(`Failed to load affiliates: ${error.message}`)

  const base = (data ?? []) as unknown as Array<Omit<AffiliateRow, 'country_code' | 'tracker_hits' | 'cta_checked'>>
  if (base.length === 0) return { rows: [], total: count ?? 0 }

  const ids = base.map(r => r.id)

  // Country (from the first lead) + CTA link stats, in two batched queries
  // rather than per row.
  const [{ data: leadRows }, { data: ctaRows }] = await Promise.all([
    svc.from('google_lead_gen_table').select('profile_id, country_code').in('profile_id', ids),
    svc.from('website_cta_links').select('profile_id, is_rooster_tracker, stag_checked_at').in('profile_id', ids),
  ])

  const countryBy = new Map<number, string>()
  for (const r of (leadRows ?? []) as Array<{ profile_id: number; country_code: string | null }>) {
    if (r.country_code && !countryBy.has(r.profile_id)) countryBy.set(r.profile_id, r.country_code)
  }
  const trackerBy = new Map<number, number>()
  const checkedBy = new Map<number, number>()
  for (const r of (ctaRows ?? []) as Array<{ profile_id: number; is_rooster_tracker: boolean; stag_checked_at: string | null }>) {
    if (r.is_rooster_tracker) trackerBy.set(r.profile_id, (trackerBy.get(r.profile_id) ?? 0) + 1)
    if (r.stag_checked_at) checkedBy.set(r.profile_id, (checkedBy.get(r.profile_id) ?? 0) + 1)
  }

  const rows: AffiliateRow[] = base.map(r => ({
    ...r,
    country_code: countryBy.get(r.id) ?? null,
    tracker_hits: trackerBy.get(r.id) ?? 0,
    cta_checked: checkedBy.get(r.id) ?? 0,
  }))

  return { rows, total: count ?? 0 }
}

export async function loadCtaLinks(profileId: number): Promise<CtaLink[]> {
  const svc = createServiceClient()
  const { data } = await svc
    .from('website_cta_links')
    .select('id, brand_name, cta_url, resolved_url, resolved_host, redirect_hops, is_rooster_tracker, is_rooster_brand, tracker_host, unmask_status, stag_checked_at, stag_found')
    .eq('profile_id', profileId)
    .order('is_rooster_tracker', { ascending: false })
    .order('brand_name', { ascending: true, nullsFirst: false })
    .limit(200)
  return (data ?? []) as CtaLink[]
}
