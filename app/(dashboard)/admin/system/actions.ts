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

export async function setHitlEnabledAction(
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
    p_key: 'hitl_enabled',
    p_value: next,
  })
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: next ? 'system_settings.hitl_enable' : 'system_settings.hitl_disable',
    entity_type: 'system_setting',
    entity_id: null,
    details: { key: 'hitl_enabled', value: next },
  })

  revalidatePath('/admin/system')
  return {
    status: 'ok',
    message: next
      ? 'HITL captcha resolver is now ON — captchas park to /admin/interactive instead of failing the job.'
      : 'HITL captcha resolver is now OFF — captchas will fail the job (status=captcha) instead of waiting for a human.',
  }
}
