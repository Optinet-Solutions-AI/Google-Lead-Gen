'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

/** All accepted manual values for the Monday duplicate-check label. */
export const MONDAY_LABEL_VALUES = ['no', 'leads', 'affiliate', 'updates', 'clear'] as const
export type MondayLabelValue = (typeof MONDAY_LABEL_VALUES)[number]

function isMondayLabelValue(v: string): v is MondayLabelValue {
  return (MONDAY_LABEL_VALUES as readonly string[]).includes(v)
}

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
  const value = String(formData.get('value') ?? '')
  if (!Number.isFinite(leadId)) throw new Error('Missing lead id.')
  if (!isMondayLabelValue(value)) throw new Error(`Invalid value: ${value}`)

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
