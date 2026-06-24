'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyUserPassword } from '@/lib/auth/verify-password'

export type ChangePasswordState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const currentPassword = String(formData.get('current_password') ?? '')
  const newPassword = String(formData.get('new_password') ?? '')
  const confirmPassword = String(formData.get('confirm_password') ?? '')

  if (!currentPassword || !newPassword || !confirmPassword) {
    return { status: 'error', error: 'Fill in all three fields.' }
  }
  // Min length matches the admin-create policy in admin/users/actions.ts.
  // Without parity, an admin-set 12-char password could be downgraded to
  // 8 by the user immediately after first login.
  if (newPassword.length < 12) {
    return { status: 'error', error: 'New password must be at least 12 characters.' }
  }
  if (newPassword !== confirmPassword) {
    return { status: 'error', error: 'New password and confirmation do not match.' }
  }
  if (currentPassword === newPassword) {
    return { status: 'error', error: 'New password must differ from the current one.' }
  }

  const supabase = await createClient()

  // Who are we?
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser()
  if (userError || !user?.email) {
    redirect('/login')
  }

  // Verify the current password against a stateless anon client so the
  // user's session JWT cookies aren't silently rotated by the check.
  const ok = await verifyUserPassword(user.email, currentPassword)
  if (!ok) {
    return { status: 'error', error: 'Current password is incorrect.' }
  }

  const { error: updateError } = await supabase.auth.updateUser({
    password: newPassword,
  })
  if (updateError) {
    return { status: 'error', error: updateError.message }
  }

  return { status: 'ok', message: 'Password updated.' }
}

export type PreferenceState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

/**
 * Flip the per-user "auto-load on scroll" preference. The flag lives
 * on user_profiles; service-role client because the table is locked
 * down with RLS and the dashboard reads it via the same path.
 */
export async function setInfiniteScrollPreference(
  _prev: PreferenceState,
  formData: FormData,
): Promise<PreferenceState> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) return { status: 'error', error: 'Not signed in.' }

  const raw = String(formData.get('value') ?? '').trim().toLowerCase()
  const next = raw === 'true'

  const svc = createServiceClient()
  const { error } = await svc
    .from('user_profiles')
    .update({ infinite_scroll_enabled: next })
    .eq('id', user.id)
  if (error) return { status: 'error', error: error.message }

  // Reset the dashboard tree so any open /leads or /scrape picks up
  // the new value on the next render.
  revalidatePath('/', 'layout')

  return {
    status: 'ok',
    message: next
      ? 'Auto-load on scroll is ON — scrolling past the visible rows fetches more automatically.'
      : 'Auto-load on scroll is OFF — the Rows picker is a hard limit; use the chevrons to page.',
  }
}

/**
 * Per-user "available for CAPTCHA review" preference. When ON, the
 * worker will park CAPTCHA-hit scrapes in needs_human and wait for
 * the user to click through on /admin/interactive. When OFF
 * (default), the worker skips the wait — scrapes either auto-solve
 * via 2Captcha (when enabled) or fail fast — so the user's job
 * queue doesn't stall for 65 minutes when nobody's around to action it.
 */
export async function setAvailableForCaptchaReviewPreference(
  _prev: PreferenceState,
  formData: FormData,
): Promise<PreferenceState> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.id) return { status: 'error', error: 'Not signed in.' }

  const raw = String(formData.get('value') ?? '').trim().toLowerCase()
  const next = raw === 'true'

  const svc = createServiceClient()
  const { error } = await svc
    .from('user_profiles')
    .update({ available_for_captcha_review: next })
    .eq('id', user.id)
  if (error) return { status: 'error', error: error.message }

  revalidatePath('/', 'layout')

  return {
    status: 'ok',
    message: next
      ? 'Available for CAPTCHA review — your CAPTCHA-hit scrapes will wait up to 65 min for you to click through on /admin/interactive.'
      : 'Not available for CAPTCHA review — CAPTCHA-hit scrapes will auto-solve (if 2Captcha is enabled) or fail fast instead of waiting.',
  }
}
