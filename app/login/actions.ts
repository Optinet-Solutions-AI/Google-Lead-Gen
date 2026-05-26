'use server'

import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export type LoginState = { error: string } | null

const MAINTENANCE_NOTICE =
  'Hi Everyone, we are doing major revisions in the backend today and the lead gen tool will be temporarily unavailable. Sorry for the inconvenience.'

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
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    // Don't leak Supabase's internal error shape to the UI.
    return { error: 'Invalid username or password.' }
  }

  // Maintenance gate. Admins always get through; everyone else gets the
  // notice and their fresh session is revoked so they can't slip past.
  if (data.user?.id) {
    const svc = createServiceClient()
    const [
      { data: maintRaw },
      { data: isAdmin },
    ] = await Promise.all([
      svc.rpc('get_system_setting', { p_key: 'maintenance_mode' }),
      svc.rpc('is_admin', { p_user_id: data.user.id }),
    ])
    if (maintRaw === true && isAdmin !== true) {
      await supabase.auth.signOut()
      return { error: MAINTENANCE_NOTICE }
    }
  }

  const safeRedirect = isSafePath(from) ? from : '/monday/leads'
  redirect(safeRedirect)
}

function isSafePath(path: string): boolean {
  // Reject CRLF (response-splitting) and backslashes (some browsers
  // collapse `/\example.com` into a protocol-relative URL).
  if (/[\r\n\\]/.test(path)) return false
  return path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/login')
}
