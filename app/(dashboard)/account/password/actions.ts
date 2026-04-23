'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

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
  if (newPassword.length < 8) {
    return { status: 'error', error: 'New password must be at least 8 characters.' }
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

  // Re-authenticate with current password to verify.
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  })
  if (signInError) {
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
