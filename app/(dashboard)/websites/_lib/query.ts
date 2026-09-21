import 'server-only'
import { cache } from 'react'
import { getShadowContext } from '@/lib/shadow-filter'
import { applyShadowFilter } from '@/lib/shadow-filter'
import { createServiceClient } from '@/lib/supabase/service'
import { loadLeadDetail, type LeadDetail } from '../../leads/_lib/detail-query'
import { DEFAULT_RECENCY_BANDS, recencyBand, type RecencyBand } from '@/lib/website-profiles/recency'

/**
 * Everything we know about ONE website.
 *
 * The lead table is a log of SERP appearances: the same website shows up
 * once per keyword, per country, per run. Almost everything an operator
 * wants to know — is it an affiliate, whose brands does it push, who do we
 * email, is it already on Monday — is a fact about the WEBSITE, and was
 * only ever copied onto each of those rows. So this loads the website and
 * treats the lead rows as its appearances.
 */

export type WebsiteProfile = {
  id: number
  normalized_domain: string
  registered_domain: string | null
  display_name: string | null
  first_seen_at: string | null
  last_seen_at: string | null
  appearance_count: number | null
  is_on_monday: boolean | null
  monday_board: string | null
  monday_item_id: string | null
  is_not_relevant: boolean | null
  system_flag: string | null
  system_flag_reason: string | null
  ai_site_description: string | null
  ai_site_category: string | null
  ai_is_affiliate: boolean | null
  ai_affiliate_reason: string | null
  ai_contact_page_url: string | null
  ai_cta_count: number | null
  ai_brand_count: number | null
  // The enrichment verdicts, denormalized onto the profile. Having them
  // here is what lets the summary tiles paint without waiting on the
  // per-lead enrichment fetch.
  is_affiliate: boolean | null
  is_rooster_partner: boolean | null
  brand: string | null
  has_contact_details: boolean | null
  has_s_tags: boolean | null
}

/** One SERP appearance of this website — the genuinely per-row facts. */
export type Appearance = {
  id: number
  keyword: string | null
  country_code: string | null
  result_type: string | null
  seen_on: string | null
  overall_position: number | null
  page_number: number | null
  batch_id: number | null
  scrape_job_id: string | null
  url: string | null
  created_at: string
  is_not_relevant: boolean
  is_relevant: boolean | null
  relevance_reason: string | null
  queued_by_display: string | null
}

/** The cheap half: two indexed queries, enough to paint the whole page
 *  except the evidence cards. */
export type WebsiteSummary = Omit<WebsiteDetail, 'detail'> & {
  /** The lead whose enrichment to load, resolved here so the streamed
   *  half doesn't have to re-query for it. */
  primaryLeadId: number | null
}

export type WebsiteDetail = {
  profile: WebsiteProfile | null
  /** The domain as asked for, normalized — shown even when no profile row
   *  exists yet (a lead can predate the profile backfill). */
  domain: string
  appearances: Appearance[]
  /** Every lead id for this website, for the page's website-wide actions. */
  leadIds: number[]
  /** The lead whose enrichment we display. Contacts and s-tags are stored
   *  per lead row, so the newest row that actually HAS them is the one
   *  worth showing — the newest row overall is often an un-enriched
   *  re-sighting. */
  detail: LeadDetail | null
  /** Colour band for the recency dot. Computed here rather than in the
   *  page because it reads the clock, which render must not. */
  recency: RecencyBand
  lastSeenAt: string | null
}

/**
 * How many appearances to fetch.
 *
 * Was 500, which cost ~2.3s of the page's time to first byte on a site
 * like gambling.com for rows nobody sees — the table scrolls in a 560px
 * box. The header still reports the true total from the profile, so
 * capping here understates nothing.
 */
const APPEARANCE_LIMIT = 100

/** Strip scheme, www and any path so a pasted URL resolves like a domain. */
export function normalizeDomain(raw: string): string {
  return decodeURIComponent(raw)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.+$/, '')
}

/**
 * Everything the page can show without waiting on enrichment.
 *
 * loadLeadDetail costs three more round trips plus a cohort RPC, a
 * Monday-candidate search and a signed URL per screenshot — around three
 * seconds before anything reached the browser. The header, the verdict
 * tiles and the appearances table need none of it, so they come from
 * here and the rest streams in behind a Suspense boundary.
 */
