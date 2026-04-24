'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

// ============================================================
// Detail fetch — used by the row-detail drawer on /leads & /scrape/[id]
// ============================================================

type ContactRow = {
  emails: string[] | null
  phones: string[] | null
  contact_page_url: string | null
  source: string
  raw: unknown
}

type StagRow = {
  s_tag: string
  source_param: string | null
  brand: string | null
  tracking_url: string | null
  final_url: string | null
  is_existing_on_monday: boolean | null
  monday_match_kind: string | null
  monday_match_item_id: string | null
}

type LeadDetail = {
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
  } | null
  contact: ContactRow | null
  stags: StagRow[]
}

export async function getLeadDetails(leadId: number): Promise<LeadDetail> {
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

  return {
    lead: (leadRes.data ?? null) as LeadDetail['lead'],
    contact: (contactRes.data ?? null) as ContactRow | null,
    stags: (stagsRes.data ?? []) as StagRow[],
  }
}

type MondayLabelValue = 'no' | 'leads' | 'affiliate' | 'updates' | 'clear'

const VALID: ReadonlySet<string> = new Set([
  'no',
  'leads',
  'affiliate',
  'updates',
  'clear',
])

/**
 * Set the Monday match label for a single lead row.
 *
 * - 'clear' — reverts to the not-yet-checked state (auto re-run will pick it up again)
 * - 'no'    — explicitly marks the row as not on Monday
 * - 'leads' / 'affiliate' / 'updates' — manual override; auto re-runs leave it alone
 */
export async function setMondayLabel(formData: FormData): Promise<void> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in.')

  const leadId = Number(formData.get('lead_id'))
  const rawValue = String(formData.get('value') ?? '')
  if (!Number.isFinite(leadId)) throw new Error('Missing lead id.')
  if (!VALID.has(rawValue)) throw new Error(`Invalid value: ${rawValue}`)
  const value = rawValue as MondayLabelValue

  const svc = createServiceClient()

  let patch: Record<string, unknown>
  switch (value) {
    case 'clear':
      patch = {
        is_on_monday: null,
        monday_board: null,
        monday_item_id: null,
        monday_overridden_at: null,
      }
      break
    case 'no':
      patch = {
        is_on_monday: false,
        monday_board: null,
        monday_item_id: null,
        monday_overridden_at: new Date().toISOString(),
      }
      break
    default:
      patch = {
        is_on_monday: true,
        monday_board: value,
        monday_overridden_at: new Date().toISOString(),
      }
  }

  const { error } = await svc.from('google_lead_gen_table').update(patch).eq('id', leadId)
  if (error) throw new Error(error.message)

  revalidatePath('/leads')
  revalidatePath('/scrape', 'layout')
}

// ============================================================
// Generic boolean-flag override (used by 7.2–7.6 editors)
// ============================================================

const BOOL_VALUES: ReadonlySet<string> = new Set(['yes', 'no', 'clear'])

async function setBooleanFlag(params: {
  leadId: number
  value: string
  valueColumn: string
  overrideColumn: string
  extraPatch?: Record<string, unknown>
}) {
  const { leadId, value, valueColumn, overrideColumn, extraPatch } = params
  if (!Number.isFinite(leadId)) throw new Error('Missing lead id.')
  if (!BOOL_VALUES.has(value)) throw new Error(`Invalid value: ${value}`)

  const svc = createServiceClient()
  let patch: Record<string, unknown>
  switch (value) {
    case 'clear':
      patch = { [valueColumn]: null, [overrideColumn]: null, ...(extraPatch ?? {}) }
      break
    case 'yes':
      patch = { [valueColumn]: true, [overrideColumn]: new Date().toISOString() }
      break
    default: // 'no'
      patch = { [valueColumn]: false, [overrideColumn]: new Date().toISOString() }
  }

  const { error } = await svc.from('google_lead_gen_table').update(patch).eq('id', leadId)
  if (error) throw new Error(error.message)

  revalidatePath('/leads')
  revalidatePath('/scrape', 'layout')
}

async function assertSignedIn(): Promise<void> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in.')
}

export async function setAffiliateLabel(formData: FormData): Promise<void> {
  await assertSignedIn()
  await setBooleanFlag({
    leadId: Number(formData.get('lead_id')),
    value: String(formData.get('value') ?? ''),
    valueColumn: 'is_affiliate',
    overrideColumn: 'is_affiliate_overridden_at',
  })
}

export async function setRoosterLabel(formData: FormData): Promise<void> {
  await assertSignedIn()
  await setBooleanFlag({
    leadId: Number(formData.get('lead_id')),
    value: String(formData.get('value') ?? ''),
    valueColumn: 'is_rooster_partner',
    overrideColumn: 'is_rooster_overridden_at',
  })
}

export async function setContactLabel(formData: FormData): Promise<void> {
  await assertSignedIn()
  await setBooleanFlag({
    leadId: Number(formData.get('lead_id')),
    value: String(formData.get('value') ?? ''),
    valueColumn: 'has_contact_details',
    overrideColumn: 'is_contact_overridden_at',
  })
}

export async function setStagLabel(formData: FormData): Promise<void> {
  await assertSignedIn()
  await setBooleanFlag({
    leadId: Number(formData.get('lead_id')),
    value: String(formData.get('value') ?? ''),
    valueColumn: 'has_s_tags',
    overrideColumn: 'is_stag_overridden_at',
  })
}

/**
 * S-tag verification = "has the duplicate-check run on this lead's tags?"
 * Uses s_tags_checked_at as the flag. `yes` sets the timestamp to now
 * (marking it manually verified), `no`/`clear` nulls it.
 */
export async function setStagVerifiedLabel(formData: FormData): Promise<void> {
  await assertSignedIn()
  const leadId = Number(formData.get('lead_id'))
  const value = String(formData.get('value') ?? '')
  if (!Number.isFinite(leadId)) throw new Error('Missing lead id.')
  if (!BOOL_VALUES.has(value)) throw new Error(`Invalid value: ${value}`)

  const svc = createServiceClient()
  const now = new Date().toISOString()
  const patch: Record<string, unknown> =
    value === 'clear'
      ? { s_tags_checked_at: null }
      : value === 'yes'
        ? { s_tags_checked_at: now }
        : { s_tags_checked_at: null } // 'no' = mark as not-verified

  const { error } = await svc
    .from('google_lead_gen_table')
    .update(patch)
    .eq('id', leadId)
  if (error) throw new Error(error.message)

  revalidatePath('/leads')
  revalidatePath('/scrape', 'layout')
}
