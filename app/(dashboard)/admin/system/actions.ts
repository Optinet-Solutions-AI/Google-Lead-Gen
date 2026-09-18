'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { logActivity } from '@/lib/activity-log'
import { BYTES_PER_GB } from '@/lib/proxy-bandwidth'

export type SettingState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

async function requireAdmin(): Promise<
  | { ok: true; user_id: string }
  | { ok: false; error: string }
> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const svc = createServiceClient()
  const { data: adminFlag, error } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (error) return { ok: false, error: error.message }
  if (!adminFlag) return { ok: false, error: 'Admin access required.' }

  return { ok: true, user_id: user.id }
}

export async function setCaptchaSolverEnabledAction(
  _prev: SettingState,
  fd: FormData,
): Promise<SettingState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  // FormData carries the desired NEW value as 'true' / 'false' from the
  // toggle button. We coerce to a strict boolean before storing so the
  // JSONB column always holds the same shape for the worker to read.
  const raw = String(fd.get('value') ?? '').trim().toLowerCase()
  const next = raw === 'true'

  const svc = createServiceClient()
  const { error } = await svc.rpc('set_system_setting', {
    p_key: 'captcha_solver_enabled',
    p_value: next,
  })
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: next ? 'system_settings.captcha_solver_enable' : 'system_settings.captcha_solver_disable',
    entity_type: 'system_setting',
    entity_id: null,
    details: { key: 'captcha_solver_enabled', value: next },
  })

  revalidatePath('/admin/system')
  return {
    status: 'ok',
    message: next
      ? 'Captcha solver is now ON — captchas park to /admin/interactive instead of failing the job.'
      : 'Captcha solver is now OFF — captchas will fail the job (status=captcha) instead of waiting for a human.',
  }
}

export async function setCaptchaAutoSolveEnabledAction(
  _prev: SettingState,
  fd: FormData,
): Promise<SettingState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const raw = String(fd.get('value') ?? '').trim().toLowerCase()
  const next = raw === 'true'

  const svc = createServiceClient()
  const { error } = await svc.rpc('set_system_setting', {
    p_key: 'captcha_auto_solve',
    p_value: next,
  })
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: next
      ? 'system_settings.captcha_auto_solve_enable'
      : 'system_settings.captcha_auto_solve_disable',
    entity_type: 'system_setting',
    entity_id: null,
    details: { key: 'captcha_auto_solve', value: next },
  })

  revalidatePath('/admin/system')
  return {
    status: 'ok',
    message: next
      ? 'Auto-solve is now ON — captchas are sent to 2Captcha automatically. Each solve costs credits.'
      : 'Auto-solve is now OFF — captchas are no longer sent to 2Captcha.',
  }
}

export async function setMaintenanceModeAction(
  _prev: SettingState,
  fd: FormData,
): Promise<SettingState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const raw = String(fd.get('value') ?? '').trim().toLowerCase()
  const next = raw === 'true'

  const svc = createServiceClient()
  const { error } = await svc.rpc('set_system_setting', {
    p_key: 'maintenance_mode',
    p_value: next,
  })
  if (error) return { status: 'error', error: error.message }

  // Boot every non-admin session on enable so they get redirected to
  // /maintenance immediately instead of waiting for their next request.
  let kicked = 0
  if (next) {
    const { data: kickCount, error: kickErr } = await svc.rpc('force_logout_non_admins')
    if (kickErr) {
      // Non-fatal — the layout gate will still catch them on next request.
      console.error('[maintenance] force_logout_non_admins failed:', kickErr)
    } else if (typeof kickCount === 'number') {
      kicked = kickCount
    }
  }

  await logActivity({
    action: next ? 'system_settings.maintenance_enable' : 'system_settings.maintenance_disable',
    entity_type: 'system_setting',
    entity_id: null,
    details: { key: 'maintenance_mode', value: next, kicked },
  })

  revalidatePath('/admin/system')
  revalidatePath('/', 'layout')
  return {
    status: 'ok',
    message: next
      ? `Maintenance mode ON — non-admin sessions cleared (${kicked}) and sign-ins blocked.`
      : 'Maintenance mode OFF — everyone can sign back in.',
  }
}