export async function loadWebsiteSummary(rawDomain: string): Promise<WebsiteSummary> {
  const domain = normalizeDomain(rawDomain)
  if (!domain) {
    return {
      profile: null,
      domain: '',
      appearances: [],
      leadIds: [],
      primaryLeadId: null,
      recency: recencyBand(null, DEFAULT_RECENCY_BANDS, Date.now()),
      lastSeenAt: null,
    }
  }

  const svc = createServiceClient()
  const shadowCtx = await getShadowContext()

  // The profile is the canonical row, but a lead can exist without one
  // (scraped before the backfill), so neither side is required.
  const profileP = svc
    .from('website_profiles')
    .select(
      [
        'id, normalized_domain, registered_domain, display_name',
        'first_seen_at, last_seen_at, appearance_count',
        'is_on_monday, monday_board, monday_item_id',
        'is_not_relevant, system_flag, system_flag_reason',
        'ai_site_description, ai_site_category',
        'ai_is_affiliate, ai_affiliate_reason, ai_contact_page_url',
        'ai_cta_count, ai_brand_count',
        'is_affiliate, is_rooster_partner, brand, has_contact_details, has_s_tags',
      ].join(', '),
    )
    .eq('normalized_domain', domain)
    .maybeSingle()

  const profileRes = await profileP
  if (profileRes.error) throw new Error(profileRes.error.message)
  const profileRow = (profileRes.data as unknown as WebsiteProfile | null) ?? null

  // Appearances hang off profile_id, NOT the lead's own `domain` column —
  // that one stores the full origin ("https://www.example.com"), so
  // matching a bare domain against it finds nothing. Every lead row has a
  // profile id, so this is exact rather than a string guess.
  let leadsQ = svc
    .from('google_lead_gen_table')
    .select(
      [
        'id, keyword, country_code, result_type, seen_on',
        'overall_position, page_number, batch_id, scrape_job_id, url, created_at',
        'is_not_relevant, is_relevant, relevance_reason',
        'has_s_tags, has_contact_details',
        'scrape_queue:scrape_queue!scrape_job_id(created_by_display)',
      ].join(', '),
    )
    .eq('profile_id', profileRow?.id ?? -1)
    .order('created_at', { ascending: false })
    .limit(APPEARANCE_LIMIT)
  leadsQ = applyShadowFilter(leadsQ, shadowCtx) as typeof leadsQ

  const leadsRes = profileRow ? await leadsQ : { data: [], error: null }
  if (leadsRes.error) throw new Error(leadsRes.error.message)

  const rawLeads = (leadsRes.data ?? []) as unknown as Array<
    Appearance & {
      has_s_tags: boolean | null
      has_contact_details: boolean | null
      scrape_queue: { created_by_display: string | null } | null
    }
  >

  const appearances: Appearance[] = rawLeads.map(r => ({
    id: r.id,
    keyword: r.keyword,
    country_code: r.country_code,
    result_type: r.result_type,
    seen_on: r.seen_on,
    overall_position: r.overall_position,
    page_number: r.page_number,
    batch_id: r.batch_id,
    scrape_job_id: r.scrape_job_id,
    url: r.url,
    created_at: r.created_at,
    is_not_relevant: r.is_not_relevant,
    is_relevant: r.is_relevant,
    relevance_reason: r.relevance_reason,
    queued_by_display: r.scrape_queue?.created_by_display ?? null,
  }))

  // Enriched data hangs off whichever lead row the enrichment ran against,
  // and a re-sighting inherits the booleans without the rows. Prefer the
  // newest row that actually carries something.
  const enriched = rawLeads.find(r => r.has_s_tags === true || r.has_contact_details === true)
  const primary = enriched ?? rawLeads[0]

  const lastSeenAt = profileRow?.last_seen_at ?? appearances[0]?.created_at ?? null

  return {
    profile: profileRow,
    domain,
    appearances,
    leadIds: rawLeads.map(r => r.id),
    primaryLeadId: primary?.id ?? null,
    recency: recencyBand(lastSeenAt, DEFAULT_RECENCY_BANDS, Date.now()),
    lastSeenAt,
  }
}

/** The expensive half — contacts, s-tags, owner network, screenshots.
 *  Streamed, so a slow cohort RPC never holds up the page.
 *
 *  Wrapped in React's `cache` because the page awaits it from two
 *  Suspense boundaries (the actions and the evidence cards); without it
 *  they would each pay the full cost. */
export const loadWebsiteEnrichment = cache(
  async (primaryLeadId: number | null): Promise<LeadDetail | null> => {
    if (!primaryLeadId) return null
    try {
      return await loadLeadDetail(primaryLeadId)
    } catch (e) {
      console.error('[loadWebsiteEnrichment]', e)
      return null
    }
  },
)

/** Resolve a lead id to its website, so old `?lead=<id>` permalinks still
 *  land somewhere useful now that the per-lead drawer is gone. */
export async function domainForLead(leadId: number): Promise<string | null> {
  if (!Number.isInteger(leadId) || leadId <= 0) return null
  const svc = createServiceClient()
  const { data } = await svc
    .from('google_lead_gen_table')
    .select('domain, url')
    .eq('id', leadId)
    .maybeSingle()
  const row = data as { domain: string | null; url: string | null } | null
  const raw = row?.domain || row?.url || ''
  const d = normalizeDomain(raw)
  return d || null
}
