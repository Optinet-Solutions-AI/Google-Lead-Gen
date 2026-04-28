'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { logActivity } from '@/lib/activity-log'

// getLeadDetails used to live here as a server action but server actions
// trigger a full page-tree re-render on every call, which made the drawer
// feel sluggish. The fetch was moved to /api/leads/[id] — see
// app/(dashboard)/leads/_lib/detail-query.ts for the shared loader.

/**
 * Delete the screenshot attached to a lead. Removes the file from
 * Supabase Storage and clears the screenshot_*_link columns. Used by
 * the "Delete screenshot" button in the row-detail drawer.
 */
export async function deleteLeadScreenshot(formData: FormData): Promise<void> {
  await assertSignedIn()
  const leadId = Number(formData.get('lead_id'))
  if (!Number.isFinite(leadId)) throw new Error('Missing lead id.')

  const svc = createServiceClient()
  const { data: lead, error: readErr } = await svc
    .from('google_lead_gen_table')
    .select('screenshot_content_link')
    .eq('id', leadId)
    .maybeSingle()
  if (readErr) throw new Error(readErr.message)

  const path = (lead as { screenshot_content_link: string | null } | null)?.screenshot_content_link
  if (path) {
    // Best-effort delete — even if the storage object's gone we still
    // want to clear the DB columns.
    try {
      await svc.storage.from('lead-screenshots').remove([path])
    } catch {
      /* ignore */
    }
  }

  const { error: updErr } = await svc
    .from('google_lead_gen_table')
    .update({ screenshot_content_link: null, screenshot_view_link: null })
    .eq('id', leadId)
  if (updErr) throw new Error(updErr.message)

  await logActivity({
    action: 'screenshot.delete',
    entity_type: 'lead',
    entity_id: leadId,
    details: { had_path: path !== null },
  })

  revalidatePath('/leads')
  revalidatePath('/scrape', 'layout')
}

type MondayLabelValue =
  | 'no'
  | 'clear'
  | 'affiliates'
  | 'affiliates_updates'
  | 'leads'
  | 'leads_updates'
  | 'not_relevant_leads'
  | 'not_relevant_leads_updates'
  | 'email_undelivered_leads'
  | 'email_undelivered_leads_updates'

const VALID: ReadonlySet<string> = new Set([
  'no',
  'clear',
  'affiliates',
  'affiliates_updates',
  'leads',
  'leads_updates',
  'not_relevant_leads',
  'not_relevant_leads_updates',
  'email_undelivered_leads',
  'email_undelivered_leads_updates',
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
      // One of the 8 granular categories
      patch = {
        is_on_monday: true,
        monday_board: value,
        monday_overridden_at: new Date().toISOString(),
      }
  }

  const { error } = await svc.from('google_lead_gen_table').update(patch).eq('id', leadId)
  if (error) throw new Error(error.message)

  await logActivity({
    action: 'override.monday',
    entity_type: 'lead',
    entity_id: leadId,
    details: { value },
  })

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
  logAction: string
  extraPatch?: Record<string, unknown>
}) {
  const { leadId, value, valueColumn, overrideColumn, logAction, extraPatch } = params
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

  await logActivity({
    action: logAction,
    entity_type: 'lead',
    entity_id: leadId,
    details: { value },
  })

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
    logAction: 'override.affiliate',
  })
}

export async function setRoosterLabel(formData: FormData): Promise<void> {
  await assertSignedIn()
  await setBooleanFlag({
    leadId: Number(formData.get('lead_id')),
    value: String(formData.get('value') ?? ''),
    valueColumn: 'is_rooster_partner',
    overrideColumn: 'is_rooster_overridden_at',
    logAction: 'override.rooster',
  })
}

export async function setContactLabel(formData: FormData): Promise<void> {
  await assertSignedIn()
  await setBooleanFlag({
    leadId: Number(formData.get('lead_id')),
    value: String(formData.get('value') ?? ''),
    valueColumn: 'has_contact_details',
    overrideColumn: 'is_contact_overridden_at',
    logAction: 'override.contact',
  })
}

export async function setStagLabel(formData: FormData): Promise<void> {
  await assertSignedIn()
  await setBooleanFlag({
    leadId: Number(formData.get('lead_id')),
    value: String(formData.get('value') ?? ''),
    valueColumn: 'has_s_tags',
    overrideColumn: 'is_stag_overridden_at',
    logAction: 'override.stag',
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

  await logActivity({
    action: 'override.stag_verified',
    entity_type: 'lead',
    entity_id: leadId,
    details: { value },
  })

  revalidatePath('/leads')
  revalidatePath('/scrape', 'layout')
}
