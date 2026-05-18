'use server'

import { revalidatePath } from 'next/cache'
import { createServiceClient } from '@/lib/supabase/service'
import { logActivity } from '@/lib/activity-log'
import { requireAdmin } from '@/lib/auth/require-admin'

// gologin_profile mutations write via the service-role client (bypasses
// RLS); without an admin gate any signed-in user could flip the
// "requires login" or "is logged in" flag and break the scrape worker.
// See BUGS.md #1.
async function assertAdmin(): Promise<void> {
  const check = await requireAdmin()
  if (!check.ok) throw new Error(check.error)
}

function normaliseCountry(raw: unknown): string {
  return String(raw ?? '').trim().toUpperCase()
}

export async function setRequiresGoogleLogin(formData: FormData): Promise<void> {
  await assertAdmin()
  const country = normaliseCountry(formData.get('country_code'))
  if (!country) throw new Error('Missing country code.')
  const value = formData.get('value') === 'true'

  const svc = createServiceClient()
  const { error } = await svc
    .from('gologin_profiles')
    .update({ requires_google_login: value, updated_at: new Date().toISOString() })
    .eq('country_code', country)
  if (error) throw new Error(error.message)

  await logActivity({
    action: 'profile.set_requires_login',
    entity_type: 'gologin_profile',
    entity_id: country,
    details: { value },
  })

  revalidatePath('/profiles')
  revalidatePath('/scrape', 'layout')
}

export async function setIsGoogleLoggedIn(formData: FormData): Promise<void> {
  await assertAdmin()
  const country = normaliseCountry(formData.get('country_code'))
  if (!country) throw new Error('Missing country code.')
  const value = formData.get('value') === 'true'
  const now = new Date().toISOString()

  const svc = createServiceClient()
  const { error } = await svc
    .from('gologin_profiles')
    .update({
      is_google_logged_in: value,
      google_login_verified_at: now,
      login_check_source: 'manual',
      updated_at: now,
    })
    .eq('country_code', country)
  if (error) throw new Error(error.message)

  await logActivity({
    action: 'profile.set_logged_in',
    entity_type: 'gologin_profile',
    entity_id: country,
    details: { value },
  })

  revalidatePath('/profiles')
  revalidatePath('/scrape', 'layout')
}

export async function setProfileNotes(formData: FormData): Promise<void> {
  await assertAdmin()
  const country = normaliseCountry(formData.get('country_code'))
  if (!country) throw new Error('Missing country code.')
  const notes = String(formData.get('notes') ?? '').trim()

  const svc = createServiceClient()
  const { error } = await svc
    .from('gologin_profiles')
    .update({
      google_login_notes: notes.length > 0 ? notes : null,
      updated_at: new Date().toISOString(),
    })
    .eq('country_code', country)
  if (error) throw new Error(error.message)

  await logActivity({
    action: 'profile.set_notes',
    entity_type: 'gologin_profile',
    entity_id: country,
    details: { has_notes: notes.length > 0 },
  })

  revalidatePath('/profiles')
}
