'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { checkPassword } from '@/lib/auth/password-policy'
import { logActivity } from '@/lib/activity-log'

export type SetPasswordState = { status: 'error'; error: string } | null

/**
 * First-login password change.
 *
 * Deliberately does NOT ask for the current password, unlike
 * /account/password. The person is already holding a valid session that only
 * the temporary password could have produced, so re-typing it proves nothing
 * and gives someone reading it off a screen another chance to mistype it.
 *
 * Clearing the flag needs the service role — it lives in app_metadata
 * precisely so the account cannot clear its own gate.
 */
export async function setInitialPasswordAction(
  _prev: SetPasswordState,
  fd: FormData,
): Promise<SetPasswordState> {
  const password = String(fd.get('new_password') ?? '')
  const confirm = String(fd.get('confirm_password') ?? '')

  if (!password || !confirm) return { status: 'error', error: 'Fill in both fields.' }
  if (password !== confirm) return { status: 'error', error: 'The two passwords do not match.' }

  const check = checkPassword(password)
  if (!check.ok) return { status: 'error', error: check.error }

  const supabase = await createClient()
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser()
  if (userErr || !user) redirect('/login')

  const { error: updErr } = await supabase.auth.updateUser({ password })
  if (updErr) {
    // Supabase rejects a new password identical to the current one.
    return { status: 'error', error: updErr.message }
  }

  const svc = createServiceClient()
  const { error: metaErr } = await svc.auth.admin.updateUserById(user.id, {
    app_metadata: { ...(user.app_metadata ?? {}), must_change_password: false },
  })
  if (metaErr) {
    return {
      status: 'error',
      error: 'Password changed, but the first-login flag could not be cleared. Tell an admin.',
    }
  }

  await logActivity({
    action: 'auth.initial_password_set',
    entity_type: 'user',
    entity_id: user.id,
    details: {},
  })

  redirect('/')
}
