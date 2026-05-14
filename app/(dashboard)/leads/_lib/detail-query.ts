import 'server-only'
import { createServiceClient } from '@/lib/supabase/service'

export type ContactDetail = {
  emails: string[] | null
  phones: string[] | null
  contact_page_url: string | null
  source: string
  raw: unknown
}

export type StagDetail = {
  s_tag: string
  source_param: string | null
  brand: string | null
  tracking_url: string | null
  final_url: string | null
  is_existing_on_monday: boolean | null
  monday_match_kind: string | null
  monday_match_item_id: string | null
  redirect_chain: string[] | null
  screenshot_path: string | null
  /** Pre-signed URL for the per-tag landing-page screenshot. */
  screenshot_url?: string | null
  is_rooster_brand: boolean | null
}

export type LeadDetail = {
  lead: {
    id: number
    url: string | null
    domain: string | null
    keyword: string | null
    country: string | null
    country_code: string | null
    result_type: string | null
    batch_id: number | null
    created_at: string
    scrape_job_id: string | null
    /** Display name of the user who queued the scrape that produced this lead. */
    queued_by_display: string | null
    queued_by_username: string | null
    is_on_monday: boolean | null
    monday_board: string | null
    monday_item_id: string | null
    /** How the match was found: 'exact', 'registered' (subdomain
     *  variant), or 'mentioned_in_updates' (domain found in a board
     *  comment/post). Null when the lead isn't on Monday. */
    monday_match_kind: string | null
    is_affiliate: boolean | null
    affiliate_score: number | null
    affiliate_casino_score: number | null
    affiliate_confidence: string | null
    affiliate_external_links: number | null
    affiliate_indicators: string[] | null
    is_rooster_partner: boolean | null
    brand: string | null
    rooster_brands: Array<{ domain: string; brand_name: string | null; monday_item_id: string | null }> | null
    has_contact_details: boolean | null
    has_s_tags: boolean | null
    s_tags_checked_at: string | null
    screenshot_content_link: string | null
    pushed_to_monday_at: string | null
    monday_pushed_item_id: string | null
    monday_pushed_by: string | null
    is_not_relevant: boolean
    not_relevant_marked_at: string | null
    not_relevant_marked_by: string | null
    serp_screenshot_path: string | null
  } | null
  contact: ContactDetail | null
  stags: StagDetail[]
  /** Pre-signed URL to the landing-page screenshot PNG (captured during
   *  enrichment), valid ~1h. Null when no screenshot exists or it's
   *  been deleted. */
  screenshot_url: string | null
  /** Pre-signed URL to the SERP-time ad screenshot for PPC rows
   *  (captured at scrape time, the small ad creative as seen on
   *  Google). Null for organic rows or when the capture failed. */
  serp_screenshot_url: string | null
}

export async function loadLeadDetail(leadId: number): Promise<LeadDetail> {
  if (!Number.isFinite(leadId)) throw new Error('Missing lead id.')
  const svc = createServiceClient()

  const [leadRes, contactRes, stagsRes] = await Promise.all([
    svc
      .from('google_lead_gen_table')
      .select(
        [
          'id, url, domain, keyword, country, country_code, result_type, batch_id, created_at',
          'scrape_job_id',
          'is_on_monday, monday_board, monday_item_id, monday_match_kind',
          'is_affiliate, affiliate_score, affiliate_casino_score, affiliate_confidence',
          'affiliate_external_links, affiliate_indicators',
          'is_rooster_partner, brand, rooster_brands',
          'has_contact_details, has_s_tags, s_tags_checked_at',
          'screenshot_content_link, serp_screenshot_path',
          'pushed_to_monday_at, monday_pushed_item_id, monday_pushed_by',
          'is_not_relevant, not_relevant_marked_at, not_relevant_marked_by',
          // FK join — pull the queueing user's display + username so the
          // drawer can show "Queued by …" without a second round-trip.
          'scrape_queue:scrape_queue!scrape_job_id(created_by_username, created_by_display)',
        ].join(', '),
      )
      .eq('id', leadId)
      .maybeSingle(),
    svc
      .from('contact_table')
      .select('emails, phones, contact_page_url, source, raw')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    svc
      .from('s_tags_table')
      .select(
        [
          's_tag, source_param, brand',
          'tracking_url, final_url',
          'is_existing_on_monday, monday_match_kind, monday_match_item_id',
          'redirect_chain, screenshot_path, is_rooster_brand',
        ].join(', '),
      )
      .eq('lead_id', leadId)
      .order('id', { ascending: true }),
  ])

  if (leadRes.error) throw new Error(leadRes.error.message)
  if (contactRes.error) throw new Error(contactRes.error.message)
  if (stagsRes.error) throw new Error(stagsRes.error.message)

  // Flatten the joined scrape_queue object into top-level queued_by_* fields
  // before handing the row off to the typed LeadDetail['lead'] shape.
  const rawLead = leadRes.data as
    | (Record<string, unknown> & {
        scrape_queue: { created_by_username: string | null; created_by_display: string | null } | null
      })
    | null
  const lead = (rawLead
    ? (() => {
        const { scrape_queue, ...rest } = rawLead
        return {
          ...rest,
          queued_by_username: scrape_queue?.created_by_username ?? null,
          queued_by_display: scrape_queue?.created_by_display ?? null,
        }
      })()
    : null) as LeadDetail['lead']

  // Screenshot signing is best-effort: a single bucket hiccup or
  // missing/expired object shouldn't blow up the entire drawer load.
  // The drawer renders fine with null URLs (hides the image block).
  async function sign(path: string): Promise<string | null> {
    try {
      const { data } = await svc.storage
        .from('lead-screenshots')
        .createSignedUrl(path, 60 * 60)
      return data?.signedUrl ?? null
    } catch {
      return null
    }
  }

  const [screenshotUrl, serpScreenshotUrl] = await Promise.all([
    lead?.screenshot_content_link ? sign(lead.screenshot_content_link) : Promise.resolve(null),
    lead?.serp_screenshot_path ? sign(lead.serp_screenshot_path) : Promise.resolve(null),
  ])

  const stags = (stagsRes.data ?? []) as unknown as StagDetail[]
  await Promise.all(
    stags.map(async tag => {
      tag.screenshot_url = tag.screenshot_path ? await sign(tag.screenshot_path) : null
    }),
  )

  return {
    lead,
    contact: (contactRes.data ?? null) as ContactDetail | null,
    stags,
    screenshot_url: screenshotUrl,
    serp_screenshot_url: serpScreenshotUrl,
  }
}
