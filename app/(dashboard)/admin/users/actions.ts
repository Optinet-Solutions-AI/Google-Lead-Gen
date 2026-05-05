'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { logActivity } from '@/lib/activity-log'

export type CreateUserState =
  | { status: 'ok'; message: string; email: string }
  | { status: 'error'; error: string }
  | null

/**
 * Verify the caller is an admin. Used by every action in this file —
 * createUser is a privileged operation and we don't trust client-side
 * route gating alone.
 */
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
  const { data, error } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: false, error: 'Admin access required.' }
  return { ok: true, user_id: user.id }
}

export async function createUserAction(
  _prev: CreateUserState,
  fd: FormData,
): Promise<CreateUserState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const email = String(fd.get('email') ?? '').trim().toLowerCase()
  const password = String(fd.get('password') ?? '')
  const isAdminFlag = fd.get('is_admin') === 'on'

  if (!email || !email.includes('@')) {
    return { status: 'error', error: 'Email is required and must look like an email.' }
  }
  if (password.length < 12) {
    return {
      status: 'error',
      error: 'Password must be at least 12 characters.',
    }
  }

  const svc = createServiceClient()
  const { data, error } = await svc.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error) {
    return { status: 'error', error: error.message }
  }
  const newUserId = data.user?.id
  if (!newUserId) {
    return { status: 'error', error: 'createUser succeeded but returned no user id.' }
  }

  // The trigger handle_new_auth_user creates a user_profiles row with
  // is_admin=false by default. Promote if requested.
  if (isAdminFlag) {
    const { error: upErr } = await svc
      .from('user_profiles')
      .update({ is_admin: true, updated_at: new Date().toISOString() })
      .eq('id', newUserId)
    if (upErr) {
      // User created successfully but the admin flag didn't stick —
      // surface the issue rather than swallow.
      return {
        status: 'error',
        error: `User created but failed to mark as admin: ${upErr.message}`,
      }
    }
  }

  await logActivity({
    action: 'admin.create_user',
    entity_type: 'user',
    entity_id: newUserId,
    details: { email, is_admin: isAdminFlag },
  })

  revalidatePath('/admin/users')
  return {
    status: 'ok',
    email,
    message: `Created ${email}${isAdminFlag ? ' (admin)' : ''}. They can sign in with the password you set.`,
  }
}

export type SetAdminState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

export async function setAdminFlagAction(
  _prev: SetAdminState,
  fd: FormData,
): Promise<SetAdminState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const targetId = String(fd.get('user_id') ?? '').trim()
  const value = fd.get('is_admin') === 'on'
  if (!targetId) return { status: 'error', error: 'Missing user_id.' }
  if (targetId === auth.user_id && !value) {
    return {
      status: 'error',
      error: "You can't demote yourself — ask another admin to do it.",
    }
  }

  const svc = createServiceClient()
  const { error } = await svc
    .from('user_profiles')
    .update({ is_admin: value, updated_at: new Date().toISOString() })
    .eq('id', targetId)
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: value ? 'admin.promote_user' : 'admin.demote_user',
    entity_type: 'user',
    entity_id: targetId,
  })

  revalidatePath('/admin/users')
  return {
    status: 'ok',
    message: value ? 'User promoted to admin.' : 'Admin flag cleared.',
  }
}
