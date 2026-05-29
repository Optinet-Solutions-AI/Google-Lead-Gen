'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { logActivity } from '@/lib/activity-log'

export type CredentialFormState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function requireSignedIn(): Promise<
  | { ok: true; user_id: string; user_email: string | null; display: string | null }
  | { ok: false; error: string }
> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const svc = createServiceClient()
  const { data: profileRow } = await svc
    .from('user_profiles')
    .select('username, display_name')
    .eq('id', user.id)
    .maybeSingle()
  const profile = profileRow as { username: string | null; display_name: string | null } | null
  const display = profile?.display_name ?? profile?.username ?? user.email ?? null

  return { ok: true, user_id: user.id, user_email: user.email ?? null, display }
}

async function requireAdmin(): Promise<
  | { ok: true; user_id: string; user_email: string | null; display: string | null }
  | { ok: false; error: string }
> {
  const auth = await requireSignedIn()
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const { data: adminFlag, error: adminErr } = await svc.rpc('is_admin', { p_user_id: auth.user_id })
  if (adminErr) return { ok: false, error: adminErr.message }
  if (!adminFlag) return { ok: false, error: 'Admin access required.' }

  return auth
}

export async function setCredentialAction(
  _prev: CredentialFormState,
  fd: FormData,
): Promise<CredentialFormState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const countryCode = String(fd.get('country_code') ?? '').trim().toUpperCase()
  const email = String(fd.get('email') ?? '').trim().toLowerCase()
  const password = String(fd.get('password') ?? '')
  const notes = String(fd.get('notes') ?? '').trim() || null

  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) {
    return { status: 'error', error: 'Country code must be a 2-letter ISO code (e.g. DE).' }
  }
  if (!email) return { status: 'error', error: 'Email is required.' }
  if (!EMAIL_RE.test(email)) {
    return { status: 'error', error: 'That doesn\'t look like a valid email address.' }
  }
  if (!password) return { status: 'error', error: 'Password is required.' }

  const svc = createServiceClient()
  const { error } = await svc.rpc('set_google_login_credential', {
    p_country_code: countryCode,
    p_email: email,
    p_password: password,
    p_notes: notes,
  })
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: 'google_login_credential.set',
    entity_type: 'google_login_credential',
    entity_id: null,
    // Never log the password. Email + country only.
    details: { country_code: countryCode, email },
  })

  revalidatePath('/admin/google-login')
  return { status: 'ok', message: `Saved credential for ${countryCode} (${email}).` }
}

export type DeactivateState =
  | { status: 'ok' }
  | { status: 'error'; error: string }
  | null

/**
 * Reveal the decrypted password for a country's stored credential.
 * Open to any signed-in operator (broadened from admin-only on
 * 2026-05-29 so the QA team can self-serve Captcha-solver flows).
 * Every reveal is audit-logged below.
 */
export async function revealCredentialPasswordAction(
  countryCode: string,
): Promise<{ ok: true; email: string; password: string } | { ok: false; error: string }> {
  const auth = await requireSignedIn()
  if (!auth.ok) return { ok: false, error: auth.error }

  const code = countryCode.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) {
    return { ok: false, error: 'Country code must be a 2-letter ISO code.' }
  }

  // Must use the user-authenticated client (not service-role) — the RPC
  // re-checks auth.uid() / is_admin() internally, and a service-role
  // client has no JWT so auth.uid() returns null and the RPC raises
  // "not signed in".
  const supabase = await createServerClient()
  const { data, error } = await supabase.rpc('admin_reveal_google_login_credential', {
    p_country_code: code,
  })
  if (error) return { ok: false, error: error.message }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { email?: string | null; password?: string | null }
    | null
  if (!row || !row.password) {
    return { ok: false, error: 'No active credential found for this country.' }
  }

  await logActivity({
    action: 'google_login_credential.reveal',
    entity_type: 'google_login_credential',
    entity_id: null,
    details: { country_code: code },
  })

  return { ok: true, email: row.email ?? '', password: row.password }
}

export async function deactivateCredentialAction(
  _prev: DeactivateState,
  fd: FormData,
): Promise<DeactivateState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const countryCode = String(fd.get('country_code') ?? '').trim().toUpperCase()
  if (!countryCode || !/^[A-Z]{2}$/.test(countryCode)) {
    return { status: 'error', error: 'Missing or invalid country code.' }
  }

  const svc = createServiceClient()
  const { error } = await svc.rpc('deactivate_google_login_credential', {
    p_country_code: countryCode,
  })
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: 'google_login_credential.deactivate',
    entity_type: 'google_login_credential',
    entity_id: null,
    details: { country_code: countryCode },
  })

  revalidatePath('/admin/google-login')
  return { status: 'ok' }
}
