'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

export type LoginState = { error: string } | null

/** Supabase requires email — we map usernames to <username>@rooster.local. */
const EMAIL_DOMAIN = '@rooster.local'

function usernameToEmail(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  return trimmed.includes('@') ? trimmed : `${trimmed}${EMAIL_DOMAIN}`
}

export async function signInAction(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const username = String(formData.get('username') ?? '')
  const password = String(formData.get('password') ?? '')
  const from = String(formData.get('from') ?? '')

  if (!username || !password) {
    return { error: 'Enter both username and password.' }
  }

  const email = usernameToEmail(username)

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    // Don't leak Supabase's internal error shape to the UI.
    return { error: 'Invalid username or password.' }
  }

  const safeRedirect = isSafePath(from) ? from : '/monday/leads'
  redirect(safeRedirect)
}

function isSafePath(path: string): boolean {
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/login')
}
