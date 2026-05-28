'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { logActivity } from '@/lib/activity-log'

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
