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
    is_on_monday: boolean | null
    monday_board: string | null
    monday_item_id: string | null
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
  } | null
  contact: ContactDetail | null
  stags: StagDetail[]
  /** Pre-signed URL to the screenshot PNG, valid ~1h. Null when no
   *  screenshot exists or it's been deleted. */
  screenshot_url: string | null
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
          'is_on_monday, monday_board, monday_item_id',
          'is_affiliate, affiliate_score, affiliate_casino_score, affiliate_confidence',
          'affiliate_external_links, affiliate_indicators',
          'is_rooster_partner, brand, rooster_brands',
          'has_contact_details, has_s_tags, s_tags_checked_at',
          'screenshot_content_link',
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
        's_tag, source_param, brand, tracking_url, final_url, is_existing_on_monday, monday_match_kind, monday_match_item_id',
      )
      .eq('lead_id', leadId)
      .order('id', { ascending: true }),
  ])

  if (leadRes.error) throw new Error(leadRes.error.message)
  if (contactRes.error) throw new Error(contactRes.error.message)
  if (stagsRes.error) throw new Error(stagsRes.error.message)

  const lead = (leadRes.data ?? null) as LeadDetail['lead']

  let screenshotUrl: string | null = null
  if (lead?.screenshot_content_link) {
    const { data: signed } = await svc.storage
      .from('lead-screenshots')
      .createSignedUrl(lead.screenshot_content_link, 60 * 60)
    screenshotUrl = signed?.signedUrl ?? null
  }

  return {
    lead,
    contact: (contactRes.data ?? null) as ContactDetail | null,
    stags: (stagsRes.data ?? []) as StagDetail[],
    screenshot_url: screenshotUrl,
  }
}
