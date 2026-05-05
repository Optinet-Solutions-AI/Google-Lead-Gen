'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { logActivity } from '@/lib/activity-log'

export type CreateUserState =
  | { status: 'ok'; message: string; username: string }
  | { status: 'error'; error: string }
  | null

/**
 * Verify the caller is an admin. Used by every action in this file —
 * createUser is privileged and we don't trust client-side route gating.
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

/** Mirror of the username → email mapping used by the /login flow. */
const EMAIL_DOMAIN = 'rooster.local'
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])?$/

export async function createUserAction(
  _prev: CreateUserState,
  fd: FormData,
): Promise<CreateUserState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const username = String(fd.get('username') ?? '').trim().toLowerCase()
  const displayName = String(fd.get('display_name') ?? '').trim() || null
  const password = String(fd.get('password') ?? '')
  const isAdminFlag = fd.get('is_admin') === 'on'

  if (!username) {
    return { status: 'error', error: 'Username is required.' }
  }
  if (!USERNAME_RE.test(username)) {
    return {
      status: 'error',
      error: 'Username must be 2–32 characters, lowercase a–z / 0–9 / . _ - only.',
    }
  }
  if (password.length < 12) {
    return { status: 'error', error: 'Password must be at least 12 characters.' }
  }

  const svc = createServiceClient()

  // Check the username is free first so we fail before creating an
  // auth.users row that we'd then have to clean up.
  const { data: existing } = await svc
    .from('user_profiles')
    .select('id')
    .ilike('username', username)
    .maybeSingle()
  if (existing) {
    return { status: 'error', error: `Username "${username}" is already taken.` }
  }

  const email = `${username}@${EMAIL_DOMAIN}`

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

  // The on_auth_user_created trigger inserts a user_profiles row with
  // is_admin=false. Update it with the username + display_name + admin
  // flag in one call.
  const { error: upErr } = await svc
    .from('user_profiles')
    .update({
      username,
      display_name: displayName,
      is_admin: isAdminFlag,
      updated_at: new Date().toISOString(),
    })
    .eq('id', newUserId)
  if (upErr) {
    return {
      status: 'error',
      error: `User created but failed to set username/admin flag: ${upErr.message}`,
    }
  }

  await logActivity({
    action: 'admin.create_user',
    entity_type: 'user',
    entity_id: newUserId,
    details: { username, display_name: displayName, is_admin: isAdminFlag },
  })

  revalidatePath('/admin/users')
  return {
    status: 'ok',
    username,
    message: `Created "${username}"${isAdminFlag ? ' (admin)' : ''}. They can sign in with the password you set.`,
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
