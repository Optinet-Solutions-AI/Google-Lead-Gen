'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

// getLeadDetails used to live here as a server action but server actions
// trigger a full page-tree re-render on every call, which made the drawer
// feel sluggish. The fetch was moved to /api/leads/[id] — see
// app/(dashboard)/leads/_lib/detail-query.ts for the shared loader.

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
