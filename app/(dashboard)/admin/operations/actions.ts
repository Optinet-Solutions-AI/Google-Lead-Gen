'use server'

import { revalidatePath } from 'next/cache'
import { logActivity } from '@/lib/activity-log'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export type CostUpdateState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

const ALLOWED_KEYS = new Set([
  'proxy_bandwidth_cost_usd_per_gb',
  'fixed_cost_ec2_monthly_usd',
  'fixed_cost_gologin_monthly_usd',
  'fixed_cost_supabase_monthly_usd',
  'fixed_cost_vercel_monthly_usd',
  'fixed_cost_other_monthly_usd',
])

/**
 * Single-purpose updater for the cost settings backing the
 * /admin/operations page. Keeps the page logic dumb — the form
 * just posts a key + amount and this validates the key against
 * the allowlist before calling set_system_setting.
 */
export async function updateCostSettingAction(
  _prev: CostUpdateState,
  fd: FormData,
): Promise<CostUpdateState> {
  const auth = await createServerClient()
  const {
    data: { user },
  } = await auth.auth.getUser()
  if (!user) return { status: 'error', error: 'Not signed in.' }

  const svc = createServiceClient()
  const { data: isAdmin } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (!isAdmin) return { status: 'error', error: 'Admin only.' }

  const key = String(fd.get('key') ?? '').trim()
  if (!ALLOWED_KEYS.has(key)) {
    return { status: 'error', error: `Unknown setting key: ${key}` }
  }

  const raw = String(fd.get('amount') ?? '').trim()
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    return { status: 'error', error: 'Amount must be a non-negative number.' }
  }
  // Store as a number in jsonb. We keep 2 dp of precision since these
  // are dollars / dollars-per-GB — no need for fractional cents.
  const value = Math.round(n * 100) / 100

  const { error } = await svc.rpc('set_system_setting', {
    p_key: key,
    p_value: value,
  })
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: 'operations.cost_setting_updated',
    entity_type: 'system_setting',
    entity_id: key,
    details: { key, value },
  })

  revalidatePath('/admin/operations')
  return { status: 'ok', message: `Updated ${key} to ${value}.` }
}