export async function setProxyBandwidthConfigAction(
  _prev: SettingState,
  fd: FormData,
): Promise<SettingState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  // Inputs are in GB (what the operator reads off the proxy plan). Parse
  // leniently, then convert to the bytes the rest of the feature stores.
  const limitGb = Number(String(fd.get('limit_gb') ?? '').trim())
  const thresholdGb = Number(String(fd.get('threshold_gb') ?? '').trim())

  if (!Number.isFinite(limitGb) || limitGb <= 0) {
    return { status: 'error', error: 'Plan size must be a positive number of GB.' }
  }
  if (!Number.isFinite(thresholdGb) || thresholdGb < 0) {
    return { status: 'error', error: 'Low-balance threshold must be 0 or more GB.' }
  }
  if (thresholdGb >= limitGb) {
    return { status: 'error', error: 'Low-balance threshold must be smaller than the plan size.' }
  }

  const limitBytes = Math.round(limitGb * BYTES_PER_GB)
  const thresholdBytes = Math.round(thresholdGb * BYTES_PER_GB)

  const svc = createServiceClient()
  const { error: limitErr } = await svc.rpc('set_system_setting', {
    p_key: 'proxy_bandwidth_limit_bytes',
    p_value: limitBytes,
  })
  if (limitErr) return { status: 'error', error: limitErr.message }
  const { error: thrErr } = await svc.rpc('set_system_setting', {
    p_key: 'proxy_bandwidth_low_threshold_bytes',
    p_value: thresholdBytes,
  })
  if (thrErr) return { status: 'error', error: thrErr.message }

  await logActivity({
    action: 'system_settings.proxy_bandwidth_config',
    entity_type: 'system_setting',
    entity_id: null,
    details: { limit_bytes: limitBytes, threshold_bytes: thresholdBytes },
  })

  revalidatePath('/admin/system')
  revalidatePath('/') // dashboard card reads the threshold label
  return {
    status: 'ok',
    message: `Saved — plan size ${limitGb} GB, warns below ${thresholdGb} GB. The balance refreshes from GoLogin every 30 minutes.`,
  }
}

/**
 * Website profile controls: verdict expiry per check, recency colour bands,
 * one-row-per-website dedupe, and the OpenAI non-affiliate flag pass.
 */
export async function setWebsiteProfileConfigAction(
  _prev: SettingState,
  fd: FormData,
): Promise<SettingState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const days = (name: string) => {
    const n = Number(String(fd.get(name) ?? '').trim())
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : NaN
  }
  const ttl = {
    affiliate: days('ttl_affiliate'),
    rooster: days('ttl_rooster'),
    contact: days('ttl_contact'),
    stags: days('ttl_stags'),
  }
  const bands = { fresh: days('band_fresh'), recent: days('band_recent'), aging: days('band_aging') }

  if (Object.values(ttl).some(Number.isNaN)) {
    return { status: 'error', error: 'Every expiry must be a whole number of days, 1 or more.' }
  }
  if (Object.values(bands).some(Number.isNaN)) {
    return { status: 'error', error: 'Every recency band must be a whole number of days, 1 or more.' }
  }
  if (!(bands.fresh < bands.recent && bands.recent < bands.aging)) {
    return { status: 'error', error: 'Recency bands must increase: fresh < recent < aging.' }
  }

  const dedupe = fd.get('dedupe') === 'on'
  const llmFlag = fd.get('llm_flag') === 'on'

  const svc = createServiceClient()
  const writes: Array<[string, unknown]> = [
    ['verdict_ttl_days', ttl],
    ['recency_bands_days', bands],
    ['profile_dedupe_enabled', dedupe],
    ['system_flag_llm_enabled', llmFlag],
  ]
  for (const [key, value] of writes) {
    const { error } = await svc.rpc('set_system_setting', { p_key: key, p_value: value })
    if (error) return { status: 'error', error: `${key}: ${error.message}` }
  }

  await logActivity({
    action: 'system_settings.website_profile_config',
    entity_type: 'system_setting',
    entity_id: null,
    details: { ttl, bands, dedupe, llm_flag: llmFlag },
  })

  revalidatePath('/admin/system')
  revalidatePath('/leads')
  revalidatePath('/monday/search')
  return {
    status: 'ok',
    message: `Saved — affiliate ${ttl.affiliate}d, rooster ${ttl.rooster}d, contacts ${ttl.contact}d, s-tags ${ttl.stags}d; bands ${bands.fresh}/${bands.recent}/${bands.aging}; dedupe ${dedupe ? 'on' : 'off'}; OpenAI flag ${llmFlag ? 'on' : 'off'}.`,
  }
}
