'use server'

import { revalidatePath } from 'next/cache'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { logActivity } from '@/lib/activity-log'

export type RecipientFormState =
  | { status: 'ok'; message: string }
  | { status: 'error'; error: string }
  | null

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

async function requireAdmin(): Promise<
  | { ok: true; user_id: string; user_email: string | null; display: string | null }
  | { ok: false; error: string }
> {
  const supabase = await createServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Not signed in.' }

  const svc = createServiceClient()
  const { data: adminFlag, error: adminErr } = await svc.rpc('is_admin', { p_user_id: user.id })
  if (adminErr) return { ok: false, error: adminErr.message }
  if (!adminFlag) return { ok: false, error: 'Admin access required.' }

  // Look up display name for `created_by` attribution.
  const { data: profileRow } = await svc
    .from('user_profiles')
    .select('username, display_name')
    .eq('id', user.id)
    .maybeSingle()
  const profile = profileRow as { username: string | null; display_name: string | null } | null
  const display = profile?.display_name ?? profile?.username ?? user.email ?? null

  return { ok: true, user_id: user.id, user_email: user.email ?? null, display }
}

export async function createRecipientAction(
  _prev: RecipientFormState,
  fd: FormData,
): Promise<RecipientFormState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const email = String(fd.get('email') ?? '').trim().toLowerCase()
  const name = String(fd.get('name') ?? '').trim() || null
  const countryCode = String(fd.get('country_code') ?? '').trim().toUpperCase() || null
  const notes = String(fd.get('notes') ?? '').trim() || null

  if (!email) return { status: 'error', error: 'Email is required.' }
  if (!EMAIL_RE.test(email)) return { status: 'error', error: 'That doesn\'t look like a valid email address.' }
  if (countryCode && !/^[A-Z]{2}$/.test(countryCode)) {
    return { status: 'error', error: 'Country code must be a 2-letter ISO code (e.g. DE).' }
  }

  const svc = createServiceClient()
  const { error } = await svc.from('lead_alert_recipients').insert({
    email,
    name,
    country_code: countryCode,
    notes,
    created_by: auth.display,
  })
  if (error) {
    if (error.code === '23505') {
      return { status: 'error', error: `${email} is already on the recipient list.` }
    }
    return { status: 'error', error: error.message }
  }

  await logActivity({
    action: 'alert_recipient.create',
    entity_type: 'lead_alert_recipient',
    entity_id: null,
    details: { email, country_code: countryCode },
  })

  revalidatePath('/admin/alerts')
  return { status: 'ok', message: `Added ${email}.` }
}

export type ToggleRecipientState =
  | { status: 'ok' }
  | { status: 'error'; error: string }
  | null

export async function setRecipientActiveAction(
  _prev: ToggleRecipientState,
  fd: FormData,
): Promise<ToggleRecipientState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const id = Number(fd.get('id'))
  if (!Number.isFinite(id)) return { status: 'error', error: 'Missing recipient id.' }

  const wantsActive = String(fd.get('value') ?? '').toLowerCase() === 'true'

  const svc = createServiceClient()
  const { error } = await svc
    .from('lead_alert_recipients')
    .update({ is_active: wantsActive })
    .eq('id', id)
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: wantsActive ? 'alert_recipient.activate' : 'alert_recipient.deactivate',
    entity_type: 'lead_alert_recipient',
    entity_id: id,
    details: {},
  })

  revalidatePath('/admin/alerts')
  return { status: 'ok' }
}

export async function deleteRecipientAction(
  _prev: ToggleRecipientState,
  fd: FormData,
): Promise<ToggleRecipientState> {
  const auth = await requireAdmin()
  if (!auth.ok) return { status: 'error', error: auth.error }

  const id = Number(fd.get('id'))
  if (!Number.isFinite(id)) return { status: 'error', error: 'Missing recipient id.' }

  const svc = createServiceClient()
  const { data: row } = await svc
    .from('lead_alert_recipients')
    .select('email')
    .eq('id', id)
    .maybeSingle()

  const { error } = await svc.from('lead_alert_recipients').delete().eq('id', id)
  if (error) return { status: 'error', error: error.message }

  await logActivity({
    action: 'alert_recipient.delete',
    entity_type: 'lead_alert_recipient',
    entity_id: id,
    details: { email: (row as { email?: string } | null)?.email ?? null },
  })

  revalidatePath('/admin/alerts')
  return { status: 'ok' }
}
